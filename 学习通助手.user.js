// ==UserScript==
// @name         AutoCX 学习通自动看课+LLM答题助手
// @namespace    autocx
// @version      1.0.8
// @description  学习通自动看课(视频/文档课件)+LLM辅助章节测验/作业/随堂练习答题,附「AI 作答记录」窗口:请求/思考/回答全程留痕。单文件,基于 Vue 3 + Ant Design Vue + ElementGetter + Ajax-hook。
// @author       autocx
// @license      MIT
// @homepage     https://github.com/lianjishu/autocx
// @supportURL   https://github.com/lianjishu/autocx/issues
// @icon         https://pan-yz.chaoxing.com/favicon.ico
// @match        *://*.chaoxing.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// @require      https://cdn.jsdelivr.net/gh/wendux/Ajax-hook@master/dist/ajaxhook.min.js
// @require      https://scriptcat.org/lib/513/2.1.0/ElementGetter.js
// @require      https://cdn.jsdelivr.net/npm/vue@3.5.22/dist/vue.global.prod.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/advancedFormat.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/customParseFormat.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/localeData.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/quarterOfYear.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/weekOfYear.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/weekYear.js
// @require      https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/weekday.js
// @require      data:application/javascript,window.Vue%3DVue%3Bwindow.dayjs%3Ddayjs%3B
// @require      https://cdn.jsdelivr.net/npm/ant-design-vue@4.2.6/dist/antd.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_log
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/* =============================================================================
 * AutoCX 学习通助手
 * 设计文档: docs/superpowers/specs/2026-11-18-chaoxing-auto-course-design.md
 *
 * 结构:
 *   SELECTORS   - 关键选择器常量区(页面改版只改这里)
 *   config      - GM 配置读写 + 默认值
 *   log         - 日志总线(帧内 console + 跨帧上报)
 *   roles       - iframe 角色识别
 *   bootstrap   - 入口:识别角色 -> 加载对应模块
 * ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * 自带的 Vue3 / AntD 必须在页面脚本覆盖 window 之前抓住。
   * 随堂练习页(mobilelearn)自带 Vue2,会把 window.Vue 换掉;
   * 若运行时才去读 window.Vue,拿到的是页面的 Vue2,面板就挂不上。
   * @require 的 vue.global.prod.js / antd.min.js 在本 IIFE 之前求值,
   * 故此处直接取引用,后续不再依赖 window.Vue。
   * ------------------------------------------------------------------- */
  const VUE3 = (typeof Vue !== 'undefined' && Vue && typeof Vue.createApp === 'function') ? Vue : null;
  const ANTD = (typeof antd !== 'undefined' && antd && antd.ConfigProvider) ? antd : null;

  /* ============================== SELECTORS ============================== */
  // 页面结构变化时,优先在这里调整选择器
  const SELECTORS = {
    // 视频任务点
    video: {
      player: 'video',
      popupQuiz: '.xTiTle',                 // 视频中弹题标题
      popupOption: '.tkList li, .xAnswer li', // 弹题选项(随机选一个即可)
      popupSubmit: '.btn-submit, .xBtn',    // 弹题提交按钮
      riskVerify: '#riskverify, .riskverify, .yidun', // 风控验证容器(滑块等)
      jobDone: '.ans-job-finished',         // 任务点完成标记
    },
    // 文档任务点
    doc: {
      nextPage: '.imglook_next, .next, .page-next', // PPT/PDF 下一页
      jobDone: '.ans-job-finished',
    },
    // 章节测验
    quiz: {
      question: '.TiMu, .questionLi, .question-item, .question-wrapper', // 单题容器
      // 题干:本版(2026)是 .Zy_TItle > .font-cxsecret.fontLabel;老版是 .mark_name 等
      title: '.Zy_TItle .fontLabel, .mark_name, .qyh-tit, .topic-title, .question-title, .fontLabel',
      // 选项:本版是 ul.Zy_ulTop > li[qid];老版是 .answerBg/.num_option
      option: 'ul.Zy_ulTop > li[qid], ul.Zy_ulTop > li[qtype], .answerBg, .choose-item',
      optionList: 'ul li, .answerBg, .num_option, .choose-item',          // 选项(兼容旧版)
      optionLetter: 'span.num_option, span.num_option_dx',                // 选项字母所在元素
      optionText: 'a.after, a',                                           // 选项文本
      typeMark: '.newZy_TItle',                                           // 【Single Choice】题型标记
      cipher: '[class*="cxsecret"], [style*="cxsecret"]',                  // 字体混淆节点
      blankInput: 'input[type=text], textarea',                           // 填空输入
      submit: '.btnSubmit, .btn-submit, .submitBtn, a[onclick*="btnBlueSubmit"], a[onclick*="submit"]', // 答卷页提交按钮
      // 确认弹窗:本版是 #submitBack(AlertCon02) 里的 .bluebtn;老版是 .popBottom a.jb_btn
      submitConfirm: '#submitBack a, #submitBack button, .AlertCon02 a.bluebtn, .popBottom a.jb_btn, a.jb_btn, a.bluebtn',
      save: 'a.btnSave, .btnSave',                   // 保存草稿(noSubmit())
      captchaWin: '#verifyCodeWin',                  // 验证码弹窗(出现则转人工)
    },
    // 随堂练习(mobilelearn 的 Vue 应用 answerQuestion2)
    practice: {
      root: '#main.respond-container',              // Vue 挂载点(__vue__ 挂在这里)
      question: '.left-question-list .question-item', // 单题容器(与 vm.questionList 同序)
      title: '.question-name',                       // 题干容器(含题型标记)
      typeMark: '.question-name .grey-text',         // 【Monoselect】等题型标记
      stem: '.question-name .html-content-box',      // 题干正文
      option: '.option-list > li',                   // 选项
      optionLetter: '.option-letter',                // 选项字母
      optionText: '.option-result',                  // 选项正文
      blankInput: '.option-fill-list input.ofl-ipt', // 填空输入框
      shortInput: '.short-answer-textarea textarea', // 主观题输入框
      submit: '.submit-btn',                         // 提交按钮
      submitConfirm: '.popBottom a.jb_btn.dialog_affrim, a.jb_btn.dialog_affirm', // 确认弹窗按钮
    },
    // 顶层章节页
    top: {
      jobUnit: '.posCatalog_select',        // 章节列表项
      nextJob: '.jb_btn',                   // "下一个任务点"按钮(在 knowledge 帧)
    },
  };

  /* ============================== 配置 ===================================== */
  // 作者仓库:元数据 @homepage 只能写一个(ScriptCat 取第一个命中的 key,重复行会触发校验错误),
  // 所以镜像地址放在页面 UI 里。链接一律新标签打开,不带任何跟踪参数。
  const REPO = {
    github: 'https://github.com/lianjishu/autocx',
    gitee: 'https://gitee.com/yake2024/autocx',
    issues: 'https://github.com/lianjishu/autocx/issues',
  };
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.0.0';

  const DEFAULTS = {
    'autocx.enabled': true, // 总开关(面板启停)
    'assist.video': true,   // 看课助手(视频/文档任务点)
    'assist.quiz': true,    // 答题助手(章节测验)
    'llm.base_url': 'https://api.deepseek.com/v1',
    'llm.api_key': '',
    'llm.model': 'deepseek-chat',
    'llm.effort': 'low',   // 思考强度: ''(不发送)/low/medium/high;推理模型建议 low 提速
    'llm.timeout': 180,    // 响应停滞超时(秒):N 秒完全无数据才判负;网关排队/缓冲/慢思考都覆盖
    'llm.stream': true,    // 流式接收(思考/回答逐字进记录窗口);关掉=等整包返回再一次性展示
    'video.speed': 2,
    'video.mute': true,
    'quiz.auto_fill': true,
    'quiz.auto_submit': false, // 自动提交(仅全部答完才生效,默认关闭)
    'quiz.auto_submit_work': false, // 作业(work)单独开关:作业常只能交一次,默认只填不交
    'quiz.auto_submit_practice': false, // 随堂练习单独开关:平台本身会在截止时自动交,默认只填不交
    'quiz.double_check': true, // 两答一致性校验:解码置信足够时只对多选题/填空/低置信题复核
    // ---- 字体反混淆(超星 font-cxsecret) ----
    'font.decode': true,       // 关掉则退回老行为(直接把密文丢给模型)
    'font.refdb_url': '',      // 参考字形库地址(@require 已提供时留空;支持 http/https)
    'font.min_score': 0.55,    // 单字 IoU 下限
    'font.min_margin': 0.06,   // 与第二名的差距下限
    'font.page_min_conf': 0.8, // 整题解码率低于此值 -> 不送模型,标"需人工"
    'llm.vision': true,        // 解码有未定字时,用同一模型读字形格子图兜底
    'doc.interval': 2,      // 翻页间隔基数(秒)
    'debug': false,
  };

  const config = {
    get(key) {
      const v = GM_getValue(key);
      return v === undefined ? DEFAULTS[key] : v;
    },
    set(key, value) {
      GM_setValue(key, value);
    },
  };

  /* ============================== 日志总线 ================================= */
  // 帧内输出 console;带 level 的日志同时写入 GM 状态,供顶层面板聚合显示
  const LOG_KEY = 'autocx.log';
  const log = {
    _emit(level, module, msg) {
      const line = `[AutoCX][${module}] ${msg}`;
      if (level === 'debug' && !config.get('debug')) return;
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
      try { GM_log(line, level === 'debug' ? 'info' : level); } catch (_) { /* GM_log 不可用时忽略 */ }
      if (level !== 'debug') {
        GM_setValue(LOG_KEY, {
          ts: Date.now(), level, module, msg,
          frame: location.hostname + location.pathname.slice(0, 60),
        });
      }
    },
    debug: (m, s) => log._emit('debug', m, s),
    info: (m, s) => log._emit('info', m, s),
    warn: (m, s) => log._emit('warn', m, s),
    error: (m, s) => log._emit('error', m, s),
  };

  /* ============================== 角色识别 ================================= */
  // 学习通课程任务页是多层嵌套 iframe;每个帧按 URL 特征识别自己的角色。
  // 返回: 'top' | 'video' | 'audio' | 'doc' | 'book' | 'quiz' | 'practice' | null
  function detectRole() {
    const { hostname, pathname, href } = location;
    const path = pathname.toLowerCase();

    // 任务点 iframe: ananas 模块(收紧到播放器主页,排除 subtitle-bridge 等辅助页)
    if (/\/ananas\/modules\/video\/index\.html/.test(path)) return 'video';
    if (/\/ananas\/modules\/audio\/index\.html/.test(path)) return 'audio';
    if (/\/ananas\/modules\/(pdf|ppt|pptdemo)\//.test(path)) return 'doc';
    if (/\/ananas\/modules\/(innertemplet|book|read)\//.test(path)) return 'book';

    // 随堂练习/课堂测验(mobilelearn 的 Vue 应用):
    //   /page/quiz/stu/answerQuestion2  -> 作答页(本脚本要答的就是它)
    //   /page/quiz/stu/quizStudentQuestion -> 成绩/批阅回看页,绝不作答
    if (/\/page\/quiz\/stu\/answerquestion2/i.test(path)) return 'practice';

    // 章节测验/作业答卷页
    // 排除批阅/查看页(提交后跳转的 selectWorkQuestionYiPiYue 等):只读或复答草稿,
    // 绝不能在上面提取/答题/点击
    const REVIEW_URL = /YiPiYue|selectWorkQuestion|workView|reviewWork|viewWork/i;
    if (!REVIEW_URL.test(href) &&
        (/\/(mooc2?-ans\/)?(work|exam)\//.test(path) || /dowork|studentwork/.test(href) ||
        /\/mooc-ans\/api\/work/.test(path))) return 'quiz';

    // 顶层帧: 本人窗口 且 是课程学习相关页
    if (window.top === window.self) {
      if (/mycourse|studentstudy|courseIndex|studentcourse/.test(href)) return 'top';
      return null; // 学习通其他页面不激活
    }

    // knowledge 中间帧(任务点容器),后续视频/文档完成检测与"下一个"推进用
    if (/studentstudy|knowledge/.test(href)) return 'knowledge';

    return null;
  }

  /* ============================== 状态上报 ================================= */
  // 各任务帧把状态写入 GM,顶层面板监听聚合
  const STATUS_KEY = 'autocx.status';
  function report(module, state, detail) {
    GM_setValue(STATUS_KEY, {
      ts: Date.now(), module, state, detail: detail || '',
      frame: location.hostname + location.pathname.slice(0, 60),
      href: location.href, // 顶层据此过滤"别的章节/别的标签页"的任务帧事件
    });
  }

  /* ============================== 作答记录总线 ============================= */
  /** HTML 转义:模型输出是不可信数据,一律转义后再进 DOM */
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  // quiz 帧跑模型、顶层帧画窗口:用 GM 存储当通道,不手写 postMessage 协议。
  // 本帧写入直接派发给本帧订阅者;跨帧写入靠 GM_addValueChangeListener(remote=true)。
  const AI_INDEX = 'autocx.ai.index';
  const AI_KEEP = 3;                       // 最多保留几份会话(按最近使用 LRU)
  const AI_PING = 'autocx.ai.ping';         // 面板页签用的轻量摘要(不重复传题目文本)
  const AI_S = (sid) => 'autocx.ai.s.' + sid;
  const AI_C = (sid, n) => 'autocx.ai.c.' + sid + '.' + n;

  const aibus = {
    _subs: new Map(),
    _subscribe(key, fn) {
      if (!this._subs.has(key)) this._subs.set(key, []);
      this._subs.get(key).push(fn);
      return () => {
        const list = this._subs.get(key) || [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) this._subs.delete(key);
      };
    },
    /** 订阅一个键:本帧写入与跨帧写入都会回调 */
    on(key, fn) {
      const off = this._subscribe(key, fn);
      const id = GM_addValueChangeListener(key, (_k, _o, nv, remote) => {
        if (remote) { try { fn(nv); } catch (_) { /* 渲染异常不能影响数据流 */ } }
      });
      return () => {
        off();
        try { GM_removeValueChangeListener(id); } catch (_) { /* 监听器已失效 */ }
      };
    },
    /** 落盘 + 通知本帧订阅者 */
    put(key, value) {
      try { GM_setValue(key, value); } catch (e) { log.warn('ai', '记录写入失败: ' + e.message); }
      const list = this._subs.get(key);
      if (list) list.slice().forEach((fn) => { try { fn(value); } catch (_) { /* 同上 */ } });
    },
    /** 会话索引:新的排最前,超出上限的老会话连同题目键一起删掉 */
    touchIndex(meta) {
      let idx = [];
      try { idx = GM_getValue(AI_INDEX) || []; } catch (_) { idx = []; }
      if (!Array.isArray(idx)) idx = [];
      const item = {
        sid: meta.sid, title: meta.title || '', count: meta.count || 0,
        ts: meta.startAt || Date.now(),
      };
      const rest = idx.filter((it) => it && it.sid !== item.sid);
      rest.unshift(item);
      this.put(AI_INDEX, rest.slice(0, AI_KEEP));
      rest.slice(AI_KEEP).forEach((it) => { try { this.drop(it.sid, it.count); } catch (_) { /* 忽略 */ } });
    },
    drop(sid, count) {
      try { GM_deleteValue(AI_S(sid)); } catch (_) { /* 忽略 */ }
      const n = Math.max(1, Math.min(50, Number(count) || 20));
      for (let i = 1; i <= n; i++) { try { GM_deleteValue(AI_C(sid, i)); } catch (_) { /* 忽略 */ } }
    },
  };

  /** 内部题对象 -> 可写进 GM 的纯数据(去掉 DOM 引用,文本截断防膨胀) */
  function convSnapshot(c) {
    return {
      n: c.index,
      type: c.type || '',
      stem: String(c.stem || '').slice(0, 800),
      options: (c.options || []).slice(0, 12).map((op) => ({
        label: String(op.label || ''), text: String(op.text || '').slice(0, 300),
      })),
      source: c.source || '',
      phase: c.phase || 'queued',
      prompt: String(c.prompt || '').slice(0, 4000),
      params: c.params || null,
      thinking: String(c.thinking || '').slice(-12000),
      answer: String(c.answer || '').slice(-4000),
      streamed: c.streamed !== false,
      result: c.result || null,
      usage: c.usage || null,
      error: c.error || null,
      attempt: c.attempt || 1,
      decode: c.decode || null,     // {conf, mapped, total, unknown, chars}
      grade: c.grade || '',         // A/B/C
      t: c.t || null,
    };
  }

  /** 单题写盘节流:流式增量每 300ms 最多一次,相位变化走 immediate */
  function makeConvWriter(sid, index) {
    const key = AI_C(sid, index);
    let timer = null;
    let pending = null;
    let lastAt = 0;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!pending) return;
      lastAt = Date.now();
      aibus.put(key, pending);
      pending = null;
    };
    return {
      write(snap, immediate) {
        pending = snap;
        const now = Date.now();
        if (immediate || now - lastAt >= 300) { flush(); return; }
        if (!timer) timer = setTimeout(flush, 300 - (now - lastAt));
      },
      flush,
    };
  }

  /**
   * 开启一次"AI 作答记录"会话(章节测验 / 随堂练习共用)。
   * 返回 { sid, aiMeta, metaWrite, convs, writer }:
   *   - convs[i]  第 i 题的记录对象(流式写入 AI_C)
   *   - writer(i) 第 i 题的节流写入器
   *   - metaWrite 把会话元信息刷到 AI_S + AI_PING(顶层面板据此显示进度)
   */
  function startAiSession(opts) {
    const sid = opts.sid;
    const aiMeta = {
      sid,
      workKey: opts.workKey || sid,
      title: String(opts.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      count: opts.questions.length,
      source: opts.source || '',
      concurrency: opts.concurrency || 2,
      model: config.get('llm.model'),
      effort: String(config.get('llm.effort') || ''),
      host: String(config.get('llm.base_url') || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      keyTail: String(config.get('llm.api_key') || '').slice(-4),
      startAt: Date.now(),
      answeredAt: 0,
      answered: 0,
      failed: 0,
      submitState: opts.submitState || 'off',
      submitDetail: '',
      events: [],
    };
    aibus.touchIndex(aiMeta);
    const metaWrite = () => {
      const snap = Object.assign({}, aiMeta, { events: aiMeta.events.slice(-20) });
      aibus.put(AI_S(sid), snap);
      aibus.put(AI_PING, {
        sid, title: snap.title, count: snap.count, answered: snap.answered,
        failed: snap.failed, submitState: snap.submitState, model: snap.model,
        source: snap.source, ts: Date.now(),
      });
    };
    metaWrite();

    const convs = opts.questions.map((q) => {
      const c = {
        index: q.index, type: q.type, stem: q.stem, options: q.options || [],
        source: aiMeta.source, phase: 'queued', prompt: '', params: null,
        thinking: '', answer: '', streamed: true, result: null, usage: null,
        error: null, attempt: 0, t: { queuedAt: Date.now() },
        decode: q.decode || null, grade: q.grade || '',
      };
      aibus.put(AI_C(sid, q.index), convSnapshot(c));
      return c;
    });
    const writers = new Map();
    const writer = (index) => {
      if (!writers.has(index)) writers.set(index, makeConvWriter(sid, index));
      return writers.get(index);
    };
    return { sid, aiMeta, metaWrite, convs, writer };
  }

  /* ============================== 总开关 =================================== */
  function isEnabled() {    return config.get('autocx.enabled') !== false;
  }

  /* ============================== SSE 增量解析 ============================= */
  // 把 SSE 文本切成事件,拆出 思考(reasoning_content)/回答(content)/usage。
  // 刻意保持纯函数(不碰 DOM、不碰 GM):test/sse-parse.test.js 会抽取它做回归。
  function makeSseParser(handlers) {
    const h = handlers || {};
    let buf = '';
    let doneSeen = false;
    const emit = (fn, arg) => { if (typeof fn === 'function') fn(arg); };

    function handleLine(raw) {
      const line = String(raw == null ? '' : raw).replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') return;        // 空行 / ": keep-alive" 心跳
      if (line.slice(0, 5) !== 'data:') return;           // event: / id: / retry: 一律忽略
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') { doneSeen = true; emit(h.done); return; }
      let json;
      try { json = JSON.parse(payload); } catch (_) { return; }  // 非 JSON 心跳 / 半行
      if (!json || typeof json !== 'object') return;
      if (json.usage) emit(h.usage, json.usage);
      if (json.error) emit(h.error, json.error);
      const choice = json.choices && json.choices[0];
      if (!choice) return;
      const d = choice.delta || {};
      const thinkDelta = d.reasoning_content || d.reasoning;
      if (thinkDelta) emit(h.thinking, thinkDelta);
      if (d.content) emit(h.answer, d.content);
      const m = choice.message;                                   // 网关把整包塞进一条 SSE
      if (m) {
        const mThink = m.reasoning_content || m.reasoning;
        if (mThink) emit(h.thinking, mThink);
        if (m.content) emit(h.answer, m.content);
      }
      if (choice.finish_reason) emit(h.finish, choice.finish_reason);
    }

    return {
      /** 喂一段新到达的文本(允许半个事件) */
      feed(chunk) {
        if (!chunk) return;
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      },
      /** 流结束:冲刷残留末行 */
      end() {
        if (buf.trim()) handleLine(buf);
        buf = '';
      },
      get doneSeen() { return doneSeen; },
    };
  }

  /* ============================== 流式对话 ================================= */
  // 与 llm.chat 的区别:边收边解析,思考与回答分别回调。
  // 拿不到增量(网关忽略 stream / 传输层不吐半包)时自动降级为整包解析,st.streamed=false。
  // 永不 throw:失败走 promise reject,句柄支持 abort。
  function openChatStream(prompt, opts) {
    const o = opts || {};
    const st = {
      thinking: '', answer: '', usage: null, finish: '',
      streamed: false, incremental: false, chunks: 0, bytes: 0, aborted: false,
      tStart: Date.now(), tFirstByte: 0, tFirstThink: 0, tFirstAnswer: 0, tDone: 0,
    };
    const phase = (name, info) => { try { if (o.onPhase) o.onPhase(name, info || st); } catch (_) {} };
    let handle = null;
    let settled = false;
    let settleFn = null;
    let lastActivity = Date.now();
    let idleTimer = null;

    const promise = new Promise((resolve, reject) => {
      settleFn = (kind, payload) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearInterval(idleTimer);
        settleFn = null;
        if (kind === 'reject') reject(payload); else resolve(payload);
      };
      const fail = (e) => {
        phase('error', { message: (e && e.message) || String(e) });
        if (settleFn) settleFn('reject', e);
      };
      const ok = () => {
        st.tDone = Date.now();
        phase('done', st);
        if (settleFn) settleFn('ok', st);
      };

      const base = String(config.get('llm.base_url')).replace(/\/+$/, '');
      const apiKey = config.get('llm.api_key');
      const model = config.get('llm.model');
      const effort = String(config.get('llm.effort') || '').trim();
      const idleMs = o.idleTimeout || (Math.max(15, Number(config.get('llm.timeout')) || 60) * 1000);
      if (!apiKey) return fail(new Error('未配置 llm.api_key'));

      // 停滞看门狗:任何字节到达都算活跃,思考再久也不算失败
      idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > idleMs) {
          fail(new Error(`响应停滞(>${Math.round(idleMs / 1000)}s 无数据)`));
        }
      }, 5000);

      const handlers = {
        thinking(t) {
          if (!st.tFirstThink) { st.tFirstThink = Date.now(); phase('thinking'); }
          st.thinking += t;
          st.chunks++;
          try { if (o.onThinking) o.onThinking(t, st); } catch (_) { /* 回调异常不影响流 */ }
        },
        answer(t) {
          if (!st.tFirstAnswer) { st.tFirstAnswer = Date.now(); phase('answering'); }
          st.answer += t;
          st.chunks++;
          try { if (o.onAnswer) o.onAnswer(t, st); } catch (_) { /* 同上 */ }
        },
        usage(u) { st.usage = u; },
        finish(f) { st.finish = f; },
        done() { /* [DONE] 只是结束标记 */ },
      };

      let consumed = 0;
      let parser = makeSseParser(handlers);

      const send = (withEffort) => {
        const body = {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          stream: true,
        };
        if (withEffort && effort) body.reasoning_effort = effort;
        consumed = 0;
        parser = makeSseParser(handlers);
        lastActivity = Date.now();
        phase('requesting', { model, effort: withEffort ? effort : '', stream: true });
        try {
          handle = GM_xmlhttpRequest({
            method: 'POST',
            url: base + '/chat/completions',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + apiKey,
              'Accept': 'text/event-stream',
            },
            data: JSON.stringify(body),
            timeout: 15 * 60 * 1000, // 硬顶防死挂;思考再久也等
            onreadystatechange(res) {
              if (!res || res.readyState < 3) return;
              lastActivity = Date.now();
              const txt = res.responseText;
              if (typeof txt !== 'string' || txt.length <= consumed) return;
              if (!st.tFirstByte) st.tFirstByte = Date.now();
              if (!st.incremental) { st.incremental = true; st.streamed = true; phase('stream'); }
              st.bytes = txt.length;
              parser.feed(txt.slice(consumed));
              consumed = txt.length;
            },
            onload(res) {
              lastActivity = Date.now();
              try {
                const txt = typeof res.responseText === 'string' ? res.responseText : '';
                // 网关/模型不认 reasoning_effort:去掉参数重试一次
                if (res.status === 400 && withEffort && effort &&
                    /reasoning|effort|unknown|invalid/i.test(txt)) {
                  phase('retry', { reason: '网关不支持 reasoning_effort,已改用默认参数' });
                  return send(false);
                }
                if (res.status < 200 || res.status >= 300) {
                  return fail(new Error(`HTTP ${res.status}: ${String(txt).slice(0, 200)}`));
                }
                if (txt.length > consumed) { parser.feed(txt.slice(consumed)); consumed = txt.length; }
                parser.end();
                // 1) 增量一个事件都没拿到 -> 整包按 SSE 再解一遍(网关忽略 stream 的情形)
                if (!st.thinking && !st.answer) {
                  st.streamed = false;
                  const p2 = makeSseParser(handlers);
                  p2.feed(txt);
                  p2.end();
                }
                // 2) 连 SSE 都不是 -> 普通 JSON 兜底
                if (!st.thinking && !st.answer) {
                  const data = JSON.parse(txt);
                  if (data && data.usage) st.usage = data.usage;
                  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
                  if (msg) {
                    const mThink = msg.reasoning_content || msg.reasoning;
                    if (mThink) handlers.thinking(mThink);
                    if (msg.content) handlers.answer(msg.content);
                  }
                }
                if (!st.thinking && !st.answer) return fail(new Error('响应中无可用内容'));
                ok();
              } catch (e) { fail(e); }
            },
            onerror(e) { fail(new Error('网络错误: ' + ((e && e.error) || 'unknown'))); },
            ontimeout() { fail(new Error('请求总时长超 15 分钟,已中止')); },
            onabort() { fail(new Error('已中止')); },
          });
        } catch (e) { fail(e); }
      };

      send(true);
    });

    return {
      promise,
      abort() {
        st.aborted = true;
        try { if (handle && handle.abort) handle.abort(); } catch (_) { /* 句柄已失效 */ }
        if (settleFn) settleFn('reject', new Error('已中止'));
      },
    };
  }

  /* ============================== LLM 模块 ================================= */
  // OpenAI 兼容客户端;GM_xmlhttpRequest 自带跨域。
  // 采用 SSE 流式接收:模型每吐 token 都算活跃(推理模型的思考 token 同样流动),
  // 只在"停滞超时"内完全无数据才判负——思考再久也不算失败;HTTP 错误码立即判负。
  const llm = {
    /**
     * 发送单轮对话(流式),返回文本内容
     * @param {string} prompt
     * @param {{idleTimeout?: number}} [opts] 停滞超时(毫秒),默认读配置 llm.timeout(秒)
     * @returns {Promise<string>}
     */
    chat(prompt, opts) {
      const base = String(config.get('llm.base_url')).replace(/\/+$/, '');
      const key = config.get('llm.api_key');
      const model = config.get('llm.model');
      if (!key) return Promise.reject(new Error('未配置 llm.api_key'));
      const effort = String(config.get('llm.effort') || '').trim();
      const idleMs = (opts && opts.idleTimeout) || (Math.max(15, Number(config.get('llm.timeout')) || 60) * 1000);

      const send = (withEffort) => new Promise((resolve, reject) => {
        const body = {
          model,
          messages: [{
            role: 'user',
            // opts.image 存在时走多模态:content 从字符串换成 [文本, 图片] 数组
            content: (opts && opts.image)
              ? [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: opts.image } },
              ]
              : prompt,
          }],
          temperature: 0.1,
          stream: true,
        };
        if (withEffort && effort) body.reasoning_effort = effort;

        let settled = false;
        let lastActivity = Date.now();
        const done = (fn, val) => {
          if (settled) return;
          settled = true;
          clearInterval(idleWatch);
          fn(val);
        };
        // 停滞看门狗:idleMs 内完全无数据到达才判负
        const idleWatch = setInterval(() => {
          if (Date.now() - lastActivity > idleMs) {
            done(reject, new Error(`响应停滞(>${Math.round(idleMs / 1000)}s 无数据)`));
          }
        }, 5000);

        GM_xmlhttpRequest({
          method: 'POST',
          url: base + '/chat/completions',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + key,
            'Accept': 'text/event-stream',
          },
          data: JSON.stringify(body),
          timeout: 15 * 60 * 1000, // 硬顶 15 分钟防死挂,思考再久也等
          onreadystatechange(res) {
            if (res.readyState >= 3 && res.responseText != null) lastActivity = Date.now();
          },
          onload(res) {
            try {
              // 网关/模型不认 reasoning_effort:降级为不带参重试一次
              if (res.status === 400 && withEffort && effort &&
                  /reasoning|effort|unknown|invalid/i.test(res.responseText || '')) {
                return send(false).then((v) => done(resolve, v), (e) => done(reject, e));
              }
              // 带图请求被拒:直接判负并说明"网关不支持图片",不要静默降级成纯文本
              if (res.status === 400 && opts && opts.image) {
                return done(reject, new Error('网关不支持图片输入: ' + (res.responseText || '').slice(0, 120)));
              }
              if (res.status < 200 || res.status >= 300) {
                return done(reject, new Error(`HTTP ${res.status}: ${(res.responseText || '').slice(0, 200)}`));
              }
              const raw = res.responseText || '';
              // 1) SSE 流解析:拼接所有 delta.content
              let text = '';
              if (/^data:/m.test(raw)) {
                for (const line of raw.split('\n')) {
                  const t = line.trim();
                  if (!t.startsWith('data:') || t === 'data: [DONE]') continue;
                  try {
                    const j = JSON.parse(t.slice(5).trim());
                    const d = j.choices && j.choices[0] && j.choices[0].delta;
                    if (d && d.content) text += d.content;
                  } catch (_) { /* 半行/心跳行,忽略 */ }
                }
              }
              // 2) 非流式 JSON 兜底(网关忽略 stream 参数时)
              if (!text) {
                const data = JSON.parse(raw);
                text = data && data.choices && data.choices[0] && data.choices[0].message
                  ? (data.choices[0].message.content || '') : '';
              }
              if (!text.trim()) return done(reject, new Error('响应中无可用内容'));
              done(resolve, text.trim());
            } catch (e) {
              done(reject, e);
            }
          },
          onerror: (e) => done(reject, new Error('网络错误: ' + (e && e.error || 'unknown'))),
          ontimeout: () => done(reject, new Error('请求总时长超 15 分钟,已中止')),
        });
      });
      return send(true);
    },
    /**
     * 流式对话(作答记录窗口用)。返回 {promise, abort()}。
     * promise 解析为 {thinking, answer, usage, streamed, chunks, tStart, tDone};失败 reject。
     * @param {string} prompt
     * @param {{onPhase?:function,onThinking?:function,onAnswer?:function,idleTimeout?:number}} [opts]
     */
    stream(prompt, opts) {
      // llm.stream=false:复用非流式的 chat(),一次性给出完整文本(并诚实标记 streamed:false)
      if (config.get('llm.stream') === false) {
        const o = opts || {};
        const st = { thinking: '', answer: '', usage: null, streamed: false, chunks: 0, tStart: Date.now(), tDone: 0 };
        try { if (o.onPhase) o.onPhase('requesting', st); } catch (_) { /* 回调异常不影响主流程 */ }
        const promise = this.chat(prompt, o).then((text) => {
          st.answer = text;
          st.tDone = Date.now();
          try { if (o.onAnswer) o.onAnswer(text, st); } catch (_) { /* 同上 */ }
          try { if (o.onPhase) o.onPhase('done', st); } catch (_) { /* 同上 */ }
          return st;
        });
        return { promise, abort() {} };
      }
      return openChatStream(prompt, opts);
    },
    /** 面板"测试连接"按钮用;顺带报告这次是真流式还是整包返回 */
    test() {
      const t0 = Date.now();
      return this.stream('请只回复两个字:正常', {}).promise.then((st) => {
        const ms = (st.tDone || Date.now()) - t0;
        const mode = st.streamed ? `流式 ✓ ${st.chunks} 片` : '非流式(整包返回)';
        const reply = String(st.answer || st.thinking || '').replace(/\s+/g, ' ').slice(0, 40);
        return `连接成功 · ${mode} · ${(ms / 1000).toFixed(1)}s · 回复: ${reply}`;
      });
    },
    /** 多模态:同一模型、同一密钥，只是 content 换成 [文本, 图片] */
    vision(prompt, dataUrl, opts) {
      return this.chat(prompt, Object.assign({ image: dataUrl }, opts || {}));
    },
  };

  /* ---------------------- 字形格子图(视觉兜底用) ---------------------- */
  // 把一串密文字渲染成"每格一个字的表格图"，让多模态模型按序号读出来。
  // 只画字，不截题目 —— 输入完全可控，也便于和位图结果交叉校验。
  function renderGlyphGrid(chars, family, opts) {
    const o = opts || {};
    const COLS = o.cols || 8;
    const CELL = o.cell || 96;
    const LABEL = 18;
    const PAD = 6;
    const rows = Math.max(1, Math.ceil(chars.length / COLS));
    const cv = document.createElement('canvas');
    cv.width = COLS * CELL;
    cv.height = rows * (CELL + LABEL);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let i = 0; i < chars.length; i++) {
      const cx = (i % COLS) * CELL;
      const cy = Math.floor(i / COLS) * (CELL + LABEL);
      ctx.fillStyle = '#9aa5b6';
      ctx.font = '12px sans-serif';
      ctx.fillText(String(i + 1), cx + PAD, cy + 3);
      ctx.fillStyle = '#000';
      ctx.font = Math.round(CELL * 0.68) + 'px ' + (family ? '"' + family + '"' : 'sans-serif');
      ctx.fillText(chars[i], cx + PAD, cy + LABEL);
    }
    return cv.toDataURL('image/png');
  }

  /** 面板"多模态自检":发 3 个字的格子图，看网关是否真的吃图片 */
  function visionSelfCheck() {
    const want = ['艺', '术', '风'];
    const png = renderGlyphGrid(want, '');
    const prompt = `这是一张包含 ${want.length} 个汉字的图，每格左上角是序号。请按序号逐行只输出你看到的汉字，不要任何解释。`;
    return llm.vision(prompt, png).then((txt) => {
      const got = [...String(txt)].filter((c) => /[\u3400-\u9fff]/.test(c)).join('');
      const hit = [...want].filter((c) => got.indexOf(c) >= 0).length;
      if (hit === want.length) return `多模态可用 ✓ · 模型回出「${got.slice(0, 6)}」`;
      if (!got) throw new Error('模型没有回汉字，可能不支持图片');
      return `多模态部分可用 ⚠ · 期望「${want.join('')}」，回出「${got.slice(0, 6)}」`;
    });
  }

/* ============================== AI 作答记录窗口(Vue) =========================== */
  // 只读窗口:脚本请求 → 模型思考 → 模型回答 → 解析/勾选/校验 → 提交轨迹。
  // 顶层帧挂载;若某帧自己就是顶层(单独打开答卷页),也在本帧挂载。
  // 模型输出是不可信数据:Vue 模板默认转义文本,不使用 v-html。
  const AIW = {
    api: null,
    ensure() {
      if (!this.api) this.api = createAIWindow();
      return this.api;
    },
  };

  const AI_CSS = `
    #autocx-ai-vue-root{position:fixed;inset:0;z-index:2147483647;pointer-events:none;
      font:13px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#1E2A2F}
    #autocx-ai-vue-root *{box-sizing:border-box}
    #autocx-ai-vue-root .acx-ai{position:absolute;inset:0;background:rgba(24,32,34,.38);display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
    #autocx-ai-vue-root .acx-ai-win{position:fixed;width:980px;max-width:calc(100vw - 48px);height:640px;max-height:calc(100vh - 48px);
      background:#FAFAF5;border:1px solid rgba(30,42,47,.3);box-shadow:0 30px 70px rgba(20,28,30,.4);display:flex;flex-direction:column}
    #autocx-ai-vue-root .acx-ai-top{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:2px solid #1E2A2F;cursor:grab;user-select:none}
    #autocx-ai-vue-root .acx-ai-top:active{cursor:grabbing}
    #autocx-ai-vue-root .acx-ai-seal{width:34px;height:34px;background:#C2453A;color:#FFF9F0;display:flex;align-items:center;justify-content:center;
      font:700 12px/1 Georgia,"Songti SC",serif;transform:rotate(-2deg);box-shadow:inset 0 0 0 2px rgba(255,255,255,.22);flex:none}
    #autocx-ai-vue-root .acx-ai-title{line-height:1.1}
    #autocx-ai-vue-root .acx-ai-title b{display:block;font:600 19px/1.1 Georgia,"Songti SC",serif}
    #autocx-ai-vue-root .acx-ai-title span{display:block;font-size:10px;color:#7C8688;margin-top:3px;letter-spacing:.1em;max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #autocx-ai-vue-root .acx-ai-meta{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:10px;color:#7C8688}
    #autocx-ai-vue-root .acx-ai-meta .acx-pill{border:1px solid rgba(30,42,47,.18);padding:3px 7px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
    #autocx-ai-vue-root .acx-ai-close{border:0;background:transparent;font-size:22px;line-height:1;color:#7C8688;cursor:pointer;padding:0 2px}
    #autocx-ai-vue-root .acx-ai-close:hover{color:#C2453A}
    #autocx-ai-vue-root .acx-ai-copy{border:0;background:transparent;font-size:14px;line-height:1;color:#7C8688;cursor:pointer;padding:0 4px}
    #autocx-ai-vue-root .acx-ai-main{flex:1;display:flex;min-height:0}
    #autocx-ai-vue-root .acx-ai-rail{width:260px;flex:none;background:#F1F2EA;border-right:1px solid rgba(30,42,47,.14);display:flex;flex-direction:column;min-height:0}
    #autocx-ai-vue-root .acx-ai-rail-head{padding:12px 14px 10px;border-bottom:1px solid rgba(30,42,47,.12);display:flex;align-items:baseline;gap:6px}
    #autocx-ai-vue-root .acx-ai-rail-head b{font:600 12px Georgia,"Songti SC",serif}
    #autocx-ai-vue-root .acx-ai-rail-head span{margin-left:auto;font-size:9.5px;color:#8B9495}
    #autocx-ai-vue-root .acx-ai-items{flex:1;overflow:auto;scrollbar-width:thin}
    #autocx-ai-vue-root .acx-ai-item{padding:10px 14px 10px 18px;border-bottom:1px solid rgba(30,42,47,.07);position:relative;cursor:pointer}
    #autocx-ai-vue-root .acx-ai-item:hover{background:rgba(250,250,245,.6)}
    #autocx-ai-vue-root .acx-ai-item.acx-on{background:#FAFAF5}
    #autocx-ai-vue-root .acx-ai-item.acx-on::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#C2453A}
    #autocx-ai-vue-root .acx-ai-item .acx-num{font:600 10px/1 Georgia,serif;color:#C2453A;letter-spacing:.04em}
    #autocx-ai-vue-root .acx-ai-item .acx-q{font-size:10.5px;color:#334246;margin-top:4px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #autocx-ai-vue-root .acx-ai-item .acx-st{font-size:9px;color:#8B9495;margin-top:4px;display:flex;align-items:center;gap:4px}
    #autocx-ai-vue-root .acx-ai-item .acx-st i{width:5px;height:5px;border-radius:50%;background:#2F8F5B;display:inline-block;flex:none}
    #autocx-ai-vue-root .acx-ai-item .acx-st.acx-live i{background:#C2453A;animation:acx-pulse 1.4s infinite}
    #autocx-ai-vue-root .acx-ai-item .acx-st.acx-bad i{background:#C2453A}
    @keyframes acx-pulse{0%,100%{box-shadow:0 0 0 0 rgba(194,69,58,.4)}50%{box-shadow:0 0 0 4px rgba(194,69,58,0)}}
    #autocx-ai-vue-root .acx-ai-rail-foot{padding:10px 14px 12px;border-top:1px solid rgba(30,42,47,.12);font-size:9.5px;color:#7C8688}
    #autocx-ai-vue-root .acx-ai-rail-foot .acx-bar{height:3px;background:rgba(30,42,47,.12);margin:6px 0}
    #autocx-ai-vue-root .acx-ai-rail-foot .acx-bar i{display:block;height:100%;background:#C2453A}
    #autocx-ai-vue-root .acx-ai-rail-foot .acx-row{display:flex;justify-content:space-between}
    #autocx-ai-vue-root .acx-ai-rail-foot .acx-row b{color:#1E2A2F;font-weight:600}
    #autocx-ai-vue-root .acx-ai-maincol{flex:1;min-width:0;display:flex;flex-direction:column}
    #autocx-ai-vue-root .acx-ai-session{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 22px 10px 30px;font-size:9.5px;color:#7C8688;border-bottom:1px dotted rgba(30,42,47,.2)}
    #autocx-ai-vue-root .acx-ai-session b{color:#2E5A75;font-weight:500}
    #autocx-ai-vue-root .acx-ai-session .acx-sm{border:1px solid rgba(30,42,47,.14);padding:1px 6px;color:#5C6B6E}
    #autocx-ai-vue-root .acx-ai-thread{flex:1;overflow:auto;padding:12px 24px 6px 30px;position:relative;scrollbar-width:thin}
    #autocx-ai-vue-root .acx-ai-thread::before{content:"";position:absolute;left:18px;top:0;bottom:0;width:1px;background:rgba(194,69,58,.25)}
    #autocx-ai-vue-root .acx-ai-empty{color:#8B9495;font-size:11px;line-height:1.9;padding:8px 0}
    #autocx-ai-vue-root .acx-ai-turn-head{display:flex;align-items:baseline;gap:8px;padding:4px 0 8px;flex-wrap:wrap}
    #autocx-ai-vue-root .acx-ai-idx{font:600 10px/1 Georgia,serif;color:#C2453A}
    #autocx-ai-vue-root .acx-ai-q{font:600 14px/1.4 "Songti SC","SimSun",serif;color:#1E2A2F;flex:1;min-width:0}
    #autocx-ai-vue-root .acx-ai-chip{font-size:9px;border:1px solid rgba(30,42,47,.2);padding:1px 5px;color:#7C8688;white-space:nowrap}
    #autocx-ai-vue-root .acx-ai-nav{display:flex;align-items:center;gap:2px;margin-left:auto}
    #autocx-ai-vue-root .acx-ai-nav button{width:20px;height:20px;border:1px solid rgba(30,42,47,.2);background:#FAFAF5;color:#5C6B6E;font:12px/1 Consolas,monospace;cursor:pointer;padding:0}
    #autocx-ai-vue-root .acx-ai-nav button:disabled{opacity:.35;cursor:default}
    #autocx-ai-vue-root .acx-ai-nav span{font:9.5px/1 Consolas,monospace;color:#8B9495;padding:0 4px}
    #autocx-ai-vue-root .acx-ai-follow{font-size:9.5px;border:1px dashed rgba(194,69,58,.5);background:rgba(194,69,58,.04);color:#C2453A;padding:1px 6px;cursor:pointer}
    #autocx-ai-vue-root .acx-ai-receipt{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(30,42,47,.14);font-size:10.5px;color:#5C6B6E;background:rgba(250,250,245,.6)}
    #autocx-ai-vue-root .acx-ai-receipt i{width:6px;height:6px;border-radius:50%;background:#B9C0BB;display:inline-block}
    #autocx-ai-vue-root .acx-ai-req{border-top:1px solid rgba(30,42,47,.13);padding:9px 0}
    #autocx-ai-vue-root .acx-ai-req-row{display:flex;align-items:center;gap:8px;font-size:9.5px;color:#7C8688;cursor:pointer;flex-wrap:wrap}
    #autocx-ai-vue-root .acx-ai-req-row .acx-who{color:#5C6B6E}
    #autocx-ai-vue-root .acx-ai-req-row .acx-arrow{color:#C2453A}
    #autocx-ai-vue-root .acx-ai-req-row .acx-m{font-variant-numeric:tabular-nums}
    #autocx-ai-vue-root .acx-ai-req-row .acx-caret{margin-left:auto;color:#8B9495;font-size:9px;transform:rotate(90deg)}
    #autocx-ai-vue-root .acx-ai-req.acx-open .acx-caret{transform:rotate(-90deg)}
    #autocx-ai-vue-root .acx-ai-req-body{display:none;padding-top:7px}
    #autocx-ai-vue-root .acx-ai-req.open .acx-ai-req-body{display:block}
    #autocx-ai-vue-root .acx-ai-req-body pre{font:10px/1.6 Consolas,"Courier New",monospace;color:#4C5A5E;white-space:pre-wrap;word-break:break-word;margin:0}
    #autocx-ai-vue-root .acx-ai-tags{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap}
    #autocx-ai-vue-root .acx-ai-tags span{font-size:9px;border:1px solid rgba(30,42,47,.16);padding:1px 5px;color:#5C6B6E}
    #autocx-ai-vue-root .acx-ai-think{border-top:1px solid rgba(30,42,47,.13);padding:9px 0}
    #autocx-ai-vue-root .acx-ai-think-head{display:flex;align-items:center;gap:6px;font-size:9.5px;font-weight:600;color:#C2453A;margin-bottom:4px;cursor:pointer}
    #autocx-ai-vue-root .acx-ai-think-head .acx-time{font-weight:400;color:#A78B4A;font-variant-numeric:tabular-nums}
    #autocx-ai-vue-root .acx-ai-think-head .acx-caret{margin-left:auto;color:#8B9495;font-size:9px;transform:rotate(90deg)}
    #autocx-ai-vue-root .acx-ai-think.acx-collapsed .acx-ai-think-body{display:none}
    #autocx-ai-vue-root .acx-ai-think.acx-collapsed .acx-caret{transform:rotate(0)}
    #autocx-ai-vue-root .acx-ai-think-body{margin:0;font-size:10.5px;line-height:1.7;color:#334246;white-space:pre-wrap;word-break:break-word;
      background:linear-gradient(transparent 2px,rgba(233,196,106,.38) 2px,rgba(233,196,106,.38) 9px,transparent 9px)}
    #autocx-ai-vue-root .acx-ai-cursor{display:inline-block;width:6px;height:13px;background:#C2453A;vertical-align:-2px;margin-left:2px;animation:acx-blink 1s steps(2) infinite}
    @keyframes acx-blink{50%{opacity:0}}
    #autocx-ai-vue-root .acx-ai-ans{border-top:1px solid rgba(30,42,47,.13);padding:9px 0}
    #autocx-ai-vue-root .acx-ai-ans-head{display:flex;align-items:center;gap:6px;font-size:9.5px;font-weight:600;color:#C2453A;margin-bottom:4px}
    #autocx-ai-vue-root .acx-ai-ans-head .acx-time{font-weight:400;color:#8B9495}
    #autocx-ai-vue-root .acx-ai-ans-body{margin:0;font-size:10.5px;line-height:1.7;color:#1E2A2F;white-space:pre-wrap;word-break:break-word}
    #autocx-ai-vue-root .acx-ai-ans-body.acx-pending{color:#8B9495}
    #autocx-ai-vue-root .acx-ai-answer-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
    #autocx-ai-vue-root .acx-ai-key{display:inline-block;background:#C2453A;color:#FFF9F0;font:700 15px/1 Georgia,serif;padding:3px 7px}
    #autocx-ai-vue-root .acx-ai-key.acx-bad{background:#8B9495}
    #autocx-ai-vue-root .acx-ai-okn{color:#2F6B4E;font-size:9.5px}
    #autocx-ai-vue-root .acx-ai-badn{color:#C2453A;font-size:9.5px}
    #autocx-ai-vue-root .acx-ai-err{border:1px dashed rgba(194,69,58,.45);background:rgba(194,69,58,.035);padding:8px 10px;font-size:10.5px;line-height:1.7;color:#8A3A31;margin-top:8px}
    #autocx-ai-vue-root .acx-ai-err b{color:#C2453A}
    #autocx-ai-vue-root .acx-ai-foot2{display:flex;align-items:center;gap:10px;padding-top:7px;border-top:1px dotted rgba(30,42,47,.18);margin-top:8px;font-size:9px;color:#8B9495}
    #autocx-ai-vue-root .acx-ai-foot2 .acx-acts{margin-left:auto}
    #autocx-ai-vue-root .acx-ai-foot2 button{border:0;background:none;color:#7C8688;font-size:9.5px;cursor:pointer;padding:2px 5px}
    #autocx-ai-vue-root .acx-ai-foot2 button:hover{color:#C2453A}
    #autocx-ai-vue-root .acx-ai-submit-strip{padding:0 24px 8px 30px}
    #autocx-ai-vue-root .acx-ai-submit-card{border:1px dashed rgba(194,69,58,.5);background:rgba(194,69,58,.035);padding:7px 10px;font-size:9.5px;color:#7A4A43;display:flex;gap:8px;align-items:flex-start}
    #autocx-ai-vue-root .acx-ai-submit-card b{color:#C2453A;font-weight:600;white-space:nowrap}
    #autocx-ai-vue-root .acx-ai-submit-card ul{margin:2px 0 0;padding-left:14px}
    #autocx-ai-vue-root .acx-ai-note{flex:none;display:flex;align-items:center;gap:6px;border-top:1px solid rgba(30,42,47,.15);padding:9px 20px 9px 30px;background:#F7F7F0;font-size:9px;color:#8B9495}
    #autocx-ai-vue-root .acx-ai-note b{color:#7C8688;font-weight:600;margin-right:2px}
    #autocx-ai-vue-root .acx-ai-note .acx-note-right{margin-left:auto;display:flex;gap:12px}
    #autocx-ai-vue-root .acx-ai-status{flex:none;display:flex;align-items:center;gap:9px;padding:8px 20px 9px 30px;border-top:1px solid rgba(194,69,58,.18);background:#FBF7EE;font-size:9.5px;color:#8A6A2F}
    #autocx-ai-vue-root .acx-ai-status b{color:#C2453A;font-weight:600}
    #autocx-ai-vue-root .acx-ai-status .acx-status-right{margin-left:auto;display:flex;gap:8px;color:#8B9099}
    #autocx-ai-vue-root .acx-ai-status .acx-pill{border:1px solid rgba(30,42,47,.14);padding:1px 6px;color:#5C6B6E}
    @media (prefers-reduced-motion:reduce){#autocx-ai-vue-root .acx-ai-cursor,#autocx-ai-vue-root .acx-ai-item .st.live i{animation:none}}
  `;

  const AI_TEMPLATE = `
    <a-config-provider :theme="antdTheme">
      <div v-if="s.open" class="acx-ai" @mousedown.self="close">
        <div class="acx-ai-win" :style="winStyle">
          <header class="acx-ai-top" @mousedown="startDrag">
            <div class="acx-ai-seal">AI</div>
            <div class="acx-ai-title"><b>AI 作答记录</b><span>{{ meta.title || '等待测验…' }}</span></div>
            <div class="acx-ai-meta">
              <span class="acx-pill" v-if="meta.model">{{ meta.model }}</span>
              <span class="acx-pill" v-if="meta.effort">effort {{ meta.effort }}</span>
              <span>只读</span>
              <button class="acx-ai-copy" @click="copyAll" title="复制全部记录">⧉</button>
              <button class="acx-ai-close" @click="close" title="关闭 (Esc)">×</button>
            </div>
          </header>
          <div class="acx-ai-main">
            <aside class="acx-ai-rail">
              <div class="acx-ai-rail-head"><b>本次测验</b><span>{{ meta.concurrency ? meta.concurrency + ' 路并发' : '' }}</span></div>
              <div class="acx-ai-items" role="tablist" aria-orientation="vertical" aria-label="本次测验的题目">
                <div v-for="n in s.order" :key="n" class="acx-ai-item" :class="{ 'acx-on': currentN === n }" role="tab"
                  :aria-selected="currentN === n ? 'true' : 'false'" tabindex="0"
                  @click="selectQuestion(n)" @keydown.enter.prevent="selectQuestion(n)" @keydown.space.prevent="selectQuestion(n)">
                  <div class="acx-num">{{ pad2(n) }}</div>
                  <div class="acx-q">{{ (s.convs[n] && s.convs[n].stem) || '(读取中)' }}</div>
                  <div class="acx-st" :class="phaseInfo(s.convs[n] || { n: n, phase: 'queued' }).dot">
                    <i></i>{{ phaseInfo(s.convs[n] || { n: n, phase: 'queued' }).text }}
                  </div>
                </div>
                <div v-if="!s.order.length" class="acx-ai-empty" style="padding:8px 12px">暂无题目</div>
              </div>
              <div class="acx-ai-rail-foot">
                <div class="acx-row"><span>已答</span><b>{{ done }} / {{ total }}</b></div>
                <div class="acx-bar"><i :style="{ width: total ? Math.round(done / total * 100) + '%' : '0%' }"></i></div>
                <div class="acx-row"><span>{{ bad ? bad + ' 题失败' : (total - done > 0 ? (total - done) + ' 题未答' : '全部完成') }}</span><span>{{ s.meta && s.meta.submitState === 'off' ? '自动提交 关' : '' }}</span></div>
              </div>
            </aside>
            <main class="acx-ai-maincol">
              <div class="acx-ai-session" v-if="s.meta">
                <b>提取</b><span class="acx-sm">{{ (s.meta.count || 0) + ' 题 · ' + (s.meta.source || '未知来源') }}</span>
                <span v-if="s.meta.startAt">{{ fmtTime(s.meta.startAt) }}</span>
                <span v-if="s.meta.answeredAt">→ 开始作答 {{ fmtTime(s.meta.answeredAt) }}</span>
                <span v-if="s.meta.concurrency">→ 并发 {{ s.meta.concurrency }} 路</span>
                <span v-if="s.meta.note">{{ s.meta.note }}</span>
              </div>
              <div class="acx-ai-thread" ref="threadEl" role="tabpanel" aria-label="所选题目的作答记录">
                <div v-if="!s.order.length" class="acx-ai-empty">还没有记录。<br>测验页开始答题后，脚本发出的每一次请求都会出现在这里。</div>
                <div v-else class="acx-ai-turn">
                  <div class="acx-ai-turn-head">
                    <span class="acx-ai-idx">{{ pad2(currentN) }}</span>
                    <span class="acx-ai-q">{{ active.stem || '' }}</span>
                    <span class="acx-ai-chip">{{ typeLabel(active.type) }}</span>
                    <span class="acx-ai-chip" v-if="active.decode">解码 {{ active.decode.mapped || 0 }}/{{ active.decode.total || 0 }} · {{ Math.round((active.decode.conf || 0) * 100) }}%<template v-if="active.grade"> · {{ active.grade }}</template></span>
                    <button class="acx-ai-follow" v-if="!s.follow && liveN && liveN !== currentN" @click="s.follow = true">回到当前题 {{ pad2(liveN) }}</button>
                    <span class="acx-ai-nav" v-if="total > 1">
                      <button @click="stepQuestion(-1)" :disabled="currentIndex <= 0" title="上一题">‹</button>
                      <span>{{ currentIndex + 1 }} / {{ total }}</span>
                      <button @click="stepQuestion(1)" :disabled="currentIndex >= total - 1" title="下一题">›</button>
                    </span>
                  </div>

                  <div v-if="active.phase === 'queued'" class="acx-ai-receipt"><i></i>排队中 —— 并发已占满，前面的题结束后自动开始</div>
                  <template v-else>
                    <div class="acx-ai-req" :class="{ 'acx-open': s.openReq[currentN] || active.phase === 'requesting' }">
                      <div class="acx-ai-req-row" @click="toggleReq(currentN)">
                        <span class="acx-who">脚本</span><span class="acx-arrow">→</span>
                        <span class="acx-who">{{ (active.params && active.params.model) || 'model' }}</span>
                        <span class="acx-m">{{ fmtTime((active.t || {}).reqAt) }}</span>
                        <span class="acx-m">prompt {{ (active.prompt || '').length }} 字</span>
                        <span class="acx-caret">›</span>
                      </div>
                      <div class="acx-ai-req-body">
                        <pre>{{ active.prompt || '(未记录 prompt)' }}</pre>
                        <div class="acx-ai-tags">
                          <span v-if="active.params && active.params.temperature != null">temperature {{ active.params.temperature }}</span>
                          <span>stream: {{ active.streamed === false ? 'false' : 'true' }}</span>
                          <span v-if="active.params && active.params.effort">reasoning_effort: {{ active.params.effort }}</span>
                          <span v-if="active.source">来源 {{ active.source }}</span>
                        </div>
                      </div>
                    </div>

                    <div v-if="active.thinking || active.phase === 'thinking' || active.phase === 'answering' || active.phase === 'parsed' || active.phase === 'filled'" class="acx-ai-think" :class="{ 'acx-collapsed': s.openTurn[currentN] }">
                      <div class="acx-ai-think-head" @click="toggleThink(currentN)">
                        <span>{{ active.thinking ? (active.phase === 'thinking' ? '思考中' : '思考过程') : '该模型未返回思考过程' }}</span>
                        <span class="acx-time" v-if="active.thinking">{{ thinkTime(active) }}</span>
                        <span class="acx-caret" v-if="active.thinking">›</span>
                      </div>
                      <p class="acx-ai-think-body" v-if="active.thinking">{{ active.thinking }}<span class="acx-ai-cursor" v-if="active.phase === 'thinking'"></span></p>
                      <p class="acx-ai-think-body" v-else-if="active.phase === 'thinking'">等待模型吐出第一个思考片段…</p>
                    </div>

                    <div v-if="active.phase === 'failed'" class="acx-ai-err">
                      <b>失败</b> · 第 {{ active.attempt || 1 }} 次尝试<br>{{ (active.error && active.error.message) || '未知错误' }}
                      <template v-if="active.error && active.error.hint"><br><span style="color:#8A6A2F">{{ active.error.hint }}</span></template>
                    </div>
                    <div v-else class="acx-ai-ans">
                      <div class="acx-ai-ans-head"><span>回答</span><span class="acx-time">{{ answerTime(active) }}</span></div>
                      <p class="acx-ai-ans-body" :class="{ 'acx-pending': !active.answer }">{{ active.answer || (active.phase === 'thinking' ? '模型还在想，回答会在这里逐字出现…' : '等待回答…') }}<span class="acx-ai-cursor" v-if="active.phase === 'answering'"></span></p>
                      <div class="acx-ai-answer-line" v-if="active.result && active.result.display" style="margin-top:7px">
                        <span class="acx-ai-key" :class="{ 'acx-bad': active.result.ok === false }">{{ active.result.display }}</span>
                        <span v-if="active.result.normalized">解析 → {{ active.result.normalized }}</span>
                        <span class="acx-ai-okn" v-if="active.result.fillOk">✓ 已在页面上勾选</span>
                        <span class="acx-ai-okn" v-if="active.result.verifyOk === true">✓ 回读校验一致</span>
                        <span class="acx-ai-badn" v-if="active.result.verifyOk === false">✗ 回读不一致</span>
                      </div>
                    </div>
                  </template>

                  <div class="acx-ai-foot2">
                    <span>{{ metaText(active) }}</span>
                    <span class="acx-acts"><button @click="copyTurn(active)">复制本题</button></span>
                  </div>
                </div>
              </div>
              <div class="acx-ai-submit-strip" v-if="submitText || s.submitEvents.length">
                <div class="acx-ai-submit-card">
                  <b>提交轨迹</b>
                  <div v-if="s.submitEvents.length"><ul><li v-for="(e, i) in s.submitEvents.slice(-8)" :key="i">{{ fmtTime(e.ts) }} · {{ e.text || e.state || '' }}</li></ul></div>
                  <span v-else>{{ submitText }}</span>
                </div>
              </div>
              <div class="acx-ai-note"><b>只读记录</b><span>不提供输入，不改答案；模型输出按纯文本转义展示。</span><span class="acx-note-right"><span>AutoCX v{{ version }}</span><a :href="repo.github" target="_blank" rel="noopener noreferrer">GitHub</a><span>MIT</span></span></div>
            </main>
          </div>
          <footer class="acx-ai-status">
            <span v-html="statusHtml"></span>
            <span class="acx-status-right"><span class="acx-pill" v-if="meta.keyTail">密钥 ●●●●{{ meta.keyTail }}</span><span class="acx-pill" v-if="meta.host">{{ meta.host }}</span></span>
          </footer>
        </div>
      </div>
    </a-config-provider>
  `;

  function createAIWindow() {
    const V = VUE3 || ((typeof window !== 'undefined' && window.Vue && window.Vue.createApp) ? window.Vue : null);
    const A = ANTD || ((typeof window !== 'undefined' && window.antd) ? window.antd : (typeof antd !== 'undefined' ? antd : null));
    if (!V || !V.createApp || !A) {
      return {
        open() { log.error('ai', 'Vue/AntD 未加载，作答记录窗口不可用'); },
        close() {}, toggle() {}, refresh() {},
      };
    }
    const { reactive, computed, watch, nextTick, onMounted } = V;
    const view = reactive({
      open: false, sid: null, meta: null, order: [], convs: {}, submitEvents: [],
      openReq: {}, openTurn: {}, sel: 0, follow: true, now: Date.now(), left: null, top: null,
    });
    const offs = [];
    let tick = null;
    let mounted = false;
    const safeGet = (k) => { try { return GM_getValue(k); } catch (_) { return undefined; } };
    const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
    const sec = (ts) => (ts ? new Date(ts).toTimeString().slice(0, 8) : '');
    const dur = (ms) => {
      if (!ms || ms < 0) return '';
      return ms < 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 100) / 10 + 's';
    };
    const TYPE = { single: '单选', multi: '多选', judge: '判断', blank: '填空' };
    const LIVE = { queued: 1, requesting: 1, thinking: 1, answering: 1 };

    function unbind() {
      offs.forEach((off) => { try { off(); } catch (_) { /* 忽略 */ } });
      offs.length = 0;
      view.convs = {};
      view.order = [];
    }
    function bind(sid) {
      if (view.sid === sid) return;
      unbind();
      view.sid = sid;
      view.meta = null;
      view.submitEvents = [];
      if (!sid) return;
      const meta = safeGet(AI_S(sid));
      if (meta) applyMeta(meta);
      offs.push(aibus.on(AI_S(sid), (m) => { if (m) applyMeta(m); }));
    }
    function applyMeta(meta) {
      view.meta = meta;
      view.submitEvents = Array.isArray(meta.events) ? meta.events.slice() : [];
      const count = Number(meta.count) || 0;
      const bound = new Set(view.order);
      for (let i = 1; i <= count; i++) {
        const n = i;
        if (bound.has(n)) continue;
        const cur = safeGet(AI_C(view.sid, n));
        if (cur) {
          view.convs[n] = cur;
          if (!view.order.includes(n)) view.order.push(n);
        }
        offs.push(aibus.on(AI_C(view.sid, n), (v) => {
          if (v) {
            view.convs[n] = v;
            if (!view.order.includes(n)) { view.order.push(n); view.order.sort((a, b) => a - b); }
            view.now = Date.now();
          }
        }));
      }
      view.order.sort((a, b) => a - b);
    }
    function phaseInfo(c) {
      const t = c.t || {};
      const now = view.now;
      if (c.phase === 'queued') return { dot: '', text: '排队中' };
      if (c.phase === 'requesting') return { dot: 'acx-live', text: '请求中 · ' + dur(now - (t.reqAt || now)) };
      if (c.phase === 'thinking') return { dot: 'acx-live', text: '思考中 · ' + dur(now - (t.reqAt || now)) };
      if (c.phase === 'answering') return { dot: 'acx-live', text: '回答中 · ' + dur(now - (t.reqAt || now)) };
      if (c.phase === 'parsed') return { dot: 'acx-live', text: '已解析 · ' + ((c.result && c.result.display) || '') };
      if (c.phase === 'filled') return { dot: 'acx-ok', text: '已完成 · ' + ((c.result && c.result.display) || '') + (c.result && c.result.fillOk ? ' · 已勾选' : '') };
      if (c.phase === 'failed') return { dot: 'acx-bad', text: '失败' + (c.error && c.error.message ? ' · ' + String(c.error.message).slice(0, 18) : '') };
      return { dot: '', text: c.phase || '' };
    }
    function liveIndex() { return view.order.find((n) => LIVE[(view.convs[n] || {}).phase]) || 0; }
    function selectQuestion(n) { if (!view.order.includes(n)) return; view.follow = false; view.sel = n; }
    function stepQuestion(delta) {
      const idx = view.order.indexOf(view.sel || view.order[0]);
      const next = view.order[Math.min(view.order.length - 1, Math.max(0, idx + delta))];
      if (next && next !== view.sel) { view.follow = false; view.sel = next; }
    }
    function copy(text, label) { try { GM_setClipboard(text); } catch (_) { /* 剪贴板不可用 */ } log.info('ai', '已复制' + (label || '记录')); }
    function turnText(c) {
      const lines = [
        `# 第 ${c.n} 题 [${TYPE[c.type] || c.type}] ${c.stem || ''}`,
        '', '### 请求', c.prompt || '', '',
        '### 思考', c.thinking || '(无)', '',
        '### 回答', c.answer || '(无)',
      ];
      if (c.result && c.result.display) {
        lines.push('', '### 结果', `答案 ${c.result.display}`,
          c.result.fillOk ? '已勾选' : '未勾选',
          c.result.verifyOk === true ? '回读校验一致' : (c.result.verifyOk === false ? '回读不一致' : ''));
      }
      return lines.join('\n');
    }
    function open() {
      view.open = true;
      place();
      unbind();
      view.sid = null;
      bind(safeIndex());
      view.now = Date.now();
      if (!tick) tick = setInterval(() => { if (view.open) view.now = Date.now(); }, 500);
      setTimeout(() => {
        if (!view.open) return;
        const sid = safeIndex();
        if (sid !== view.sid) bind(sid); else view.now = Date.now();
      }, 150);
    }
    function close() { view.open = false; if (tick) { clearInterval(tick); tick = null; } }
    function refresh() { view.now = Date.now(); }
    function place() {
      const pos = config.get('autocx.ai.winPos');
      if (pos && pos.left != null) {
        view.left = pos.left;
        view.top = pos.top;
      } else {
        view.left = Math.max(0, Math.round((window.innerWidth - 980) / 2));
        view.top = Math.max(0, Math.round((window.innerHeight - 640) / 2));
      }
      setTimeout(clamp, 30);
    }
    function clamp() {
      const el = document.querySelector('#autocx-ai-vue-root .acx-ai-win');
      if (!el) return;
      const r = el.getBoundingClientRect();
      view.left = Math.round(Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width)));
      view.top = Math.round(Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - r.height)));
    }
    function safeIndex() {
      const idx = safeGet(AI_INDEX);
      if (Array.isArray(idx) && idx.length) return idx[0].sid;
      return null;
    }

    function mountApp() {
      if (mounted) return;
      GM_addStyle(AI_CSS);
      try { if (typeof unsafeWindow !== 'undefined' && !unsafeWindow.Vue) unsafeWindow.Vue = V; } catch (_) { /* 忽略 */ }
      const mount = document.createElement('div');
      mount.id = 'autocx-ai-vue-root';
      (document.body || document.documentElement).appendChild(mount);
      const app = V.createApp({
        template: AI_TEMPLATE,
        setup() {
          const threadEl = V.ref(null);
          const currentN = computed(() => {
            if (!view.order.length) return 0;
            if (view.follow) {
              const live = liveIndex();
              if (live) return live;
            }
            if (!view.sel || !view.order.includes(view.sel)) return view.order[0];
            return view.sel;
          });
          const active = computed(() => view.convs[currentN.value] || { n: currentN.value, phase: 'queued' });
          const total = computed(() => view.order.length);
          const done = computed(() => view.order.filter((n) => { const c = view.convs[n] || {}; return c.phase === 'filled' || c.phase === 'parsed'; }).length);
          const bad = computed(() => view.order.filter((n) => (view.convs[n] || {}).phase === 'failed').length);
          const meta = computed(() => view.meta || {});
          const currentIndex = computed(() => Math.max(0, view.order.indexOf(currentN.value)));
          const liveN = computed(() => liveIndex());
          const winStyle = computed(() => view.left == null ? {} : { left: view.left + 'px', top: view.top + 'px' });
          const version = VERSION;
          const repo = REPO;
          const antdTheme = {
            token: {
              colorPrimary: '#C2453A', colorText: '#1E2A2F', colorBgContainer: '#FAFAF5',
              colorBorder: 'rgba(30,42,47,.25)', borderRadius: 2, controlHeight: 28,
              fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
            },
          };
          const typeLabel = (t) => TYPE[t] || '';
          const fmtTime = (ts) => sec(ts);
          const thinkTime = (c) => {
            const t = c.t || {};
            if (t.firstThinkAt && t.firstAnswerAt) return dur(t.firstAnswerAt - t.firstThinkAt);
            if (t.firstThinkAt) return dur(view.now - t.firstThinkAt);
            return '';
          };
          const answerTime = (c) => {
            const t = c.t || {};
            if (t.firstAnswerAt && t.doneAt) return dur(t.doneAt - t.firstAnswerAt);
            if (c.phase === 'answering') return '生成中';
            return '';
          };
          const toggleReq = (n) => { view.openReq[n] = !view.openReq[n]; };
          const toggleThink = (n) => { view.openTurn[n] = !view.openTurn[n]; };
          const metaText = (c) => {
            const t = c.t || {};
            const bits = [];
            if (c.usage && c.usage.completion_tokens != null) bits.push('回答 ' + c.usage.completion_tokens + ' tok');
            if (c.usage && c.usage.total_tokens != null) bits.push('共 ' + c.usage.total_tokens + ' tok');
            if (t.reqAt && t.doneAt) bits.push(dur(t.doneAt - t.reqAt));
            if (c.streamed === false) bits.push('非流式回放');
            return bits.join(' · ') || phaseInfo(c).text;
          };
          const submitText = computed(() => {
            if (view.submitEvents.length) return '';
            if (!view.order.length || liveIndex() || !view.meta || view.meta.submitState === 'done') return '';
            return view.meta.submitState === 'off'
              ? '⏸ 自动提交已关闭：答案已填写，提交请你在答卷页自己点。'
              : '等待全部题目答完后再判断是否提交。';
          });
          const statusHtml = computed(() => {
            const m = view.meta;
            if (!m) return '';
            const st = m.submitState;
            const map = {
              off: '<b>自动提交 关</b> 开启后也只在全部题目答完时触发',
              wait: '<b>自动提交 开</b> 等待全部题目答完',
              ready: '<b>自动提交 开</b> 全部答完，即将提交',
              done: '<b>已提交</b> ' + escHtml(m.submitDetail || ''),
              blocked: '<b>未提交</b> ' + escHtml(m.submitDetail || '有未答题，已停下等你'),
              captcha: '<b>未提交</b> 出现验证码，转人工',
            };
            return map[st] || '<b>自动提交 关</b>';
          });
          const close = () => { view.open = false; if (tick) { clearInterval(tick); tick = null; } };
          const copyAll = () => {
            const out = view.order.map((n) => turnText(view.convs[n] || { n })).join('\n\n---\n\n');
            copy(out || '(没有记录)', '全部记录');
          };
          const copyTurn = (c) => copy(turnText(c), '');
          const startDrag = (e) => {
            if (e.target.closest('button')) return;
            const el = document.querySelector('#autocx-ai-vue-root .acx-ai-win');
            if (!el) return;
            const r = el.getBoundingClientRect();
            const dx = e.clientX - r.left;
            const dy = e.clientY - r.top;
            const move = (ev) => {
              const rr = el.getBoundingClientRect();
              view.left = Math.round(Math.min(Math.max(0, ev.clientX - dx), Math.max(0, window.innerWidth - rr.width)));
              view.top = Math.round(Math.min(Math.max(0, ev.clientY - dy), Math.max(0, window.innerHeight - rr.height)));
            };
            const up = () => {
              document.removeEventListener('mousemove', move);
              document.removeEventListener('mouseup', up);
              config.set('autocx.ai.winPos', { left: view.left, top: view.top });
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            e.preventDefault();
          };
          onMounted(() => {
            window.addEventListener('keydown', (e) => {
              if (!view.open) return;
              if (e.key === 'Escape') { close(); return; }
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              const t = e.target;
              if (!t || !t.closest || !t.closest('#autocx-ai-vue-root')) return;
              if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
              e.preventDefault();
              stepQuestion(e.key === 'ArrowRight' ? 1 : -1);
            });
          });
          watch(currentN, () => { nextTick(() => { if (threadEl.value) threadEl.value.scrollTop = 0; }); });
          return {
            s: view, meta, active, total, done, bad, currentN, currentIndex, liveN, winStyle, version, repo,
            antdTheme, typeLabel, fmtTime, phaseInfo, thinkTime, answerTime, toggleReq, toggleThink, metaText,
            submitText, statusHtml, close, copyTurn, copyAll, startDrag, selectQuestion, stepQuestion, pad2,
          };
        },
      });
      app.use(A);
      app.mount(mount);
      mounted = true;
    }

    return { open: () => { mountApp(); open(); }, close, toggle: () => { if (view.open) close(); else { mountApp(); open(); } }, refresh };
  }

  /** 调试用:造一份演示记录(不触发任何真实请求),用来离线核对窗口界面 */
  function seedDemo() {
    const sid = 'demo';
    const t0 = Date.now() - 90000;
    const meta = {
      sid, workKey: 'demo',
      title: '演示数据 · 影视艺术概述 · 章节测验',
      count: 3, source: '接口明文', concurrency: 2,
      model: config.get('llm.model'), effort: String(config.get('llm.effort') || ''),
      host: String(config.get('llm.base_url') || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      keyTail: String(config.get('llm.api_key') || '').slice(-4),
      startAt: t0, answeredAt: t0 + 2000, answered: 1, failed: 0,
      submitState: 'off', submitDetail: '', events: [],
    };
    aibus.touchIndex(meta);
    aibus.put(AI_S(sid), meta);
    aibus.put(AI_C(sid, 1), {
      n: 1, type: 'single', stem: '下列选项错误描述影视艺术的是（　）',
      options: [], source: '接口明文', phase: 'filled',
      prompt: '请回答下面这道单选题。\n题目:下列选项错误描述影视艺术的是（　）\nA、影视艺术是综合艺术的结晶\nB、影视艺术是高雅的艺术门类\nC、影视艺术是强大的传播媒体\nD、影视艺术是现代科技的产物\n要求:只回复正确选项的字母(如 B),不要任何解释。',
      params: { model: meta.model, temperature: 0.1, effort: meta.effort, stream: true },
      thinking: '逐项看:A 说影视艺术是综合艺术的结晶,这是教材原文;C 说它是强大的传播媒体,也对;D 说它依赖现代科技,同样成立。B 把它归为“高雅的艺术门类”,而影视艺术恰恰被公认为大众艺术,所以 B 的描述是错的。',
      answer: 'B', streamed: true,
      result: { display: 'B', normalized: '单选取首字母 → B', letters: ['B'], ok: true, fillOk: true, verifyOk: true },
      usage: { completion_tokens: 96, total_tokens: 412 }, error: null, attempt: 1,
      t: { queuedAt: t0, reqAt: t0 + 2000, firstThinkAt: t0 + 2300, firstAnswerAt: t0 + 4800, doneAt: t0 + 6300 },
    });
    aibus.put(AI_C(sid, 2), {
      n: 2, type: 'judge', stem: '中国戏曲舞台要求设置与真实相同的时空。（　）',
      options: [], source: 'DOM 提取', phase: 'thinking',
      prompt: '请回答下面这道判断题。\n题目:中国戏曲舞台要求设置与真实相同的时空。（　）\nA、正确\nB、错误\n要求:只回复正确选项的字母(如 B),不要任何解释。',
      params: { model: meta.model, temperature: 0.1, effort: meta.effort, stream: true },
      thinking: '题干在问“是否要求与真实相同的时空”。戏曲舞台的核心特征是虚拟性与程式化,一桌二椅可以代表整个厅堂,时间和空间随表演自由流动,恰恰',
      answer: '', streamed: true, result: null, usage: null, error: null, attempt: 1,
      t: { queuedAt: t0, reqAt: Date.now() - 3100, firstThinkAt: Date.now() - 2800, firstAnswerAt: 0, doneAt: 0 },
    });
    aibus.put(AI_C(sid, 3), {
      n: 3, type: 'single', stem: '电影发展历程中,蒙太奇手法最早系统的实践者是（　）',
      options: [], source: 'DOM 提取', phase: 'queued', prompt: '', params: null,
      thinking: '', answer: '', streamed: true, result: null, usage: null, error: null, attempt: 0,
      t: { queuedAt: t0 },
    });
    aibus.put(AI_PING, {
      sid, title: meta.title, count: meta.count, answered: 1, failed: 0,
      submitState: 'off', model: meta.model, source: meta.source, ts: Date.now(),
    });
    return sid;
  }

/* ============================== 悬浮面板(Vue) ============================= */
  // 只在 top 帧渲染;通过 GM_addValueChangeListener 聚合各任务帧的日志/状态。
  // 视觉:批注纸(纸白 + 墨 + 红笔),收起为右缘书签。
  function initTopPanel() {
    const V = VUE3 || ((typeof window !== 'undefined' && window.Vue && window.Vue.createApp) ? window.Vue : null);
    const A = ANTD || ((typeof window !== 'undefined' && window.antd) ? window.antd : (typeof antd !== 'undefined' ? antd : null));
    if (!V || !V.createApp) {
      log.error('panel', 'Vue 未加载，悬浮面板不可用（业务逻辑继续）');
      return;
    }
    if (!A) {
      log.error('panel', 'Ant Design Vue 未加载，悬浮面板不可用（业务逻辑继续）');
      return;
    }
    GM_addStyle(PANEL_CSS);
    elmGetter.get('body', 15000).then((body) => {
      const mount = document.createElement('div');
      mount.id = 'autocx-vue-root';
      (body || document.body).appendChild(mount);
      try { if (typeof unsafeWindow !== 'undefined' && !unsafeWindow.Vue) unsafeWindow.Vue = V; } catch (_) { /* 忽略 */ }
      const app = V.createApp(createPanelRoot(V));
      app.use(A);
      app.mount(mount);
      log.info('panel', '悬浮面板已加载');
    }).catch((e) => log.error('panel', '等待 body 超时: ' + (e && e.stack ? e.stack : e.message)));
  }

  const PANEL_CSS = `
    #autocx-vue-root{position:fixed;inset:0;z-index:2147483646;pointer-events:none;
      font:13px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#1E2A2F}
    #autocx-vue-root *{box-sizing:border-box}
    #autocx-vue-root .acx-ui{pointer-events:none}
    #autocx-vue-root .acx-ui > *{pointer-events:auto}
    #autocx-vue-root button{font:inherit}
    /* ---------- 纸面 ---------- */
    #autocx-vue-root .acx-panel{position:fixed;right:16px;bottom:16px;width:400px;height:610px;max-height:calc(100vh - 32px);
      background-color:#FAFAF5;
      background-image:linear-gradient(rgba(30,42,47,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(30,42,47,.03) 1px,transparent 1px);
      background-size:20px 20px;border:1px solid rgba(30,42,47,.24);box-shadow:0 20px 48px rgba(30,42,47,.22);
      clip-path:polygon(0 0,calc(100% - 22px) 0,100% 22px,100% 100%,0 100%);
      display:flex;flex-direction:column;color:#1E2A2F}
    #autocx-vue-root .acx-panel::after{content:"";position:absolute;top:0;right:0;width:22px;height:22px;
      background:linear-gradient(225deg,#D9DCD2 50%,#F1F2EB 50%);border-left:1px solid rgba(30,42,47,.14);border-bottom:1px solid rgba(30,42,47,.14)}
    #autocx-vue-root .acx-margin-rule{position:absolute;left:22px;top:0;bottom:0;width:1px;background:rgba(194,69,58,.32);pointer-events:none}
    #autocx-vue-root .acx-head{display:flex;align-items:center;gap:10px;padding:17px 20px 12px 34px;cursor:default}
    #autocx-vue-root .acx-head-drag{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:grab;margin:-10px 0 -8px;padding:10px 0 8px;user-select:none}
    #autocx-vue-root .acx-head-drag:active{cursor:grabbing}
    #autocx-vue-root .acx-head-tools{display:flex;align-items:center;gap:4px;flex:none;cursor:default}
    #autocx-vue-root .acx-seal{width:32px;height:32px;background:#C2453A;color:#FFF9F0;display:flex;align-items:center;justify-content:center;
      font:700 12px/1 Georgia,"Songti SC",serif;letter-spacing:.06em;transform:rotate(-2.5deg);
      box-shadow:inset 0 0 0 2px rgba(255,255,255,.24);flex:none}
    #autocx-vue-root .acx-title{display:flex;flex-direction:column;line-height:1.15}
    #autocx-vue-root .acx-title strong{font:600 19px/1.1 Georgia,"Songti SC","SimSun",serif;letter-spacing:-.01em}
    #autocx-vue-root .acx-title span{font-size:10px;color:#7C8688;margin-top:3px;letter-spacing:.12em}
    #autocx-vue-root .acx-switch{width:34px;height:18px;border:1px solid #1E2A2F;background:#FAFAF5;position:relative;cursor:pointer;padding:0}
    #autocx-vue-root .acx-switch i{position:absolute;top:2px;right:2px;width:12px;height:12px;background:#C2453A;transition:.15s}
    #autocx-vue-root .acx-switch.acx-off i{right:auto;left:2px;background:#B9C0BB}
    #autocx-vue-root .acx-min{width:22px;height:20px;border:0;background:transparent;color:#7C8688;font-size:15px;line-height:1;cursor:pointer;padding:0;margin-left:2px}
    #autocx-vue-root .acx-min:hover{color:#C2453A}
    #autocx-vue-root .acx-head-rule{margin:0 18px 0 34px;border-top:2px solid #1E2A2F;border-bottom:1px solid rgba(194,69,58,.45);height:4px}
    #autocx-vue-root .acx-ledger{padding:12px 22px 9px 34px;display:flex;flex-direction:column;gap:2px}
    #autocx-vue-root .acx-ledger-row{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;cursor:pointer;user-select:none}
    #autocx-vue-root .acx-ledger-row + .acx-ledger-row{border-top:1px dotted rgba(30,42,47,.18)}
    #autocx-vue-root .acx-ledger-row .acx-glyph{width:15px;color:#C2453A;font-size:11px}
    #autocx-vue-root .acx-ledger-row b{font-weight:600}
    #autocx-vue-root .acx-ledger-row .acx-leader{flex:1;border-bottom:1px dotted rgba(30,42,47,.22);margin:0 3px 3px}
    #autocx-vue-root .acx-ledger-row em{font-style:normal;color:#5C6B6E;font-size:11px;font-variant-numeric:tabular-nums}
    #autocx-vue-root .acx-ledger-row em.acx-live{color:#C2453A}
    #autocx-vue-root .acx-ledger-row em.acx-off{color:#A2AAA8}
    /* ---------- 页签 ---------- */
    #autocx-vue-root .acx-tabs{display:flex;align-items:flex-end;gap:3px;padding:10px 18px 0 34px}
    #autocx-vue-root .acx-tab{font-size:11.5px;padding:5px 11px 6px;background:#EFF0E8;color:#5F6B6D;border:1px solid rgba(30,42,47,.16);border-bottom:0;
      border-radius:3px 3px 0 0;cursor:pointer}
    #autocx-vue-root .acx-tab.acx-on{background:#FAFAF5;color:#C2453A;border-top:2px solid #C2453A;font-weight:600;padding-top:4px}
    /* ---------- 正文 ---------- */
    #autocx-vue-root .acx-body{flex:1;border-top:1px solid rgba(30,42,47,.18);margin:0 18px 0 34px;padding:11px 4px 10px 0;overflow:auto;scrollbar-width:thin}
    #autocx-vue-root .acx-empty{color:#8B9495;font-size:11px;line-height:1.8;padding:6px 0}
    #autocx-vue-root .acx-status-item{padding:6px 0;border-bottom:1px solid rgba(30,42,47,.07);font-size:10.5px;color:#334246}
    #autocx-vue-root .acx-status-item .acx-badge{display:inline-block;padding:1px 6px;border-radius:4px;color:#fff;font-size:9.5px;margin-right:6px;background:#8B9495}
    #autocx-vue-root .acx-badge.acx-badge-video{background:#2E5A75}
    #autocx-vue-root .acx-badge.acx-badge-quiz{background:#8B5CF6}
    #autocx-vue-root .acx-badge.acx-badge-knowledge{background:#2F6B4E}
    #autocx-vue-root .acx-badge.acx-badge-advance{background:#B7791F}
    #autocx-vue-root .acx-badge.acx-badge-doc{background:#2C7A7B}
    #autocx-vue-root .acx-status-item .acx-t{color:#8B9495;font-size:9.5px;margin-top:2px}
    #autocx-vue-root .acx-log{font-size:10px;color:#4C5A5E}
    #autocx-vue-root .acx-log div{padding:3px 0;border-bottom:1px solid rgba(30,42,47,.06);word-break:break-all}
    #autocx-vue-root .acx-log .acx-log-warn{color:#A05A34}
    #autocx-vue-root .acx-log .acx-log-error{color:#C2453A}
    /* ---------- 设置 ---------- */
    #autocx-vue-root .acx-set-group{padding:2px 0 8px}
    #autocx-vue-root .acx-set-group + .acx-set-group{border-top:1px dotted rgba(30,42,47,.18);padding-top:10px}
    #autocx-vue-root .acx-set-group h4{margin:0 0 8px;font:600 10px/1.2 -apple-system,"PingFang SC",sans-serif;color:#8B9495;letter-spacing:.12em}
    #autocx-vue-root .acx-field{margin-bottom:9px}
    #autocx-vue-root .acx-field label{display:flex;align-items:baseline;justify-content:space-between;font-size:10.5px;color:#4C5A5E;margin-bottom:3px}
    #autocx-vue-root .acx-field label em{font-style:normal;font-size:9.5px;color:#A0A8A7}
    #autocx-vue-root .acx-field input,#autocx-vue-root .acx-field .ant-input,#autocx-vue-root .acx-field .ant-select-selector{
      width:100%;border:0!important;border-bottom:1px solid rgba(30,42,47,.3)!important;border-radius:0!important;padding:3px 2px 4px!important;
      font-size:11px!important;background:transparent!important;box-shadow:none!important;color:#1E2A2F!important;outline:none!important}
    #autocx-vue-root .acx-field input:focus,#autocx-vue-root .acx-field .ant-input:focus{border-bottom-color:#C2453A!important}
    #autocx-vue-root .acx-field .ant-select{width:100%;font-size:11px}
    #autocx-vue-root .acx-field .ant-select-selection-item{font-size:11px;line-height:20px}
    #autocx-vue-root .acx-field .ant-select-arrow{color:#7C8688;font-size:9px}
    #autocx-vue-root .acx-toggle{width:32px;height:16px;border:1px solid #1E2A2F;background:#FAFAF5;position:relative;cursor:pointer;padding:0;flex:none}
    #autocx-vue-root .acx-toggle i{position:absolute;top:2px;right:2px;width:10px;height:10px;background:#C2453A}
    #autocx-vue-root .acx-toggle.acx-off i{right:auto;left:2px;background:#B9C0BB}
    #autocx-vue-root .acx-inline{display:flex;align-items:center;gap:8px;font-size:10.5px;color:#4C5A5E;margin:6px 0 9px;cursor:pointer;user-select:none}
    #autocx-vue-root .acx-inline .acx-toggle{margin-left:auto}
    #autocx-vue-root .acx-note{font-size:9.5px;color:#8B9495;line-height:1.5;margin-top:2px}
    #autocx-vue-root .acx-btn{background:#C2453A;color:#FFF9F0;border:0;padding:7px 12px;font-size:11px;cursor:pointer}
    #autocx-vue-root .acx-btn:hover{opacity:.88}
    #autocx-vue-root .acx-btn[disabled]{opacity:.5;cursor:default}
    #autocx-vue-root .acx-test{margin-top:6px;font-size:10px;line-height:1.5;color:#5C6B6E}
    /* ---------- 页脚 ---------- */
    #autocx-vue-root .acx-foot{display:flex;align-items:center;gap:10px;padding:8px 20px 9px 34px;font-size:9.5px;color:#8B9495;border-top:1px solid rgba(30,42,47,.09)}
    #autocx-vue-root .acx-foot .acx-foot-links{margin-left:auto;display:flex;gap:8px}
    #autocx-vue-root .acx-foot a{color:#8B9495;text-decoration:none}
    #autocx-vue-root .acx-foot a:hover{color:#C2453A}
    /* ---------- 书签 ---------- */
    #autocx-vue-root .acx-bookmark{position:fixed;right:0;top:31%;width:28px;height:124px;background:#FAFAF5;border:1px solid rgba(30,42,47,.25);border-right:0;
      box-shadow:0 8px 22px rgba(30,42,47,.18);display:flex;flex-direction:column;align-items:center;padding:9px 0 8px;cursor:pointer;
      font:600 9px/1.2 Georgia,"Songti SC",serif;color:#1E2A2F;letter-spacing:.08em;user-select:none;touch-action:none}
    #autocx-vue-root .acx-bookmark.acx-dragging{cursor:grabbing;box-shadow:0 12px 28px rgba(30,42,47,.28)}
    #autocx-vue-root .acx-bookmark::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:#C2453A}
    #autocx-vue-root .acx-bm-text{writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:.16em}
    #autocx-vue-root .acx-bm-bar{width:3px;flex:1;background:rgba(30,42,47,.1);margin:7px 0;position:relative}
    #autocx-vue-root .acx-bm-bar i{position:absolute;left:0;bottom:0;width:100%;background:#C2453A;transition:height .4s}
    #autocx-vue-root .acx-bm-pct{margin-top:auto;color:#C2453A;font:600 11px/1 "Bahnschrift",sans-serif}
    #autocx-vue-root .acx-bm-menu{display:none;position:absolute;right:34px;top:0;width:248px;background:#FAFAF5;border:1px solid rgba(30,42,47,.24);box-shadow:0 14px 32px rgba(30,42,47,.18);padding:6px}
    #autocx-vue-root .acx-bookmark:hover .acx-bm-menu{display:block}
    #autocx-vue-root .acx-bm-menu .acx-bm-mi{display:flex;align-items:center;justify-content:space-between;padding:9px 10px;font-size:11px;color:#334246;border-bottom:1px dotted rgba(30,42,47,.14);cursor:pointer}
    #autocx-vue-root .acx-bm-menu .acx-bm-mi:last-child{border-bottom:0}
    #autocx-vue-root .acx-bm-menu .acx-bm-mi:hover{background:#F2F3EA}
    #autocx-vue-root .acx-bm-menu .acx-bm-mi b{font-weight:500;color:#C2453A;font-size:10px}
    #autocx-vue-root .acx-bm-menu .acx-bm-mi .acx-bm-st{color:#8B9495;font-size:10px}
    /* ---------- AntD 下拉层 ---------- */
    .ant-select-dropdown{z-index:2147483647!important;font-size:11px}
    .ant-select-item{font-size:11px!important}
    @media (prefers-reduced-motion:reduce){#autocx-vue-root .acx-bm-bar i{transition:none}}
  `;

  const PANEL_TEMPLATE = `
    <a-config-provider :theme="antdTheme">
      <div class="acx-ui">
        <div v-if="!panelOpen" class="acx-bookmark" :class="{ 'acx-dragging': bookmarkDragging }" :style="bookmarkStyle"
          @pointerdown="startBookmarkDrag" @keydown.enter.prevent="panelOpen = true" @keydown.space.prevent="panelOpen = true"
          tabindex="0" role="button" title="单击展开；上下拖动可移动">
          <span class="acx-bm-text">AutoCX</span>
          <span class="acx-bm-bar"><i :style="{ height: progress + '%' }"></i></span>
          <span class="acx-bm-pct">{{ progress || '—' }}</span>
          <div class="acx-bm-menu" @pointerdown.stop @click.stop>
            <div class="acx-bm-mi" @click="panelOpen = true"><span>展开面板</span><span class="acx-bm-st">›</span></div>
            <div class="acx-bm-mi" @click="toggleAssist('video')"><span>看课助手</span><b>{{ assistVideo ? '已开启' : '已关闭' }}</b></div>
            <div class="acx-bm-mi" @click="toggleAssist('quiz')"><span>答题助手</span><b>{{ assistQuiz ? '已开启' : '已关闭' }}</b></div>
            <div class="acx-bm-mi" @click="openAI"><span>答题记录</span><span class="acx-bm-st">›</span></div>
            <div class="acx-bm-mi" @click="toggleMain"><span>总开关</span><b>{{ enabled ? '已开启' : '已关闭' }}</b></div>
          </div>
        </div>

        <section v-if="panelOpen" class="acx-panel" :style="panelStyle" ref="panelEl">
          <div class="acx-margin-rule"></div>
          <header class="acx-head">
            <div class="acx-head-drag" @mousedown="startDrag">
              <div class="acx-seal">CX</div>
              <div class="acx-title"><strong>AutoCX</strong><span>学习通助手</span></div>
            </div>
            <div class="acx-head-tools">
              <button class="acx-switch" :class="{ 'acx-off': !enabled }" @click="toggleMain" :title="enabled ? '总开关：开' : '总开关：关'"><i></i></button>
              <button class="acx-min" @click="collapsePanel" title="收起为书签">—</button>
            </div>
          </header>
          <div class="acx-head-rule"></div>
          <div class="acx-ledger">
            <div class="acx-ledger-row" @click="toggleAssist('video')">
              <span class="acx-glyph">▶</span><b>看课助手</b><span class="acx-leader"></span>
              <em :class="assistVideo ? 'acx-live' : 'acx-off'">{{ assistVideo ? videoState : '已关闭' }}</em>
            </div>
            <div class="acx-ledger-row" @click="toggleAssist('quiz')">
              <span class="acx-glyph">✎</span><b>答题助手</b><span class="acx-leader"></span>
              <em :class="assistQuiz ? '' : 'acx-off'">{{ assistQuiz ? quizState : '已关闭' }}</em>
            </div>
          </div>
          <nav class="acx-tabs">
            <button v-for="t in tabs" :key="t.key" class="acx-tab" :class="{ 'acx-on': activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</button>
          </nav>
          <div class="acx-body" ref="bodyEl">
            <template v-if="activeTab === 'status'">
              <div v-if="!statuses.length" class="acx-empty">等待任务帧上报…</div>
              <div v-for="(s, i) in statuses" :key="i" class="acx-status-item">
                <span class="acx-badge" :class="'acx-badge-' + s.module">{{ s.module }}</span>{{ s.state }} {{ s.detail }}
                <div class="acx-t">{{ fmtTime(s.ts) }} · {{ s.frame }}</div>
              </div>
            </template>

            <template v-else-if="activeTab === 'log'">
              <div v-if="!logs.length" class="acx-empty">还没有日志。任务帧跑起来后会在这里汇总。</div>
              <div class="acx-log" ref="logEl">
                <div v-for="(l, i) in logs" :key="i" :class="'acx-log-' + l.level">{{ l.time }} [{{ l.module }}] {{ l.msg }}</div>
              </div>
            </template>

            <template v-else-if="activeTab === 'ai'">
              <div v-if="aiPing" class="acx-set-group">
                <div class="acx-inline" style="cursor:default"><span>{{ aiPing.title || '章节测验' }}</span><b style="margin-left:auto;color:#1E2A2F">{{ aiPing.answered || 0 }} / {{ aiPing.count || 0 }}</b></div>
                <div class="acx-inline" style="cursor:default"><span>失败</span><b style="margin-left:auto;color:#C2453A">{{ aiPing.failed || 0 }} 题</b></div>
                <div class="acx-inline" style="cursor:default"><span>提交</span><b style="margin-left:auto;color:#1E2A2F">{{ aiStateText(aiPing.submitState) }}</b></div>
                <div class="acx-inline" style="cursor:default"><span>{{ aiPing.model || '' }}</span><b style="margin-left:auto;color:#2E5A75">{{ aiPing.source || '' }}</b></div>
              </div>
              <div v-else class="acx-empty">还没有记录。测验页开始答题后，这里会显示进度。</div>
              <button class="acx-btn" style="margin-top:8px" @click="openAI">打开作答记录窗口</button>
            </template>

            <template v-else>
              <div class="acx-set-group">
                <h4>模型接口</h4>
                <div class="acx-field"><label>LLM Base URL</label><a-input v-model:value="settings['llm.base_url']" @change="saveCfg('llm.base_url')"></a-input></div>
                <div class="acx-field"><label>API Key <em>仅本机保存</em></label><a-input type="password" v-model:value="settings['llm.api_key']" @change="saveCfg('llm.api_key')"></a-input></div>
                <div class="acx-field"><label>模型</label><a-input v-model:value="settings['llm.model']" @change="saveCfg('llm.model')"></a-input></div>
                <div class="acx-field"><label>思考强度</label>
                  <div style="display:flex;gap:2px;flex-wrap:wrap">
                    <button v-for="e in effortOptions" :key="e.value" class="acx-tab" :class="{ 'acx-on': settings['llm.effort'] === e.value }" style="font-size:10px;padding:3px 9px;border:1px solid rgba(30,42,47,.24);border-radius:0" @click="setEffort(e.value)">{{ e.label }}</button>
                  </div>
                </div>
                <div class="acx-field"><label>停滞超时（秒）</label><input type="number" min="15" max="600" v-model.number="settings['llm.timeout']" @change="saveCfg('llm.timeout')"></div>
                <div class="acx-inline" @click="toggleCfg('llm.stream')">流式接收<span class="acx-toggle" :class="{ 'acx-off': !settings['llm.stream'] }"><i></i></span></div>
              </div>
              <div class="acx-set-group">
                <h4>看课</h4>
                <div class="acx-field"><label>视频倍速</label><input type="number" min="1" max="16" v-model.number="settings['video.speed']" @change="saveCfg('video.speed')"></div>
                <div class="acx-inline" @click="toggleCfg('video.mute')">静音<span class="acx-toggle" :class="{ 'acx-off': !settings['video.mute'] }"><i></i></span></div>
                <div class="acx-field"><label>翻页间隔（秒）</label><input type="number" min="1" max="10" v-model.number="settings['doc.interval']" @change="saveCfg('doc.interval')"></div>
              </div>
              <div class="acx-set-group">
                <h4>答题</h4>
                <div class="acx-inline" @click="toggleCfg('quiz.auto_fill')">自动勾选<span class="acx-toggle" :class="{ 'acx-off': !settings['quiz.auto_fill'] }"><i></i></span></div>
                <div class="acx-inline" @click="toggleCfg('quiz.auto_submit')">自动提交<span class="acx-toggle" :class="{ 'acx-off': !settings['quiz.auto_submit'] }"><i></i></span></div>
                <div class="acx-note">只有全部题目答完且解码置信度足够时才提交。</div>
                <div class="acx-inline" @click="toggleCfg('quiz.double_check')">两答一致性校验<span class="acx-toggle" :class="{ 'acx-off': !settings['quiz.double_check'] }"><i></i></span></div>
                <div class="acx-inline" @click="toggleCfg('quiz.auto_submit_work')">作业自动提交<span class="acx-toggle" :class="{ 'acx-off': !settings['quiz.auto_submit_work'] }"><i></i></span></div>
                <div class="acx-inline" @click="toggleCfg('quiz.auto_submit_practice')">随堂练习自动提交<span class="acx-toggle" :class="{ 'acx-off': !settings['quiz.auto_submit_practice'] }"><i></i></span></div>
              </div>
              <div class="acx-set-group">
                <h4>字体与调试</h4>
                <div class="acx-inline" @click="toggleCfg('llm.vision')">视觉兜底<span class="acx-toggle" :class="{ 'acx-off': !settings['llm.vision'] }"><i></i></span></div>
                <div class="acx-field"><label>参考库地址</label><a-input v-model:value="settings['font.refdb_url']" placeholder="留空=内联一级字库" @change="saveCfg('font.refdb_url')"></a-input></div>
                <div class="acx-inline" @click="toggleCfg('debug')">调试日志<span class="acx-toggle" :class="{ 'acx-off': !settings['debug'] }"><i></i></span></div>
                <button class="acx-btn" style="margin-top:4px" :disabled="testingVision" @click="testVision">{{ testingVision ? '测试中…' : '测试多模态' }}</button>
                <div class="acx-test">{{ visionResult }}</div>
                <button class="acx-btn" style="margin-top:8px" :disabled="testingLLM" @click="testLLM">{{ testingLLM ? '测试中…' : '测试 LLM 连接' }}</button>
                <div class="acx-test">{{ llmResult }}</div>
              </div>
            </template>
          </div>
          <footer class="acx-foot"><span>AutoCX v{{ version }}</span><span class="acx-foot-links"><a :href="repo.github" target="_blank" rel="noopener noreferrer">GitHub</a><a :href="repo.gitee" target="_blank" rel="noopener noreferrer">Gitee</a><a :href="repo.issues" target="_blank" rel="noopener noreferrer">反馈</a><span>MIT</span></span></footer>
        </section>
      </div>
    </a-config-provider>
  `;

  const PANEL_SETTING_KEYS = [
    'llm.base_url', 'llm.api_key', 'llm.model', 'llm.effort', 'llm.timeout', 'llm.stream',
    'video.speed', 'video.mute', 'quiz.auto_fill', 'quiz.auto_submit', 'quiz.double_check',
    'quiz.auto_submit_work', 'quiz.auto_submit_practice', 'llm.vision', 'font.refdb_url', 'doc.interval', 'debug',
  ];

  function createPanelRoot(VueLib) {
    return {
      template: PANEL_TEMPLATE,
      setup() {
        const { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } = VueLib;
        const panelOpen = ref(true);
        const activeTab = ref('status');
        const enabled = ref(isEnabled());
        const assistVideo = ref(config.get('assist.video') !== false);
        const assistQuiz = ref(config.get('assist.quiz') !== false);
        const progress = ref(0);
        const videoState = ref('待命');
        const quizState = ref('待命');
        const logs = reactive([]);
        const statuses = reactive([]);
        const aiPing = ref(null);
        const settings = reactive({});
        const panelEl = ref(null);
        const bodyEl = ref(null);
        const logEl = ref(null);
        const pos = reactive({ left: null, top: null });
        const bookmarkTop = ref(null);
        const bookmarkDragging = ref(false);
        const testingLLM = ref(false);
        const testingVision = ref(false);
        const llmResult = ref('');
        const visionResult = ref('');
        const tabs = [
          { key: 'status', label: '状态' }, { key: 'log', label: '日志' },
          { key: 'ai', label: 'AI' }, { key: 'settings', label: '设置' },
        ];
        const modelOptions = [
          { value: 'deepseek-chat', label: 'deepseek-chat' },
          { value: 'deepseek-reasoner', label: 'deepseek-reasoner' },
          { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
        ];
        const effortOptions = [
          { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' }, { value: '', label: '不发送' },
        ];
        const repo = REPO;
        const version = VERSION;
        const antdTheme = {
          token: {
            colorPrimary: '#C2453A', colorText: '#1E2A2F', colorBgContainer: '#FAFAF5',
            colorBorder: 'rgba(30,42,47,.25)', borderRadius: 2, controlHeight: 28,
            fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          },
        };
        PANEL_SETTING_KEYS.forEach((k) => { settings[k] = config.get(k); });
        try { aiPing.value = GM_getValue(AI_PING) || null; } catch (_) { aiPing.value = null; }

        const panelStyle = computed(() => {
          if (pos.left == null || pos.top == null) return {};
          return { left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto' };
        });
        const bookmarkStyle = computed(() => (bookmarkTop.value == null ? {} : { top: bookmarkTop.value + 'px' }));

        const clampBookmark = () => {
          const el = document.querySelector('#autocx-vue-root .acx-bookmark');
          if (!el) return;
          const h = el.offsetHeight || 124;
          const top = bookmarkTop.value == null ? el.getBoundingClientRect().top : bookmarkTop.value;
          const maxTop = Math.max(8, window.innerHeight - h - 8);
          const clamped = Math.min(Math.max(8, top), maxTop);
          if (bookmarkTop.value != null || clamped !== top) bookmarkTop.value = Math.round(clamped);
        };

        const startBookmarkDrag = (e) => {
          if (e.button !== 0 || e.target.closest('.acx-bm-menu')) return;
          const el = e.currentTarget;
          const startY = e.clientY;
          const rect0 = el.getBoundingClientRect();
          const startTop = rect0.top;
          const h = rect0.height;
          let moved = false;
          let lastTop = Math.round(startTop);
          const move = (ev) => {
            const dy = ev.clientY - startY;
            if (!moved && Math.abs(dy) < 5) return;
            moved = true;
            bookmarkDragging.value = true;
            lastTop = Math.round(Math.min(Math.max(8, startTop + dy), Math.max(8, window.innerHeight - h - 8)));
            bookmarkTop.value = lastTop;
          };
          const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('pointercancel', up);
            bookmarkDragging.value = false;
            if (!moved) {
              panelOpen.value = true;
              nextTick(() => { if (pos.left != null) clampIntoView(); });
            } else {
              config.set('autocx.bookmarkTop', lastTop);
            }
          };
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
          document.addEventListener('pointercancel', up);
          e.preventDefault();
        };
        const collapsePanel = () => {
          panelOpen.value = false;
          nextTick(clampBookmark);
        };

        const clampIntoView = () => {
          const el = panelEl.value;
          if (!el) return;
          const r = el.getBoundingClientRect();
          const maxLeft = Math.max(0, window.innerWidth - r.width - 8);
          const maxTop = Math.max(0, window.innerHeight - r.height - 8);
          const left = Math.min(Math.max(0, r.left), maxLeft);
          const top = Math.min(Math.max(0, r.top), maxTop);
          if (left !== r.left || top !== r.top) { pos.left = Math.round(left); pos.top = Math.round(top); }
        };

        const startDrag = (e) => {
          if (e.target.closest('button, a, input, .acx-toggle')) return;
          const el = panelEl.value;
          if (!el) return;
          const r = el.getBoundingClientRect();
          const dx = e.clientX - r.left;
          const dy = e.clientY - r.top;
          const move = (ev) => {
            const rr = el.getBoundingClientRect();
            pos.left = Math.round(Math.min(Math.max(0, ev.clientX - dx), Math.max(0, window.innerWidth - rr.width - 8)));
            pos.top = Math.round(Math.min(Math.max(0, ev.clientY - dy), Math.max(0, window.innerHeight - rr.height - 8)));
          };
          const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            config.set('autocx.ballPos', { left: pos.left, top: pos.top });
          };
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
          e.preventDefault();
        };

        const toggleMain = () => {
          enabled.value = !enabled.value;
          config.set('autocx.enabled', enabled.value);
          log.info('panel', `总开关: ${enabled.value ? '开' : '关'}`);
        };
        const toggleAssist = (kind) => {
          if (kind === 'video') { assistVideo.value = !assistVideo.value; config.set('assist.video', assistVideo.value); }
          else { assistQuiz.value = !assistQuiz.value; config.set('assist.quiz', assistQuiz.value); }
          log.info('panel', `${kind === 'video' ? '看课助手' : '答题助手'}: ${(kind === 'video' ? assistVideo.value : assistQuiz.value) ? '开' : '关'}`);
        };
        const saveCfg = (key) => {
          const v = settings[key];
          config.set(key, typeof v === 'number' ? v : v);
          log.debug('panel', `配置更新 ${key}`);
        };
        const toggleCfg = (key) => {
          settings[key] = !settings[key];
          config.set(key, settings[key]);
          log.debug('panel', `配置更新 ${key}`);
        };
        const setEffort = (e) => { settings['llm.effort'] = e; saveCfg('llm.effort'); };
        const testLLM = () => {
          testingLLM.value = true; llmResult.value = '测试中…';
          llm.test().then((msg) => { llmResult.value = '✅ ' + msg; })
            .catch((e) => { llmResult.value = '❌ ' + e.message; })
            .finally(() => { testingLLM.value = false; });
        };
        const testVision = () => {
          testingVision.value = true; visionResult.value = '测试中…';
          visionSelfCheck().then((msg) => { visionResult.value = '✅ ' + msg; })
            .catch((e) => { visionResult.value = '❌ ' + e.message; })
            .finally(() => { testingVision.value = false; });
        };
        const openAI = () => { try { AIW.ensure().open(); } catch (e) { log.error('panel', '打开作答记录失败: ' + e.message); } };
        const fmtTime = (ts) => (ts ? new Date(ts).toTimeString().slice(0, 8) : '');
        const aiStateText = (st) => ({
          off: '自动提交 关', wait: '等待答完', ready: '即将提交', done: '已提交',
          blocked: '未提交（有未答题）', captcha: '未提交（验证码）',
        }[st] || '自动提交 关');

        const pushLog = (item) => {
          logs.push({ time: fmtTime(item.ts), level: item.level || 'info', module: item.module || '', msg: item.msg || '' });
          if (logs.length > 200) logs.splice(0, logs.length - 200);
          if (activeTab.value === 'log') nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
        };
        const pushStatus = (item) => {
          statuses.unshift(item);
          if (statuses.length > 20) statuses.splice(20);
          const detail = item.detail || '';
          if (item.module === 'video' || item.module === 'doc' || item.module === 'knowledge') {
            videoState.value = detail || item.state || '待命';
          }
          if (item.module === 'quiz' || item.module === 'practice') quizState.value = detail || item.state || '待命';
          if (item.module === 'video') {
            const m = detail.match(/(\d+)%/);
            if (item.state === 'playing' && m) progress.value = Number(m[1]);
            if (item.state === 'done') progress.value = 100;
          }
        };

        const onResize = () => { clampIntoView(); clampBookmark(); };

        let offs = [];
        onMounted(() => {
          const saved = config.get('autocx.ballPos');
          if (saved && saved.left != null) { pos.left = saved.left; pos.top = saved.top; }
          const savedBookmark = config.get('autocx.bookmarkTop');
          if (savedBookmark != null) bookmarkTop.value = Number(savedBookmark);
          try { offs.push(GM_addValueChangeListener(LOG_KEY, (_k, _o, nv, remote) => { if (remote && nv) pushLog(nv); })); } catch (_) { /* 忽略 */ }
          try { offs.push(GM_addValueChangeListener(STATUS_KEY, (_k, _o, nv, remote) => { if (remote && nv) pushStatus(nv); })); } catch (_) { /* 忽略 */ }
          try { offs.push(GM_addValueChangeListener(AI_PING, (_k, _o, nv, remote) => { if (remote && nv) aiPing.value = nv; })); } catch (_) { /* 忽略 */ }
          window.addEventListener('resize', onResize);
          nextTick(() => { if (pos.left != null) clampIntoView(); clampBookmark(); });
        });
        onBeforeUnmount(() => {
          offs.forEach((id) => { try { GM_removeValueChangeListener(id); } catch (_) { /* 忽略 */ } });
          offs = [];
          window.removeEventListener('resize', onResize);
        });

        return {
          panelOpen, activeTab, enabled, assistVideo, assistQuiz, progress, videoState, quizState,
          logs, statuses, aiPing, settings, panelEl, bodyEl, logEl, tabs, modelOptions, effortOptions, repo, version,
          antdTheme, panelStyle, bookmarkStyle, bookmarkDragging, startBookmarkDrag, startDrag, collapsePanel, toggleMain, toggleAssist, saveCfg, toggleCfg, setEffort,
          testLLM, testVision, openAI, fmtTime, aiStateText, testingLLM, testingVision, llmResult, visionResult,
        };
      },
    };
  }

  /* ============================== 通用:完成检测 =========================== */
  // 任务点完成时,学习通会在任务帧页面内显示"任务点已完成"标签
  function isJobDone() {
    try { return /任务点已完成/.test(document.body.innerText); } catch (_) { return false; }
  }
  /** 轮询检测完成,完成后回调(只触发一次) */
  function onJobDone(module, cb) {
    const timer = setInterval(() => {
      if (isJobDone()) {
        clearInterval(timer);
        log.info(module, '检测到任务点已完成');
        report(module, 'done', '任务点已完成');
        cb();
      }
    }, 2000);
    return () => clearInterval(timer);
  }

  /* ============================== doc-frame =============================== */
  // PPT/PDF: 找"下一页"按钮循环点击;图书/长图: 滚动到底。完成即停。
  function initDocFrame() {
    const module = 'doc';
    if (config.get('assist.video') === false) {
      log.info(module, '看课助手已关闭,跳过');
      report(module, 'disabled', '看课助手已关闭');
      return;
    }
    report(module, 'start', '文档/课件任务,开始自动完成');
    log.info(module, '文档任务启动');
    let stopped = false;
    const stop = onJobDone(module, () => { stopped = true; clearInterval(timer); });

    const base = Math.max(1, Number(config.get('doc.interval')) || 2) * 1000;
    const timer = setInterval(() => {
      if (stopped || !isEnabled()) return;
      // 1) 优先点"下一页"
      const next = $(SELECTORS.doc.nextPage).filter(':visible').get(0);
      if (next) {
        next.click();
        log.debug(module, '点击下一页');
        return;
      }
      // 2) 否则滚动加载(图书/长图查看器滚到底即完成)
      if ((window.scrollY + window.innerHeight) < document.documentElement.scrollHeight - 10) {
        window.scrollBy(0, Math.round(window.innerHeight * 0.8));
        log.debug(module, '滚动翻页');
      }
    }, base + Math.round(Math.random() * 1500));

    // 页面卸载时清理
    window.addEventListener('beforeunload', stop);
  }

  /* ============================== top: 自动推进 =========================== */
  // 目录中当前章节出现 .icon_Completed 即视为完成 -> 点击其后第一个未完成章节。
  // 同时兼容任务帧上报的 done 状态(章节含多个任务点时以目录标记为准)。
  function initTopAdvance() {
    let advancing = false;

    const tryAdvance = (source) => {
      if (advancing || !isEnabled()) return;
      const $active = $('.posCatalog_select.posCatalog_active');
      if (!$active.length) return;
      const chapterDone = $active.find('.icon_Completed').length > 0;
      if (source !== 'done-event' && !chapterDone) return; // 周期检查只看目录标记
      advancing = true;
      setTimeout(() => {
        try {
          const $items = $('.posCatalog_select');
          const $cur = $('.posCatalog_select.posCatalog_active');
          const idx = $items.index($cur.get(0));
          let clicked = false;
          for (let i = idx + 1; i < $items.length; i++) {
            const $it = $items.eq(i);
            // 跳过分节标题(firstLayer:如"4 造型艺术"这类章标题,没有任务点)
            if ($it.hasClass('firstLayer') || $it.find('.posCatalog_name').length === 0) continue;
            if (!$it.find('.icon_Completed').length) {
              const nameEl = $it.find('.posCatalog_name').get(0);
              // 未解锁的章节没有 onclick(点了也不会加载),跳过
              if (!nameEl || !nameEl.getAttribute('onclick')) continue;
              nameEl.click();
              const title = $it.text().replace(/\s+/g, ' ').trim().slice(0, 40);
              log.info('advance', '切换到: ' + title);
              report('advance', 'next', title);
              clicked = true;
              break;
            }
          }
          if (!clicked) {
            const locked = $('.posCatalog_select').filter(function () {
              const $n = $(this).find('.posCatalog_name');
              return $n.length && !$n.get(0).getAttribute('onclick');
            }).length;
            if (locked) {
              log.warn('advance', '剩余章节未解锁,无法继续自动学习(需先完成当前章节的人工任务点)');
              report('advance', 'locked', '剩余章节未解锁,需人工完成当前章节');
            } else {
              log.info('advance', '后面没有未完成任务了 🎉');
              report('advance', 'all-done', '全部任务已完成');
            }
          }
        } catch (e) {
          log.error('advance', '自动推进失败: ' + e.message);
        } finally {
          setTimeout(() => { advancing = false; }, 6000); // 防抖,等待页面切换
        }
      }, 1500 + Math.round(Math.random() * 1500));
    };

    // 1) 周期检查目录完成标记(权威依据)
    setInterval(() => tryAdvance('poll'), 4000);
    // 2) 章内任务点切换:任务帧完成 -> 点击下一个任务标签(视频 -> 章节测验…)
    let taskSwitching = false;
    // 整章兜底:本章任务点跑完但平台仍没标完成(有只能人工做的任务点)时,别卡死在这一章
    let lastForceChapter = 0;
    const forceNextChapter = (reason) => {
      const now = Date.now();
      if (now - lastForceChapter < 45000) return; // 45 秒内不重复强推
      lastForceChapter = now;
      const skipToNext = () => {
        const $cur = $('.posCatalog_select.posCatalog_active');
        if (!$cur.length) return;
        if ($cur.find('.icon_Completed').length) { tryAdvance('poll'); return; } // 已完成,走正常流程
        const $items = $('.posCatalog_select');
        const idx = $items.index($cur.get(0));
        for (let i = idx + 1; i < $items.length; i++) {
          const $it = $items.eq(i);
          if ($it.hasClass('firstLayer') || $it.find('.posCatalog_name').length === 0) continue;
          if (!$it.find('.icon_Completed').length) {
            const nameEl = $it.find('.posCatalog_name').get(0);
            if (!nameEl || !nameEl.getAttribute('onclick')) continue; // 未解锁,点不动
            const title = $it.text().replace(/\s+/g, ' ').trim().slice(0, 40);
            nameEl.click();
            log.info('advance', '本章仍未标记完成(' + reason + '),继续下一章: ' + title);
            report('advance', 'next-chapter-skip', '继续下一章: ' + title);
            return;
          }
        }
        const locked = $('.posCatalog_select').filter(function () {
          const $n = $(this).find('.posCatalog_name');
          return $n.length && !$n.get(0).getAttribute('onclick');
        }).length;
        if (locked) {
          log.warn('advance', '本章有需人工完成的任务点,后续章节未解锁,自动学习到此为止');
          report('advance', 'locked', '后续章节未解锁,需人工完成当前章节');
        } else {
          log.info('advance', '后面没有未完成章节了 🎉');
          report('advance', 'all-done', '全部章节已完成');
        }
      };
      // 先给平台留出标记完成的时间(10~13s),还没标完成再等一轮(15s)才跳过
      setTimeout(() => {
        try {
          const $cur = $('.posCatalog_select.posCatalog_active');
          if ($cur && $cur.find('.icon_Completed').length) { tryAdvance('poll'); return; }
        } catch (e) { log.error('advance', '章节状态检查失败: ' + e.message); }
        setTimeout(() => {
          try { skipToNext(); } catch (e) { log.error('advance', '章节推进失败: ' + e.message); }
        }, 15000);
      }, 10000 + Math.round(Math.random() * 3000));
    };
    const tryNextTask = (reason) => {
      if (taskSwitching || !isEnabled()) return;
      const $tabs = $('li[onclick*="changeDisplayContent"]');
      if ($tabs.length < 2) { forceNextChapter(reason || '任务'); return; } // 单任务章节,交给整章推进
      const cur = $tabs.index($tabs.filter('.active').get(0));
      if (cur < 0) return; // 页面正在切换,等下一轮
      const $next = $tabs.eq(cur + 1);
      if (!$next.length) { forceNextChapter(reason || '任务'); return; } // 已是最后一个任务,交给整章推进
      taskSwitching = true;
      setTimeout(() => {
        try {
          $next.get(0).click();
          const title = $next.text().replace(/\s+/g, ' ').trim();
          log.info('advance', '切换到本章下一任务: ' + title);
          report('advance', 'next-task', title);
        } catch (e) {
          log.error('advance', '任务切换失败: ' + e.message);
        } finally {
          setTimeout(() => { taskSwitching = false; }, 6000);
        }
      }, 1500 + Math.round(Math.random() * 1500));
    };
    // 3) 任务帧事件:knowledge 帧的完成标记(权威) / 视频 ended(兜底) / 只能人工的任务点(跳过)
    //    只处理"当前章节"的事件:GM 存储是全局的,别的标签页/别的章节的任务帧也会往里写。
    const currentChapterId = () => {
      try {
        const el = document.querySelector('.posCatalog_select.posCatalog_active .posCatalog_name');
        const oc = (el && el.getAttribute('onclick')) || '';
        const m = oc.match(/getTeacherAjax\('[^']*','[^']*','(\d+)'\)/);
        if (m) return m[1];
        const q = location.search.match(/chapterId=(\d+)/);
        return q ? q[1] : null;
      } catch (_) { return null; }
    };
    const eventMatchesChapter = (nv) => {
      const cur = currentChapterId();
      if (!cur) return true;                       // 取不到当前章节 -> 不做过滤
      const href = String((nv && nv.href) || '');
      if (!href) return true;                     // 旧版本事件没有 href -> 放行
      const kid = href.match(/knowledgeid=(\d+)/);
      if (kid) return kid[1] === cur;
      const cid = href.match(/chapterId=(\d+)/);
      if (cid) return cid[1] === cur;
      return true;                                // 帧 URL 里没有章节信息(如视频帧) -> 放行
    };
    GM_addValueChangeListener(STATUS_KEY, (_k, _o, nv, remote) => {
      if (!remote || !nv) return;
      if (!eventMatchesChapter(nv)) return;
      if (nv.state === 'job-done' || nv.state === 'done' ||
          nv.state === 'job-idle' || nv.state === 'submitted') {
        tryNextTask(nv.state);
      }
      // 视频帧没找到 video 元素(播放器挂了)也别死等,换下一个任务点
      if (nv.module === 'video' && nv.state === 'error') tryNextTask('video-error');
      if (nv.state === 'done') tryAdvance('done-event');
    });
  }

  /* ==================== 字体反混淆: font-cxsecret ========================= */
  // 超星把题干/选项里的一部分汉字换成「密文码点」，页面用内嵌字体 font-cxsecret
  // 把密文字形画成真字形 —— 所以屏幕上是对的、复制出来是乱的。
  // 这里在浏览器里把密文字渲染成 24×24 位图，与随脚本发布的参考字形库做 IoU 匹配，
  // 还原成明文。设计与数据见 docs/superpowers/specs/2026-11-19-quiz-font-deobfuscation.md
  //
  // >>> AUTOCX-FONTDEC-BEGIN
  function createFontDeobfuscator(deps) {
    const doc = deps.doc;
    const log = deps.log || { warn() {}, info() {}, debug() {} };
    const SIZE = deps.size || 24;
    const NWORDS = (SIZE * SIZE) / 32;
    const PER_ROW = Math.ceil(SIZE / 8);
    const STRIDE = PER_ROW * SIZE;
    const PX = deps.renderPx || 96;
    const minScore = deps.minScore === undefined ? 0.55 : deps.minScore;
    const minMargin = deps.minMargin === undefined ? 0.06 : deps.minMargin;

    let db = null;
    let family = '';
    let map = null;
    let stats = null;
    let canvas = null;
    let ctx = null;
    let small = null;
    let sctx = null;
    let tofuBits = null;

    function b64ToBytes(b64) {
      const bin = atob(String(b64 || ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function popcnt(v) {
      v = v - ((v >> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
      return (((v + (v >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
    }

    /** 参考库 {v,size,lo,hi,count,perRow,cpMask,bits} -> 可匹配结构 */
    function unpackDb(meta) {
      if (!meta || !meta.bits) throw new Error('参考库缺少 bits');
      if (meta.size !== SIZE) throw new Error(`参考库尺寸不符: ${meta.size} != ${SIZE}`);
      const mask = b64ToBytes(meta.cpMask);
      const cps = [];
      const total = meta.hi - meta.lo + 1;
      for (let i = 0; i < total; i++) {
        if ((mask[i >> 3] >> (7 - (i & 7))) & 1) cps.push(meta.lo + i);
      }
      const bits = b64ToBytes(meta.bits);
      if (bits.length !== cps.length * STRIDE) {
        throw new Error(`参考库长度不符: ${bits.length} != ${cps.length * STRIDE}`);
      }
      const words = new Uint32Array(cps.length * NWORDS);
      for (let g = 0; g < cps.length; g++) {
        const base = g * STRIDE;
        const wbase = g * NWORDS;
        for (let y = 0; y < SIZE; y++) {
          for (let bx = 0; bx < PER_ROW; bx++) {
            const byte = bits[base + y * PER_ROW + bx];
            if (!byte) continue;
            for (let k = 0; k < 8; k++) {
              if (!((byte >> (7 - k)) & 1)) continue;
              const idx = y * SIZE + bx * 8 + k;
              if (idx < SIZE * SIZE) words[wbase + (idx >> 5)] |= 1 << (idx & 31);
            }
          }
        }
      }
      const byCp = new Map();
      cps.forEach((cp, i) => byCp.set(cp, i));
      return { count: cps.length, cps: Int32Array.from(cps), words: words, byCp: byCp };
    }

    function ensureCanvas() {
      if (canvas) return;
      canvas = doc.createElement('canvas');
      canvas.width = PX;
      canvas.height = PX;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      small = doc.createElement('canvas');
      small.width = SIZE;
      small.height = SIZE;
      sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
    }

    /** 用页面字体渲染 ch -> SIZE×SIZE 二值位图；字体里没有这个字形返回 null */
    function renderBits(ch) {
      ensureCanvas();
      ctx.clearRect(0, 0, PX, PX);
      ctx.font = PX + 'px ' + (family ? '"' + family + '"' : 'sans-serif');
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#000';
      ctx.fillText(ch, 2, 2);
      const img = ctx.getImageData(0, 0, PX, PX).data;
      let minX = PX, minY = PX, maxX = -1, maxY = -1;
      for (let y = 0; y < PX; y++) {
        for (let x = 0; x < PX; x++) {
          if (img[(y * PX + x) * 4 + 3] > 127) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      sctx.clearRect(0, 0, SIZE, SIZE);
      sctx.drawImage(canvas, minX, minY, maxX - minX + 1, maxY - minY + 1, 0, 0, SIZE, SIZE);
      const px = sctx.getImageData(0, 0, SIZE, SIZE).data;
      const bits = new Uint8Array(SIZE * SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) bits[i] = px[i * 4 + 3] > 127 ? 1 : 0;
      return bits;
    }

    function packQuery(bits) {
      const w = new Uint32Array(NWORDS);
      for (let i = 0; i < SIZE * SIZE; i++) if (bits[i]) w[i >> 5] |= 1 << (i & 31);
      return w;
    }

    function sameBits(a, b) {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    function matchQuery(qw, selfIdx) {
      const words = db.words;
      let best = 0, bestScore = 0, second = 0, selfScore = -1;
      for (let g = 0; g < db.count; g++) {
        const base = g * NWORDS;
        let inter = 0, uni = 0;
        for (let w = 0; w < NWORDS; w++) {
          const a = qw[w];
          const b = words[base + w];
          inter += popcnt(a & b);
          uni += popcnt(a | b);
        }
        const s = uni ? inter / uni : 0;
        if (g === selfIdx) selfScore = s;
        if (s > bestScore) { second = bestScore; bestScore = s; best = g; }
        else if (s > second) second = s;
      }
      return { cp: db.cps[best], score: bestScore, margin: bestScore - second, selfScore: selfScore };
    }

    /** 页面里到底用哪个字体族（形如 font-cxsecret） */
    function pickFamily() {
      let els = [];
      try { els = doc.querySelectorAll(deps.cipherSelector || '[class*="cxsecret"], [style*="cxsecret"]'); } catch (e) { return ''; }
      for (const el of els) {
        let f = '';
        try { f = doc.defaultView.getComputedStyle(el).fontFamily || ''; } catch (e) { continue; }
        const m = f.match(/([A-Za-z0-9_-]*cxsecret[A-Za-z0-9_-]*)/i);
        if (m) return m[1];
      }
      return '';
    }

    /** 收集这些节点里出现的 CJK 字符（明文/密文都会进来，靠"有没有字形"筛掉明文） */
    function collectChars() {
      const set = new Set();
      let nodes = 0;
      let els = [];
      try { els = doc.querySelectorAll(deps.cipherSelector || '[class*="cxsecret"], [style*="cxsecret"]'); } catch (e) {}
      for (const el of els) {
        nodes += 1;
        const t = el.textContent || '';
        for (const ch of t) {
          const cp = ch.codePointAt(0);
          if (cp >= 0x3400 && cp <= 0x9FFF) set.add(cp);
        }
      }
      return { set, nodes };
    }

    /** 建立映射。返回 {ok, reason?, ...} */
    async function build() {
      const t0 = Date.now();
      if (!db) db = unpackDb(deps.refDb);
      family = pickFamily();
      if (!family) return { ok: false, reason: 'no-font' };

      const { set, nodes } = collectChars();
      if (!set.size) return { ok: false, reason: 'no-chars' };

      // 确保这一家族里"这些字"的字形已经加载完（否则 canvas 会画成 tofu）
      const sampleText = Array.from(set).slice(0, 300).map((cp) => String.fromCodePoint(cp)).join('');
      try { await doc.fonts.load(PX + 'px "' + family + '"', sampleText); } catch (e) { /* 忽略 */ }
      try { await doc.fonts.ready; } catch (e) { /* 忽略 */ }

      map = new Map();
      tofuBits = renderBits('\uE000');
      let decoded = 0, low = 0, missing = 0, plain = 0;
      const lowChars = [];
      for (const cp of set) {
        const bits = renderBits(String.fromCodePoint(cp));
        if (!bits || (tofuBits && sameBits(bits, tofuBits))) { missing += 1; continue; }
        const m = matchQuery(packQuery(bits), db.byCp.has(cp) ? db.byCp.get(cp) : -1);
        // 匹配到自己(或与最优几乎打平) = 这个字本来就是明文(字体里也有它)，
        // 不该计入"密文字"分母,否则整题置信度会被这些明文虚低。
        const self = m.selfScore >= 0 && m.selfScore >= m.score - 0.02;
        const good = self || (m.score >= minScore && m.margin >= minMargin);
        map.set(cp, { cp: m.cp, score: m.score, margin: m.margin, ok: good, self: self });
        if (self) plain += 1;
        else if (good) decoded += 1;
        else { low += 1; if (lowChars.length < 12) lowChars.push(String.fromCodePoint(cp)); }
      }
      stats = {
        family, nodes, chars: set.size, plain: plain,
        cipher: set.size - missing - plain, decoded, low, missing,
        lowChars: lowChars.join(''), ms: Date.now() - t0,
      };
      return Object.assign({ ok: true }, stats);
    }

    /** 解码一段文本；conf = 密文字里高置信还原的比例 */
    function decode(text) {
      const src = String(text || '');
      if (!map || !map.size) return { text: src, conf: 1, mapped: 0, total: 0, unknown: '' };
      let mapped = 0, total = 0;
      let out = '';
      const unknown = [];
      for (const ch of src) {
        const m = map.get(ch.codePointAt(0));
        if (!m || m.self) { out += ch; continue; }   // 明文(匹配到自己)原样保留
        total += 1;
        if (m.ok) { out += String.fromCodePoint(m.cp); mapped += 1; }
        else { out += ch; unknown.push(ch); }
      }
      return { text: out, conf: total ? mapped / total : 1, mapped, total, unknown: unknown.join('') };
    }

    function info() { return stats || { ok: false, reason: 'not-built' }; }
    /** 低置信(有字形但不敢定)的密文字，供视觉兜底 */
    function lowList() {
      const out = [];
      if (!map) return out;
      map.forEach((v, k) => {
        if (!v.ok && !v.self) out.push({ cp: k, best: v.cp, score: +v.score.toFixed(3), margin: +v.margin.toFixed(3) });
      });
      return out;
    }
    /** 视觉结果回填：和位图最优解一致才算数，冲突则保持"未解码" */
    function applyVision(cipherCp, plainCp) {
      const m = map && map.get(cipherCp);
      if (!m) return false;
      if (plainCp && plainCp === m.cp) { m.ok = true; m.vision = 'agree'; return true; }
      m.vision = 'conflict';
      return false;
    }
    function charMap() {
      const out = {};
      if (map) map.forEach((v, k) => { out[k] = { cp: v.cp, score: +v.score.toFixed(3), margin: +v.margin.toFixed(3), ok: v.ok }; });
      return out;
    }

    return { build, decode, info, charMap, lowList, applyVision, get family() { return family; } };
  }
  // <<< AUTOCX-FONTDEC-END

  // ---- 参考字形库的加载（内联 gzip -> @require 内联 -> GM 缓存 -> 远程拉取） ----
  // 下面这段由 tools/inject_refdb.py 注入：gzip 后的紧凑位图库（一级常用字 3755）。
  // 内联的意义是"断网也能解码"；想要全量 6763 字，把 font.refdb_url 指向 refdb-24.js 即可。
  // >>> AUTOCX-REFDB-INLINE
  const REFDB_GZ = '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'; // 内联位图库：272973 B -> gzip 159351 B -> base64 212468 B
  // <<< AUTOCX-REFDB-INLINE
  const REFDB_META = { v: 1, size: 24, lo: 0x4E00, hi: 0x9FA5 };
  const REFDB_KEY = 'autocx.refdb.v1';
  let refDbMemo = null;

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  /** 解开内联的 gzip 位图库（Chrome 103+ 有 DecompressionStream） */
  async function inflateInlineRefDb() {
    if (!REFDB_GZ) return null;
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持 DecompressionStream');
    const gz = b64ToBytes(REFDB_GZ);
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
    const bin = new Uint8Array(await new Response(stream).arrayBuffer());
    const maskLen = Math.ceil((REFDB_META.hi - REFDB_META.lo + 1) / 8);
    return Object.assign({}, REFDB_META, {
      cpMask: bytesToB64(bin.subarray(0, maskLen)),
      bits: bytesToB64(bin.subarray(maskLen)),
    });
  }

  function loadRefDb() {
    if (refDbMemo) return Promise.resolve(refDbMemo);
    let inline = null;
    try { inline = (typeof unsafeWindow !== 'undefined' ? unsafeWindow.__CX_REFDB : null) || (typeof window !== 'undefined' ? window.__CX_REFDB : null); } catch (e) { /* 忽略 */ }
    if (inline && inline.bits) { refDbMemo = inline; return Promise.resolve(inline); }
    if (REFDB_GZ) {
      return inflateInlineRefDb().then((meta) => {
        refDbMemo = meta;
        log.info('fontdec', `内联参考库就绪（${meta.hi - meta.lo + 1} 字区间，${(REFDB_GZ.length / 1024).toFixed(0)} KB base64）`);
        return meta;
      }).catch((e) => {
        log.warn('fontdec', '内联参考库解压失败: ' + e.message);
        return loadRefDbRemote();
      });
    }
    return loadRefDbRemote();
  }

  function loadRefDbRemote() {
    try {
      const cached = GM_getValue(REFDB_KEY);
      if (cached && cached.bits) { refDbMemo = cached; return Promise.resolve(cached); }
    } catch (e) { /* 忽略 */ }
    const url = config.get('font.refdb_url');
    if (!url) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 30000,
          onload(res) {
            try {
              const txt = String(res.responseText || '');
              const m = txt.match(/\{[\s\S]*\}/);
              const meta = JSON.parse(m ? m[0] : txt);
              if (!meta || !meta.bits) throw new Error('格式不符');
              refDbMemo = meta;
              try { GM_setValue(REFDB_KEY, meta); } catch (_) { /* 太大就只留内存 */ }
              resolve(meta);
            } catch (e) {
              log.warn('fontdec', '参考库解析失败: ' + e.message);
              resolve(null);
            }
          },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      } catch (e) {
        log.warn('fontdec', '拉取参考库失败: ' + e.message);
        resolve(null);
      }
    });
  }

  /* ============================== 答题公共件 ============================= */
  // 章节测验(doHomeWorkNew)与随堂练习(answerQuestion2)共用:
  //   - buildPrompt / normalizeLetters / parseAnswer:纯函数,无 DOM 依赖
  //     (test/parse-answer.test.js 会抽取它们做回归,勿引入外部变量)
  //   - htmlToText:把接口里的 HTML 题干/选项压成纯文本
  // 注:随堂练习的题干/选项本身就是明文(该页无字体混淆),故这里不需要解码。

  function htmlToText(html) {
    return String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- Prompt 构建 ---------- */
  // 解码成功就直接给明文 —— 以前那句"形近乱码请推断"是错误先验,会把模型带进瞎猜。
  function buildPrompt(q) {
    const typeName = { single: '单选题', multi: '多选题', judge: '判断题', blank: '填空题', subjective: '简答题' }[q.type];
    let p = `请回答下面这道${typeName}。\n题目:${q.stem}\n`;
    const unknown = (q.decode && q.decode.unknown) || '';
    if (unknown) {
      p += `(个别字符未能还原:${unknown};若不影响理解请忽略,否则按上下文推断)\n`;
    }
    if (q.type === 'judge') {
      // 判断题的选项文案各平台不一(有的"对/错",有的"正确/错误"),
      // 但语义固定:A=正确、B=错误。统一写死,免得模型拿到"对/错"猜错。
      p += 'A、正确\nB、错误\n';
    } else if (q.options.length) {
      p += q.options.map((o) => `${o.label}、${o.text}`).join('\n') + '\n';
    }
    if (q.type === 'blank') {
      const n = Number(q.blankCount || 0);
      p += n > 1 ? `要求:直接给出每个空的答案,共 ${n} 个空,用|分隔,不要任何解释。\n`
        : '要求:直接给出每个空的答案,多空用|分隔,不要任何解释。\n';
    } else if (q.type === 'multi') {
      // 多选题有时平台限了项数(如"至少2项最多4项"),提交时会校验,得告诉模型
      const lim = q.limits || null;
      if (lim && (lim.min || lim.max)) {
        const parts = [];
        if (lim.min > 0) parts.push(`至少选 ${lim.min} 项`);
        if (lim.max > 0) parts.push(`最多选 ${lim.max} 项`);
        if (parts.length) p += `要求:这是多选题,${parts.join(',')},只回复所有正确选项的字母(如 BCD),不要任何解释。\n`;
        else p += '要求:这是多选题,只回复所有正确选项的字母(如 BCD),不要任何解释。\n';
      } else {
        p += '要求:这是多选题,只回复所有正确选项的字母(如 BCD),不要任何解释。\n';
      }
    } else if (q.type === 'subjective') {
      p += '要求:直接写出答案要点(可分条),不要输出选项字母,不要复述题目。\n';
    } else {
      p += '要求:只回复正确选项的字母(如 B),不要任何解释。\n';
    }
    return p;
  }

  /* ---------- 答案规范化:全角转半角,兼容 BCD / B,C,D / B、C、D / B C D / 带解释 ---------- */
  function normalizeLetters(raw) {
    if (!raw) return '';
    // 全角字母转半角
    let text = String(raw).replace(/[Ａ-Ｇａ-ｇ]/g, (c) => {
      const code = c.charCodeAt(0);
      return String.fromCharCode(code >= 0xFF41 ? code - 0xFF41 + 97 : code - 0xFF21 + 65);
    }).toUpperCase();
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    // 1) 从后往前找"纯答案行"(可带"答案:"前缀,只含字母与分隔符)
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(?:答案[:：是\s]*)?([A-G](?:[\s,，、;；·]*[A-G])*)[。.]?$/);
      if (m) return m[1].replace(/[^A-G]/g, '');
    }
    // 2) 行尾答案: "...所以选 BCD" / "answer: BCD"
    const tail = text.match(/([A-G](?:[\s,，、;；]*[A-G])+|\b[A-G]\b)\s*[。.]?\s*$/);
    if (tail) return tail[1].replace(/[^A-G]/g, '');
    // 3) 兜底:全文本字母去重排序(可能混入解释里的字母,仅保底)
    return [...new Set(text.match(/[A-G]/g) || [])].sort().join('');
  }

  /* ---------- 答案解析 ---------- */
  function parseAnswer(q, raw) {
    const text = String(raw || '').trim();
    if (q.type === 'subjective') {
      // 主观题:答案就是文本本身,只剥掉"答案:"这类前缀
      const body = text.replace(/^\s*(答案|参考答案|Answer)\s*[:：]\s*/i, '').trim();
      return body
        ? { ok: true, display: body.slice(0, 200), text: body, normalized: body }
        : { ok: false, display: text.slice(0, 30), normalized: '' };
    }
    if (q.type === 'blank') {
      const parts = text.split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
      return parts.length
        ? { ok: true, display: parts.join(' | '), blanks: parts, normalized: parts.join('|') }
        : { ok: false, display: text.slice(0, 30), normalized: '' };
    }
    const norm = normalizeLetters(text);
    if (!norm) {
      // 判断题有时模型直接答"对/错""正确/错误""True/False",而不是字母。
      // 这时按选项文本反查对应的字母。
      if ((q.type === 'judge' || q.type === 'single') && (q.options || []).length) {
        const raw = String(text).replace(/\s+/g, '').toLowerCase();
        const hit = q.options.find((o) => {
          const t = String(o.text || '').replace(/\s+/g, '').toLowerCase();
          return t && (raw === t || raw.includes(t));
        });
        if (hit && hit.label) {
          const L = String(hit.label).trim().toUpperCase();
          if (/^[A-G]$/.test(L)) {
            return { ok: true, display: L, letters: [L], normalized: L };
          }
        }
      }
      return { ok: false, display: text.slice(0, 30), normalized: '' };
    }
    if (q.type === 'single' || q.type === 'judge') {
      const letter = norm[0];
      return { ok: true, display: letter, letters: [letter], normalized: letter };
    }
    // 多选:保留完整字母序列(排序规范化,填写用 includes 判断与顺序无关)
    const sorted = norm.split('').sort().join('');
    return { ok: true, display: sorted, letters: sorted.split(''), normalized: sorted };
  }

  /* ============================== quiz-page =============================== */
  // 章节测验/作业: 接口劫持/DOM 提取题目 -> 字体解码 -> LLM -> 自动勾选 -> 条件自动提交
  function initQuizPage() {
    const module = 'quiz';
    if (config.get('assist.quiz') === false) {
      log.info(module, '答题助手已关闭,跳过');
      report(module, 'disabled', '答题助手已关闭');
      return;
    }
    report(module, 'start', '检测到测验页面');
    log.info(module, '测验页面启动');

    // 章节测验 vs 作业:两者同一个 doHomeWorkNew 页面,靠页面文案区分。
    // 作业常见"只能提交一次",所以提交策略分家(quiz.auto_submit_work 默认关)。
    function isWorkPage() {
      try {
        const t = String(document.title || '') + ' ' +
          String(document.body ? document.body.innerText.slice(0, 1500) : '');
        if (/章节测验|Chapter Quiz/i.test(t)) return false;
        return /作业|Homework|Assignment/i.test(t);
      } catch (e) { return false; }
    }

    /**
     * 是否存在"可见的提交入口"。
     * 2026 版章节测验的提交按钮是 <a onclick="btnBlueSubmit()">,选择器里没有;
     * 而弹窗里的 OK 按钮(#submitBack 内)虽然文案含 submit,但默认隐藏,不能算。
     * 故这里除 CSS 选择器外,再按"可见 + 文案是提交/交卷/Submit"兜底找一次。
     */
    function hasVisibleSubmit() {
      if ($(SELECTORS.quiz.submit).filter(':visible').length > 0) return true;
      const hit = Array.prototype.some.call(
        document.querySelectorAll('a, button, div, span'),
        (el) => {
          if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
          const t = (el.textContent || '').trim();
          if (!/^(提交|交卷|Submit|提交作业)$/i.test(t)) return false;
          const oc = el.getAttribute('onclick') || '';
          return /submit/i.test(oc) || /btnBlueSubmit/.test(oc);
        }
      );
      return hit;
    }

    /** 找到可见的提交按钮(与 hasVisibleSubmit 同一套判定,只是返回元素) */
    function findSubmitBtn() {
      const byCss = $(SELECTORS.quiz.submit).filter(':visible').get(0);
      if (byCss) return byCss;
      return Array.prototype.find.call(
        document.querySelectorAll('a, button, div, span'),
        (el) => {
          if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
          const t = (el.textContent || '').trim();
          if (!/^(提交|交卷|Submit|提交作业)$/i.test(t)) return false;
          const oc = el.getAttribute('onclick') || '';
          return /submit/i.test(oc) || /btnBlueSubmit/.test(oc);
        }
      ) || null;
    }

    /** 页面状态机:先看"还能不能交",再看标记,拿不准就返回 unknown(不动手) */
    function detectWorkState() {
      const body = String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
      const statusText = (() => {
        const el = document.querySelector('.testTit_status');
        return el ? String(el.innerText || '').trim() : '';
      })();
      const pyFlag = (() => {
        const i = document.querySelector('input[name=pyFlag]');
        return i ? String(i.value || '').trim() : '';
      })();
      // 已作答题数:只数真正带答案的隐藏域。
      // 注意 answerId 是"答卷 id"、answertype 是题型标记,都不是某题的答案,不能计入。
      const answered = Array.from(document.querySelectorAll('input[type=hidden][name^=answer]'))
        .filter((i) => /^answer\d+$/i.test(String(i.name || '')) && String(i.value || '').trim()).length;
      let hasSubmit = false;
      try { hasSubmit = hasVisibleSubmit(); } catch (e) { hasSubmit = false; }
      const base = { answered: answered, statusText: statusText, pyFlag: pyFlag };
      if (hasSubmit) return Object.assign({ state: answered ? 'draft' : 'todo' }, base);
      // 页面已过截止时间:认中英文两种文案
      // (2026 版是英文 "expired，Unable to answer";中文页是"已过期/不允许作答")
      // 注意不能只匹配"截止/Deadline"——未开放的测验也会显示截止时间,会误判成已截止。
      if (/已过期|不允许作答|无法作答|不允许提交|已关闭|逾期|expired|unable to answer|not\s+allowed\s+to\s+answer/i.test(body)) {
        return Object.assign({ state: 'closed' }, base);
      }
      if (pyFlag || /我的答案|正确答案|批阅|查看答案|查看解析|得分/.test(body)) {
        return Object.assign({ state: 'reviewed' }, base);
      }
      if (/已提交|已完成|已交|提交成功/.test(body)) return Object.assign({ state: 'submitted' }, base);
      return Object.assign({ state: 'unknown' }, base);
    }

    // ---- 作答记录:会话句柄 + 提交轨迹事件(autoSubmit 等散点通过它留痕) ----
    const pageStart = Date.now();   // 本次页面加载的时刻:用来识别"上一次加载"留下的跨帧锁
    let aiSession = null;
    function aiEvent(text, patch) {
      if (!aiSession) return;
      const m = aiSession.meta;
      m.events.push({ ts: Date.now(), text: text });
      if (m.events.length > 20) m.events = m.events.slice(-20);
      if (patch) Object.assign(m, patch);
      aibus.put(AI_S(aiSession.sid), Object.assign({}, m, { events: m.events.slice(-20) }));
    }

    // ---- 1) ajaxHook 拦截题目接口明文(学习通用字体混淆 DOM 文本,接口是明文) ----
    let captured = null; // 从接口 JSON 提取的题目数组
    try {
      /* global ah */
      if (typeof ah !== 'undefined' && ah.proxy) {
        ah.proxy({
          onResponse: (response, handler) => {
            try {
              const txt = typeof response.response === 'string' ? response.response : '';
              // 题目接口特征:JSON 且含题目字段
              if (!captured && txt.length > 100 && txt.length < 3e6 &&
                  /"(question|titleOption|questionType|options?)"/.test(txt.slice(0, 2e5))) {
                const json = JSON.parse(txt);
                const qs = extractQuestionsFromJson(json);
                if (qs.length) {
                  captured = qs;
                  log.info(module, `接口拦截到 ${qs.length} 道题目(明文)`);
                }
              }
            } catch (_) { /* 非题目响应,忽略 */ }
            handler.next(response);
          },
        });
        log.info(module, 'ajaxHook 已挂载');
      }
    } catch (e) {
      log.warn(module, 'ajaxHook 挂载失败,将降级为 DOM 抓取: ' + e.message);
    }

    // ---- 2) 等题目渲染后启动流程 ----
    elmGetter.get(SELECTORS.quiz.question, 20000).then(() => {
      setTimeout(run, 800); // 给接口数据一点到达时间
    }).catch(() => {
      log.warn(module, '未检测到题目容器,可能不是答题页或页面已改版');
      report(module, 'idle', '未检测到题目');
    });

    async function run() {
      if (!isEnabled()) return log.info(module, '总开关关闭,不执行答题');

      // ---- 闸口2: 页面状态机(已批阅 / 已提交 / 已截止 / 草稿 / 未做) ----
      // 判定顺序保守:先看"还能不能交"(有没有可见 Submit),再看标记,拿不准就不动手。
      const ws = detectWorkState();
      log.info(module, `页面状态: ${ws.state}${ws.answered ? '(已有 ' + ws.answered + ' 题作答)' : ''} status="${ws.statusText}" pyFlag="${ws.pyFlag}"`);
      if (ws.state === 'reviewed' || ws.state === 'submitted' || ws.state === 'closed' || ws.state === 'unknown') {
        const label = {
          reviewed: '已批阅,不操作', submitted: '已提交,不操作',
          closed: '已截止/已结束,不操作', unknown: '状态不明(无提交按钮),不操作',
        }[ws.state];
        report(module, ws.state === 'unknown' ? 'review' : ws.state, label);
        return;
      }
      const isDraft = ws.state === 'draft';
      if (isDraft) {
        log.info(module, `草稿态:已有 ${ws.answered} 题作答,只补空白题,不覆盖你已选的内容`);
      }
      // ---- 闸口2b: 可答性正向校验 ----
      if (!$('li[onclick*="addChoice"], input[type=radio], input[type=checkbox]').length) {
        log.info(module, '未发现可交互选项,非答卷页,退出');
        report(module, 'review', '无可交互选项,不操作');
        return;
      }

      // 跨帧锁:同一测验可能被多个嵌套帧同时识别(ananas/work 外壳 + doHomeWorkNew),
// 抢锁成功的实例才干活,其余退出,防止重复答题/重复提交。
// 注意:锁必须"先有题再抢"——外壳帧没有题目,不该占坑;
      // 而且只认"本次页面加载之后"设的锁,否则刷新页面会被上一次的锁挡住 5 分钟。
      const workKey = (location.href.match(/workId=([0-9a-z]+)/i) || [null, location.pathname])[1];
      const LOCK_KEY = 'autocx.quiz.lock';

      const questions = (captured && captured.length ? captured : extractQuestionsFromDOM())
        .map((q, i) => ({ ...q, index: i + 1 }));
      if (!questions.length) {
        log.warn(module, '题目提取失败(接口和 DOM 均无结果)');
        report(module, 'error', '题目提取失败');
        return;
      }
      log.info(module, `共 ${questions.length} 题,来源: ${captured ? '接口明文' : 'DOM(可能被字体混淆)'}`);
      report(module, 'extracted', `提取到 ${questions.length} 题`);

      // 有题了,再来抢锁(外壳帧到不了这里)
      const lock = GM_getValue(LOCK_KEY);
      const lockFromThisPage = lock && lock.workKey === workKey && lock.ts >= pageStart &&
        Date.now() - lock.ts < 5 * 60 * 1000;
      if (lockFromThisPage) {
        log.info(module, '另一个帧已接管本测验,本帧退出');
        return;
      }
      if (lock && lock.workKey === workKey) log.info(module, '上一次页面留下的锁已过期,由本次接管');
      GM_setValue(LOCK_KEY, { workKey, ts: Date.now(), pageStart: pageStart });

      // 草稿态:已有作答的题保留不动(不覆盖用户/上次的自己选的答案)
      if (isDraft) {
        questions.forEach((q) => {
          const cur = readCheckedLetters(q);
          if (cur) { q.skipExisting = true; q.existingLetters = cur; }
        });
        const kept = questions.filter((q) => q.skipExisting).length;
        if (kept) log.info(module, `草稿态:${kept} 题已有作答,保留不覆盖`);
      }

      /* ---------- 字体反混淆:密文 -> 明文 ---------- */
      let fontInfo = null;
      if (config.get('font.decode')) {
        try {
          const refDb = await loadRefDb();
          if (!refDb) {
            log.warn(module, '参考字形库未就绪(检查 font.refdb_url / @require),题目将保持密文');
            report(module, 'font-missing', '参考字形库未就绪');
          } else {
            const fd = createFontDeobfuscator({
              doc: document,
              log: log,
              refDb: refDb,
              minScore: Number(config.get('font.min_score')),
              minMargin: Number(config.get('font.min_margin')),
            });
            const st = await fd.build();
            if (st.ok) {
              // 视觉兜底:只对"有字形但不敢定"的字，一次请求，结果必须与位图一致才算数
              if (st.low > 0 && config.get('llm.vision') !== false && config.get('llm.api_key')) {
                try {
                  const lows = fd.lowList();
                  const png = renderGlyphGrid(lows.map((x) => String.fromCodePoint(x.cp)), fd.family);
                  const ask = `这是一张汉字字形表，共 ${lows.length} 个字，每格左上角的数字是序号。请按序号逐行只输出你看到的汉字，不要任何解释。`;
                  const txt = await llm.vision(ask, png);
                  const got = [...String(txt)].filter((c) => /[\u3400-\u9fff]/.test(c));
                  let fixed = 0;
                  lows.forEach((it, i) => {
                    if (got[i] && fd.applyVision(it.cp, got[i].codePointAt(0))) fixed += 1;
                  });
                  st.vision = { asked: lows.length, fixed: fixed };
                  log.info(module, `视觉兜底:问 ${lows.length} 字,交叉校验通过 ${fixed} 字`);
                  report(module, 'vision', `视觉兜底 ${fixed}/${lows.length}`);
                } catch (e) {
                  st.vision = { error: e.message };
                  log.warn(module, '视觉兜底失败(不影响主链路): ' + e.message);
                }
              }
              fontInfo = st;
              questions.forEach((q) => {
                const ds = fd.decode(q.stem);
                q.stemRaw = q.stem;
                q.stem = ds.text;
                let mapped = ds.mapped, total = ds.total;
                const optUnknown = [];
                q.options = (q.options || []).map((o) => {
                  const od = fd.decode(o.text);
                  mapped += od.mapped;
                  total += od.total;
                  if (od.unknown) optUnknown.push(od.unknown);
                  return Object.assign({}, o, { textRaw: o.text, text: od.text });
                });
                const conf = total ? mapped / total : 1;
                q.decode = {
                  conf: conf,
                  mapped: mapped,
                  total: total,
                  unknown: (ds.unknown || '') + optUnknown.join(''),
                  chars: st.cipher,
                };
              });
              log.info(module, `字体解码完成: 字体=${st.family} 节点=${st.nodes} 密文字=${st.cipher} 命中=${st.decoded} 低置信=${st.low} 非密文=${st.missing} 耗时=${st.ms}ms`);
              report(module, 'decoded', `字体解码 ${st.decoded}/${st.cipher} (${st.ms}ms)`);
            } else {
              log.warn(module, `字体解码不可用(${st.reason}),题目将保持密文`);
              report(module, 'font-fail', `字体解码不可用:${st.reason}`);
            }
          }
        } catch (e) {
          log.warn(module, '字体解码异常: ' + e.message);
          report(module, 'font-fail', '字体解码异常');
        }
      }
      // 解码后逐题定级: A=明文全中 / B=基本可信 / C=需人工
      questions.forEach((q) => {
        const conf = q.decode ? q.decode.conf : 1;
        q.grade = conf < Number(config.get('font.page_min_conf')) ? 'C' : (conf < 0.99 ? 'B' : 'A');
        if (q.decode) {
          log.debug(module, `题目${q.index} 解码 ${q.decode.mapped}/${q.decode.total} 置信 ${conf.toFixed(2)} 级别 ${q.grade}`);
        }
      });

      /* ---------- 作答记录:会话快照 + 每题初始状态(供 AI 记录窗口消费) ---------- */
      const sid = 'w' + String(workKey).replace(/[^0-9a-z]/gi, '').slice(0, 16);
      const sess = startAiSession({
        sid,
        workKey,
        title: String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '章节测验',
        questions,
        source: captured ? '接口明文' : (fontInfo ? 'DOM + 字体解码' : 'DOM 提取'),
        submitState: config.get(isWorkPage() ? 'quiz.auto_submit_work' : 'quiz.auto_submit') ? 'wait' : 'off',
      });
      const aiMeta = sess.aiMeta;
      const metaWrite = sess.metaWrite;
      const convs = sess.convs;
      const writer = sess.writer;
      aiSession = { sid, meta: aiMeta };

      // 未配置 API Key:只提取不答题
      if (!config.get('llm.api_key')) {
        questions.forEach((q) => log.info(module, `题目${q.index}[${q.type}] ${q.stem.slice(0, 60)}`));
        log.warn(module, '未配置 LLM API Key,仅完成题目提取。请在面板设置中填写。');
        report(module, 'no-key', '未配置 API Key,仅提取题目');
        return;
      }

      let failStreak = 0;
      let stopped = false;
      const stats = { ok: 0, failed: [] };

      // 单题处理(含一次重试;全链路日志 + 作答记录留痕:请求/思考/回答/解析/勾选/校验)
      const answerOne = async (q) => {
        if (stopped || !isEnabled()) return;
        const c = convs[q.index - 1];
        setBadge(q, '思考中…', 'thinking');
        if (!aiMeta.answeredAt) { aiMeta.answeredAt = Date.now(); metaWrite(); }
        for (let attempt = 1; attempt <= 2; attempt++) {
          // 每次尝试都重置这条记录,失败重试时窗口能看出是第几次
          c.attempt = attempt;
          c.phase = 'requesting';
          c.prompt = buildPrompt(q);
          c.params = {
            model: aiMeta.model,
            temperature: 0.1,
            effort: aiMeta.effort,
            stream: config.get('llm.stream') !== false,
          };
          c.thinking = '';
          c.answer = '';
          c.error = null;
          c.result = null;
          c.t = c.t || {};
          c.t.reqAt = Date.now();
          c.t.firstThinkAt = 0;
          c.t.firstAnswerAt = 0;
          c.t.doneAt = 0;
          writer(q.index).write(convSnapshot(c), true);
          try {
            const st = await llm.stream(c.prompt, {
              onThinking: (text, s) => {
                c.phase = 'thinking';
                c.thinking = s.thinking;
                if (!c.t.firstThinkAt) c.t.firstThinkAt = Date.now();
                writer(q.index).write(convSnapshot(c));
              },
              onAnswer: (text, s) => {
                c.phase = 'answering';
                c.answer = s.answer;
                c.streamed = s.streamed !== false;
                if (!c.t.firstAnswerAt) c.t.firstAnswerAt = Date.now();
                writer(q.index).write(convSnapshot(c));
              },
            }).promise;
            c.thinking = st.thinking;
            c.answer = st.answer;
            c.usage = st.usage || null;
            c.streamed = st.streamed !== false;
            c.t.doneAt = Date.now();
            failStreak = 0;
            const parsed = parseAnswer(q, st.answer);
            c.result = {
              display: parsed.display, normalized: parsed.normalized,
              letters: parsed.letters || [], ok: parsed.ok, fillOk: false, verifyOk: null,
            };
            // 全链路日志:题型 -> 原始回答 -> 规范化答案
            log.info(module, `题目${q.index}[${q.type}] 原始回答: ${String(st.answer).replace(/\s+/g, ' ').slice(0, 80)} → 规范化: ${parsed.normalized || '(无)'}`);
            if (!parsed.ok) {
              setBadge(q, `AI: ${parsed.display}`, 'bad');
              stats.failed.push(q.index);
              c.phase = 'failed';
              c.error = {
                message: '回答无法解析成答案',
                hint: '原始回答: ' + String(st.answer).replace(/\s+/g, ' ').slice(0, 80),
              };
              writer(q.index).write(convSnapshot(c), true);
              aiMeta.failed += 1;
              metaWrite();
              log.warn(module, `题目${q.index} 解析失败,未作答`);
              return;
            }
            // 两答一致性校验:同题再问一遍,不一致则标记存疑、不填写、阻断自动提交
            // 复核策略:解码置信足够时,单选/判断只问一次;多选/填空/低置信才二次核对(省一半 token)
            const needDouble = config.get('quiz.double_check') && (
              q.type === 'multi' || q.type === 'blank' ||
              !q.decode || q.decode.conf < 0.9
            );
            if (needDouble) {
              setBadge(q, `复核中(${parsed.display})…`, 'thinking');
              c.phase = 'rechecking';
              writer(q.index).write(convSnapshot(c));
              const st2 = await llm.stream(c.prompt, {
                onThinking: () => {}, onAnswer: () => {},
              }).promise;
              const parsed2 = parseAnswer(q, st2.answer);
              c.recheck = {
                answer: st2.answer, normalized: parsed2.normalized,
                ok: parsed2.ok, consistent: parsed2.ok && parsed2.normalized === parsed.normalized,
              };
              log.info(module, `题目${q.index} 复核回答: ${String(st2.answer).replace(/\s+/g, ' ').slice(0, 80)} → 规范化: ${parsed2.normalized || '(无)'}`);
              if (!parsed2.ok || parsed2.normalized !== parsed.normalized) {
                setBadge(q, `存疑: ${parsed.display}/${parsed2.ok ? parsed2.display : '?'}`, 'doubt');
                log.warn(module, `题目${q.index} 两次作答不一致(${parsed.normalized} vs ${parsed2.normalized || '解析失败'}),跳过不填,请人工定夺`);
                stats.failed.push(q.index);
                c.phase = 'failed';
                c.error = {
                  message: `两次作答不一致(${parsed.normalized} vs ${parsed2.normalized || '解析失败'})`,
                  hint: '模型对本题把握不定,已跳过不填。请人工核对后自行选择。',
                };
                writer(q.index).write(convSnapshot(c), true);
                aiMeta.failed += 1;
                metaWrite();
                return;
              }
            }
            setBadge(q, `AI: ${parsed.display}`, 'ok');
            if (config.get('quiz.auto_fill')) {
              // 闸口3: 填写前可交互性复检(批阅页最后一道防线)
              const bt = (document.body && document.body.innerText) || '';
              if (/My Answer|我的答案|正确答案|批阅|查看答案|查看解析|得分/i.test(bt)) {
                log.warn(module, `题目${q.index} 检测到批阅/查看页特征,拒绝点击填写`);
                report(module, 'review', '批阅页特征,已停止填写');
                stats.failed.push(q.index);
                c.phase = 'failed';
                c.error = { message: '批阅/查看页特征,拒绝点击', hint: '该页不允许作答,脚本未做任何点击' };
                writer(q.index).write(convSnapshot(c), true);
                aiMeta.failed += 1;
                metaWrite();
                return;
              }
              fillAnswer(q, parsed);
              // 填后校验:回读 DOM 勾选状态,与意图不一致则判失败(阻断自动提交)
              const actual = q.type === 'blank' ? null : readCheckedLetters(q);
              if (actual !== null) {
                const expect = parsed.letters.join('');
                c.result.fillOk = true;
                c.result.verifyOk = (expect === actual);
                log.info(module, `题目${q.index} 填写校验: 意图=${expect} 实际=${actual}${expect === actual ? ' ✓' : ' ✗'}`);
                if (expect !== actual) {
                  log.error(module, `题目${q.index} 填写与解析不一致(意图 ${expect},实际 ${actual}),中止本题`);
                  setBadge(q, `AI: ${parsed.display}(填写异常)`, 'bad');
                  stats.failed.push(q.index);
                  c.phase = 'failed';
                  c.error = {
                    message: `填写与解析不一致(意图 ${expect},实际 ${actual})`,
                    hint: '本题不参与自动提交,请人工确认',
                  };
                  writer(q.index).write(convSnapshot(c), true);
                  aiMeta.failed += 1;
                  metaWrite();
                  return;
                }
              } else {
                c.result.fillOk = true; // 填空:没有可回读的勾选状态
              }
            }
            stats.ok++;
            c.phase = 'filled';
            writer(q.index).write(convSnapshot(c), true);
            aiMeta.answered += 1;
            metaWrite();
            return;
          } catch (e) {
            c.phase = 'failed';
            c.error = { message: e.message, hint: attempt < 2 ? '自动重试一次' : '本题放弃' };
            writer(q.index).write(convSnapshot(c), true);
            log.warn(module, `题目${q.index} 第${attempt}次调用失败: ${e.message}`);
          }
        }
        failStreak++;
        stats.failed.push(q.index);
        setBadge(q, '失败', 'bad');
        aiMeta.failed += 1;
        metaWrite();
        if (failStreak >= 3) {
          stopped = true;
          log.error(module, '连续 3 题失败,暂停答题。请检查 LLM 配置。');
          report(module, 'error', 'LLM 连续失败,已暂停');
          aiEvent('连续 3 题失败,已暂停答题。请检查 LLM 配置。', {
            submitState: 'blocked', submitDetail: 'LLM 连续失败',
          });
        }
      };

      // 2 路并发(保守:部分服务对并发限速)
      const queue = [...questions];
      const worker = async () => {
        while (queue.length && !stopped) {
          const q = queue.shift();
          if (!q) continue;
          // 草稿态已有作答:不覆盖,直接记成已答并留痕
          if (q.skipExisting) {
            const c = convs[q.index - 1];
            c.phase = 'filled';
            c.answer = '(保留原有作答 ' + q.existingLetters + ')';
            c.result = { display: q.existingLetters, normalized: q.existingLetters, letters: q.existingLetters.split(''), ok: true, fillOk: true, verifyOk: true };
            writer(q.index).write(convSnapshot(c), true);
            setBadge(q, `已有作答(${q.existingLetters})·保留`, 'doubt');
            stats.ok += 1;
            aiMeta.answered += 1;
            metaWrite();
            log.info(module, `题目${q.index} 草稿已有作答 ${q.existingLetters},保留不覆盖`);
            continue;
          }
          await answerOne(q);
        }
      };
      await Promise.all([worker(), worker()]);

      if (stopped) return;
      // 章节测验用 quiz.auto_submit,作业(work)用 quiz.auto_submit_work(默认关,作业常只能交一次)
      const autoKey = isWorkPage() ? 'quiz.auto_submit_work' : 'quiz.auto_submit';
      const gradeC = questions.filter((q) => q.grade === 'C').map((q) => q.index);
      // 无论开没开自动提交,都先把"人工提交"的菜单入口挂上,免得用户找不到提交按钮
      try {
        GM_registerMenuCommand('AutoCX: 提交本次测验/作业', () => {
          report(module, 'manual-submit', '用户从菜单触发提交');
          autoSubmit();
        });
      } catch (e) { log.debug(module, '注册提交菜单失败: ' + e.message); }

      if (config.get(autoKey)) {
        if (stats.failed.length === 0 && stats.ok === questions.length && !gradeC.length) {
          aiMeta.answered = stats.ok;
          aiEvent('全部题目已作答且解码可信,准备自动提交', { submitState: 'ready' });
          autoSubmit();
        } else {
          const why = [];
          if (stats.failed.length) why.push(`${stats.failed.length} 题未答(题号 ${stats.failed.join(',')})`);
          if (gradeC.length) why.push(`${gradeC.length} 题解码存疑(题号 ${gradeC.join(',')})`);
          const detail = why.join('、');
          log.warn(module, `${detail},不自动提交;需要提交可从脚本菜单「提交本次测验/作业」手动触发。`);
          report(module, 'filled', `${stats.ok}/${questions.length} 已答,${detail}`);
          aiEvent(`${detail},不自动提交(可从脚本菜单手动提交)`, {
            submitState: 'blocked', submitDetail: detail,
          });
        }
      } else {
        const reason = isWorkPage() ? '作业默认只填不交(quiz.auto_submit_work)' : '自动提交已关闭';
        log.info(module, `答题流程结束:${reason}。请核对后提交,或从脚本菜单「提交本次测验/作业」触发。`);
        report(module, 'filled', '答题完成,等待人工核对提交');
        aiEvent(`${stats.ok}/${questions.length} 已答。${reason},请人工核对后提交`, {
          submitState: 'off', submitDetail: '',
        });
      }
    }

    /* ---------- 自动提交(仅在全部答完时调用) ---------- */
    // 提交流程:点 .btnSubmit -> 顶层 workPop 弹窗("Submit?") -> 点其确认按钮
    // -> 可能出现验证码(#verifyCodeWin,转人工) -> 验证结果(修掉假阳性)
    function autoSubmit() {
      log.info(module, '全部题目已作答,3 秒后自动提交…');
      report(module, 'submitting', '全部答完,自动提交中');
      aiEvent('3 秒后点击提交按钮(自动提交已开启)');
      setTimeout(() => {
        try {
          // 拦截原生 confirm/alert,防止确认框卡住流程(10 秒后恢复)
          const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
          const oldConfirm = win.confirm, oldAlert = win.alert;
          win.confirm = () => true;
          win.alert = () => true;
          setTimeout(() => { win.confirm = oldConfirm; win.alert = oldAlert; }, 10000);

          const btn = findSubmitBtn();
          if (!btn) {
            const bodyText = document.body.innerText || '';
            if (/已提交|已完成|查看答案|答案解析|不能再提交/.test(bodyText) || !$('li[onclick*="addChoice"]').length) {
              log.warn(module, '未找到提交按钮,且无可选题目——可能已提交过,无需操作');
              report(module, 'submitted', '测验已是完成状态');
              aiEvent('未找到提交按钮,但页面已是完成状态(可能之前已提交)', { submitState: 'done', submitDetail: '页面已是完成态' });
            } else {
              log.error(module, '未找到提交按钮,请人工提交(选择器可能已改版)');
              report(module, 'error', '未找到提交按钮,请人工提交');
              aiEvent('未找到提交按钮,请人工提交(选择器可能已改版)', { submitState: 'blocked', submitDetail: '未找到提交按钮' });
            }
            return;
          }
          btn.click();
          log.info(module, '已点击提交按钮,等待确认弹窗…');
          aiEvent('已点击提交按钮,等待确认弹窗');

          // 等待顶层 workPop 确认弹窗出现并点击其确认按钮(最多 6 秒)
          let tries = 0;
          const popTimer = setInterval(() => {
            tries++;
            let confirmed = false;
            try {
              // workPop 渲染在顶层窗口;学习通帧链全程同源,可直接访问
              const topDoc = (window.top && window.top.document) || document;
              const $pop = $(topDoc).find(SELECTORS.quiz.submitConfirm)
                .filter(function () {
                  const t = $(this).text().replace(/\s+/g, '');
                  return $(this).is(':visible') && /^(Submit|OK|Ok|ok|确定|确认|提交)$/.test(t);
                });
              if ($pop.length) {
                $pop.get(0).click();
                confirmed = true;
                log.info(module, '已点击确认弹窗 Submit');
                aiEvent('已点击确认弹窗 Submit');
              }
            } catch (e) {
              log.warn(module, '访问顶层弹窗失败: ' + e.message);
            }
            if (confirmed || tries >= 12) {
              clearInterval(popTimer);
              verifySubmitted(0);
            }
          }, 500);
        } catch (e) {
          log.error(module, '自动提交异常: ' + e.message + ',请人工提交');
          report(module, 'error', '自动提交异常,请人工提交');
          aiEvent('自动提交异常,请人工提交', { submitState: 'blocked', submitDetail: '提交异常' });
        }
      }, 3000);

      // 提交结果验证(最多 10 秒):验证码出现转人工;Submit 消失/状态完成才算成功
      function verifySubmitted(round) {
        if (round > 20) {
          log.error(module, '提交结果未确认,请检查页面后人工处理');
          report(module, 'error', '提交结果未确认');
          aiEvent('提交结果未确认,请检查页面后人工处理', { submitState: 'blocked', submitDetail: '结果未确认' });
          return;
        }
        setTimeout(() => {
          try {
            // 1) 验证码弹窗出现 -> 转人工
            const cap = document.querySelector(SELECTORS.quiz.captchaWin);
            if (cap && cap.offsetWidth && cap.offsetHeight) {
              log.warn(module, '出现图片验证码,请人工输入并完成提交');
              report(module, 'captcha', '出现验证码,等待人工');
              aiEvent('出现图片验证码,转人工处理', { submitState: 'captcha', submitDetail: '出现验证码' });
              return;
            }
            // 2) 提交按钮消失或页面出现完成态文本 -> 成功
            const stillBtn = $(SELECTORS.quiz.submit).filter(':visible').length > 0;
            const bodyText = document.body.innerText || '';
            const doneText = /已提交|已完成|查看答案|答案解析|成绩|得分/.test(bodyText) && !/To do/.test(bodyText);
            if (!stillBtn || doneText) {
              log.info(module, '自动提交成功 ✅');
              report(module, 'submitted', '自动提交成功');
              aiEvent('自动提交成功', { submitState: 'done', submitDetail: '已提交' });
              return;
            }
            verifySubmitted(round + 1);
          } catch (e) {
            verifySubmitted(round + 1);
          }
        }, 500);
      }
    }

    /* ---------- 题目提取:接口 JSON ---------- */
    function extractQuestionsFromJson(json) {
      // 在 JSON 树里找"题目对象数组":对象含题干与题型字段
      const out = [];
      const looksLikeQuestion = (o) => o && typeof o === 'object' &&
        (o.title || o.question || o.stem) && (o.type !== undefined || o.questionType !== undefined || o.options || o.titleOption);
      const walk = (node) => {
        if (!node || out.length) return;
        if (Array.isArray(node)) {
          if (node.length && node.every(looksLikeQuestion)) {
            node.forEach((q) => out.push(normalizeJsonQuestion(q)));
          } else node.forEach(walk);
        } else if (typeof node === 'object') {
          Object.values(node).forEach(walk);
        }
      };
      walk(json);
      return out.filter(Boolean);
    }
    function normalizeJsonQuestion(q) {
      try {
        const stem = String(q.title || q.question || q.stem || '').replace(/<[^>]+>/g, '').trim();
        const rawType = q.type ?? q.questionType ?? '';
        const numType = Number(rawType);
        const type = numType === 1 ? 'multi' : numType === 3 ? 'judge' : numType === 2 ? 'blank'
          : numType === 0 ? 'single'
          : /多选|multiple|multi/i.test(String(rawType)) ? 'multi'
          : /判断|judge|truefalse/i.test(String(rawType)) ? 'judge'
          : /填空|blank|fill/i.test(String(rawType)) ? 'blank' : 'single';
        const optsRaw = q.options || q.titleOption || q.answers || [];
        const options = (Array.isArray(optsRaw) ? optsRaw : []).map((o, i) => ({
          label: String.fromCharCode(65 + i),
          text: String(typeof o === 'string' ? o : (o.text || o.content || o.value || '')).replace(/<[^>]+>/g, '').trim(),
        }));
        return { type, stem, options, dom: null };
      } catch (_) { return null; }
    }

    /* ---------- 题型识别(权威:li[qtype];其次中英双语文本标记) ---------- */
    // 学习通 qtype: 0=单选 1=多选 3=判断 2=填空。文本兜底兼容中英文 UI 与字体混淆。
    function detectType($q, typeText) {
      const qt = $q.find('li[qtype]').first().attr('qtype');
      if (qt !== undefined && qt !== null && qt !== '') {
        if (qt === '0') return 'single';
        if (qt === '1') return 'multi';
        if (qt === '3') return 'judge';
        if (qt === '2') return 'blank';
      }
      const t = String(typeText || '');
      if (/多选题|multiple/i.test(t)) return 'multi';
      if (/判断题|true or false/i.test(t)) return 'judge';
      if (/填空题|fill/i.test(t)) return 'blank';
      return 'single';
    }

    /* ---------- 选项元素:优先 li[qid](本版),退回旧版结构 ---------- */
    function pickOptionEls($q) {
      const marked = $q.find(SELECTORS.quiz.option).get();
      if (marked.length) return marked;
      const all = $q.find(SELECTORS.quiz.optionList).get();
      const outer = all.filter((el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        return /^[A-Z][、.\s]/.test(t) && t.length > 2;
      });
      return outer.length ? outer : all;
    }

    /* ---------- 选项字母/文本:本版从 span[data] + a.after 取,避免字母混进正文 ---------- */
    function readOption(el, i) {
      const $el = $(el);
      const $letter = $el.find(SELECTORS.quiz.optionLetter).first();
      const label = String($letter.attr('data') || '').trim() || String.fromCharCode(65 + i);
      const $txt = $el.find(SELECTORS.quiz.optionText).first();
      let text = $txt.length ? $txt.text() : $el.clone().find('label').remove().end().text();
      text = text.replace(/\s+/g, ' ').trim();
      if (!$txt.length) text = text.replace(/^[A-Z][、.\s]+/, '').trim();
      return { label, text };
    }

    /* ---------- 题目提取:DOM 降级 ---------- */
    function extractQuestionsFromDOM() {
      const seen = new Set();
      const out = [];
      $(SELECTORS.quiz.question).each(function () {
        const $q = $(this);
        // 本版 .TiMu 可能被外层再包一层,用 qid 去重
        const qid = String($q.find('li[qid]').first().attr('qid') || $q.attr('qid') || '');
        const key = qid || ($q.attr('data') || '');
        if (key && seen.has(key)) return;
        if (key) seen.add(key);

        const $stem = $q.find(SELECTORS.quiz.title).first();
        const $copy = $stem.length ? $stem.clone() : $q.clone();
        $copy.find(SELECTORS.quiz.typeMark).remove();
        const stem = $copy.text().replace(/\s+/g, ' ').replace(/【[^】]*】/g, '').trim();
        if (!stem) return;

        const type = detectType($q, $q.text());
        // 选项:必须"元素 / 字母 / 文本"三者一一对应。
        // 2026 版里选项字母是打乱的(第一个 <li> 的 data 可能是 "C"),
        // 若按位置算字母(65+i)会与提示词里的字母不一致 -> 点错选项还会"校验通过"。
        // 故这里过滤空文本时同步过滤元素,并单独保存每个元素的真实字母。
        const optEls = pickOptionEls($q);
        const pairs = optEls.map((el, i) => ({ el, o: readOption(el, i) })).filter((p) => p.o.text);
        const options = pairs.map((p) => p.o);
        const optDoms = pairs.map((p) => p.el);
        const optLabels = pairs.map((p) => p.o.label);
        out.push({ type, stem, options, dom: this, optDoms, optLabels, qid });
      });
      return out;
    }

    /* ---------- 填后校验:回读 DOM 勾选状态与意图比对 ---------- */
    // 用元素自己的真实字母(提取时记下的 optLabels),不能用位置推算的 65+i:
    // 2026 版选项字母是打乱的,按位置算会把"选中的项"报成另一个字母。
    function readCheckedLetters(q) {
      const letters = [];
      (q.optDoms || []).forEach((el, i) => {
        const input = $(el).find('input[type=radio],input[type=checkbox]').get(0);
        const checked = (input && input.checked) || el.getAttribute('aria-checked') === 'true';
        if (checked) letters.push(labelOf(q, i));
      });
      return letters.join('');
    }

    /** 第 i 个选项的真实字母 */
    function labelOf(q, i) {
      if (q.optLabels && q.optLabels[i]) return q.optLabels[i];
      return String.fromCharCode(65 + i);
    }

    /* ---------- 自动勾选 ---------- */
    function fillAnswer(q, parsed) {
      if (!q.dom) return log.debug(module, `题目${q.index} 无 DOM 引用,跳过勾选`);
      const $q = $(q.dom);
      if (q.type === 'blank') {
        const $inputs = $q.find(SELECTORS.quiz.blankInput).filter(':visible');
        (parsed.blanks || []).forEach((ans, i) => {
          const el = $inputs.get(i);
          if (el) {
            el.value = ans;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        return;
      }
      // 选择/判断:用提取时去重后的同一份元素,避免内外层错位
      const isChecked = (el) => {
        const input = $(el).find('input[type=radio],input[type=checkbox]').get(0);
        return (input && input.checked) || el.getAttribute('aria-checked') === 'true';
      };
      const click = (el) => {
        const input = $(el).find('input[type=radio],input[type=checkbox]').get(0);
        if (input) input.click(); else el.click();
      };
      (q.optDoms || []).forEach((el, i) => {
        const letter = labelOf(q, i);
        const want = (parsed.letters || []).includes(letter);
        const cur = isChecked(el);
        if (want && !cur) click(el);           // 该选未选 -> 选上
        else if (!want && cur && q.type === 'multi') click(el); // 多选:清掉残留勾选
      });
    }

    /* ---------- 题目标记 ---------- */
    function setBadge(q, text, state) {
      if (!q.dom) return;
      let $b = $(q.dom).find('.autocx-badge');
      if (!$b.length) {
        $b = $('<span class="autocx-badge" style="margin-left:8px;padding:1px 6px;border-radius:3px;font-size:12px;"></span>');
        $(q.dom).find(SELECTORS.quiz.title).first().append($b);
      }
      const colors = { thinking: '#63b4ff', ok: '#21d181', bad: '#ff4d4f', doubt: '#f59e0b' };
      $b.text(text).css({ background: colors[state] || '#999', color: '#fff' });
    }

    /* ---------- 回归测试钩子(控制台/自动化验证用) ---------- */
    try {
      (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__autocxQuiz = {
        parseAnswer, normalizeLetters,
      };
    } catch (_) { /* 暴露失败不影响主流程 */ }
  }

  /* ============================== practice-page =========================== */
  // 随堂练习/课堂测验(mobilelearn 的 answerQuestion2 页):
  //   - 独立 Vue2 应用,题目与作答状态都在 vm.questionList / vm.personAnswer 上
  //   - 题型由 DOM class 决定:single-choice / multiple-choice / 填空 / 简答
  //   - 该页无字体混淆,题干与选项都是明文
  //   - 提交按钮 .submit-btn -> submitCheck():有未答题会弹 $.selectDialog 二次确认
  function initPracticePage() {
    const module = 'practice';
    if (config.get('assist.quiz') === false) {
      log.info(module, '答题助手已关闭,跳过');
      report(module, 'disabled', '答题助手已关闭');
      return;
    }
    report(module, 'start', '检测到随堂练习页面');
    log.info(module, '随堂练习页面启动');

    // 等题目渲染(题目数据由接口 quizDetail2 异步返回)
    elmGetter.get(SELECTORS.practice.question, 20000).then(() => {
      setTimeout(run, 600); // 给 Vue 一点渲染时间
    }).catch(() => {
      log.warn(module, '未检测到随堂练习题目(可能已结束或不在参与范围)');
      report(module, 'idle', '未检测到题目');
    });

    /** 取页面 Vue 实例(读题目/作答状态的权威来源) */
    function getVm() {
      try {
        const root = document.querySelector(SELECTORS.practice.root);
        return (root && root.__vue__) || null;
      } catch (e) { return null; }
    }

    async function run() {
      if (!isEnabled()) return log.info(module, '总开关关闭,不执行答题');
      // 页面可能在等待期间跳走(如已提交的测验会跳到批阅回看页),此时不再动手
      if (!/\/page\/quiz\/stu\/answerquestion2/i.test(location.pathname)) {
        log.info(module, '页面已跳转,不再操作');
        report(module, 'idle', '页面已跳转');
        return;
      }

      const vm = getVm();
      // 参与范围校验:不在范围内时页面只给一个提示块,没有题目
      if (vm && vm.hasAnswerPermission === 0) {
        log.warn(module, '不在参与人员范围内,无法作答');
        report(module, 'review', '不在参与人员范围内');
        return;
      }
      // 活动已结束:页面会跳到 quizStudentQuestion(成绩/批阅回看页)
      if (vm && vm.active && Number(vm.active.status) === 2) {
        log.info(module, '活动已结束,不操作');
        report(module, 'closed', '活动已结束');
        return;
      }

      const questions = extractPracticeQuestions(vm);
      if (!questions.length) {
        log.warn(module, '题目提取失败');
        report(module, 'error', '题目提取失败');
        return;
      }
      log.info(module, `共 ${questions.length} 题,来源: 页面接口明文`);
      report(module, 'extracted', `提取到 ${questions.length} 题`);

      // 未配置 API Key:只提取不答题
      if (!config.get('llm.api_key')) {
        questions.forEach((q) => log.info(module, `题目${q.index}[${q.type}] ${q.stem.slice(0, 60)}`));
        log.warn(module, '未配置 LLM API Key,仅完成题目提取。请在面板设置中填写。');
        report(module, 'no-key', '未配置 API Key,仅提取题目');
        return;
      }

      const activeId = (vm && vm.activeId) || '';
      const sess = startAiSession({
        sid: 'p' + String(activeId).replace(/[^0-9a-z]/gi, '').slice(0, 16),
        workKey: String(activeId),
        title: (vm && vm.active && vm.active.name) || '随堂练习',
        questions,
        source: '页面接口明文',
        submitState: config.get('quiz.auto_submit_practice') ? 'wait' : 'off',
      });
      const aiMeta = sess.aiMeta;
      const metaWrite = sess.metaWrite;
      const convs = sess.convs;
      const writer = sess.writer;

      let failStreak = 0;
      let stopped = false;
      const stats = { ok: 0, failed: [] };

      const answerOne = async (q) => {
        if (stopped || !isEnabled()) return;
        const c = convs[q.index - 1];
        setPracticeBadge(q, '思考中…', 'thinking');
        if (!aiMeta.answeredAt) { aiMeta.answeredAt = Date.now(); metaWrite(); }
        for (let attempt = 1; attempt <= 2; attempt++) {
          c.attempt = attempt;
          c.phase = 'requesting';
          c.prompt = buildPrompt(q);
          c.params = {
            model: aiMeta.model,
            temperature: 0.1,
            effort: aiMeta.effort,
            stream: config.get('llm.stream') !== false,
          };
          c.thinking = '';
          c.answer = '';
          c.error = null;
          c.result = null;
          c.t = c.t || {};
          c.t.reqAt = Date.now();
          c.t.firstThinkAt = 0;
          c.t.firstAnswerAt = 0;
          c.t.doneAt = 0;
          writer(q.index).write(convSnapshot(c), true);
          try {
            // 主观题可能带图片(如"给出下表的范式分析"),纯文本看不到图,改走多模态
            let st = null;
            if (q.type === 'subjective' && q.images && q.images.length && config.get('llm.vision') !== false) {
              const png = await fetchImageDataUrl(q.images[0]);
              if (png) {
                log.info(module, `题目${q.index} 含图片,走多模态作答`);
                const txt = await llm.vision(c.prompt, png);
                st = { thinking: '', answer: txt, usage: null, streamed: false };
              }
            }
            if (!st) {
              st = await llm.stream(c.prompt, {
                onThinking: (text, s) => {
                  c.phase = 'thinking';
                  c.thinking = s.thinking;
                  if (!c.t.firstThinkAt) c.t.firstThinkAt = Date.now();
                  writer(q.index).write(convSnapshot(c));
                },
                onAnswer: (text, s) => {
                  c.phase = 'answering';
                  c.answer = s.answer;
                  c.streamed = s.streamed !== false;
                  if (!c.t.firstAnswerAt) c.t.firstAnswerAt = Date.now();
                  writer(q.index).write(convSnapshot(c));
                },
              }).promise;
            }
            c.thinking = st.thinking;
            c.answer = st.answer;
            c.usage = st.usage || null;
            c.streamed = st.streamed !== false;
            c.t.doneAt = Date.now();
            failStreak = 0;
            const parsed = parseAnswer(q, st.answer);
            c.result = {
              display: parsed.display, normalized: parsed.normalized,
              letters: parsed.letters || [], ok: parsed.ok, fillOk: false, verifyOk: null,
            };
            log.info(module, `题目${q.index}[${q.type}] 原始回答: ${String(st.answer).replace(/\s+/g, ' ').slice(0, 80)} → 规范化: ${parsed.normalized || '(无)'}`);
            if (!parsed.ok) {
              setPracticeBadge(q, `AI: ${parsed.display}`, 'bad');
              stats.failed.push(q.index);
              c.phase = 'failed';
              c.error = {
                message: '回答无法解析成答案',
                hint: '原始回答: ' + String(st.answer).replace(/\s+/g, ' ').slice(0, 80),
              };
              writer(q.index).write(convSnapshot(c), true);
              aiMeta.failed += 1;
              metaWrite();
              log.warn(module, `题目${q.index} 解析失败,未作答`);
              return;
            }
            // 复核策略按题型分:
            //  - 选择/多选/填空:再答一次,要求规范化结果一致(客观题,字符串比较就是对的)
            //  - 主观题:两次作答本来就可能措辞不同,甚至给出不同但都成立的解法。
            //    强行要求两次一致,结果就是主观题几乎永远"存疑"而永远填不上。
            //    改成"让模型自评这一份答案是否正确且完整",只有被否才跳过。
            const isSubjective = q.type === 'subjective';
            const needDouble = config.get('quiz.double_check') && !isSubjective && (
              q.type === 'multi' || q.type === 'blank'
            );
            if (needDouble) {
              setPracticeBadge(q, `复核中(${parsed.display})…`, 'thinking');
              c.phase = 'rechecking';
              writer(q.index).write(convSnapshot(c));
              const st2 = await llm.stream(c.prompt, {
                onThinking: () => {}, onAnswer: () => {},
              }).promise;
              const parsed2 = parseAnswer(q, st2.answer);
              const consistent = parsed2.ok && parsed2.normalized === parsed.normalized;
              c.recheck = {
                answer: st2.answer, normalized: parsed2.normalized,
                ok: parsed2.ok, consistent,
              };
              log.info(module, `题目${q.index} 复核回答: ${String(st2.answer).replace(/\s+/g, ' ').slice(0, 80)} → 规范化: ${parsed2.normalized || '(无)'}`);
              if (!parsed2.ok || !consistent) {
                setPracticeBadge(q, `存疑: ${parsed.display}/${parsed2.ok ? parsed2.display : '?'}`, 'doubt');
                log.warn(module, `题目${q.index} 两次作答不一致(${parsed.normalized} vs ${parsed2.normalized || '解析失败'}),跳过不填,请人工定夺`);
                stats.failed.push(q.index);
                c.phase = 'failed';
                c.error = {
                  message: `两次作答不一致(${parsed.normalized} vs ${parsed2.normalized || '解析失败'})`,
                  hint: '模型对本题把握不定,已跳过不填。请人工核对后自行选择。',
                };
                writer(q.index).write(convSnapshot(c), true);
                aiMeta.failed += 1;
                metaWrite();
                return;
              }
            } else if (isSubjective && config.get('quiz.double_check')) {
              // 主观题:单独做一次自评,只在这一步拦人
              setPracticeBadge(q, `自评中(${parsed.display})…`, 'thinking');
              c.phase = 'rechecking';
              writer(q.index).write(convSnapshot(c));
              let judged = '';
              try {
                const judgePrompt =
                  '下面是对一道题的回答。请判断它是否正确且完整地回答了题目。'
                  + '只要结论正确、要点齐全就算通过,措辞风格不影响。\n'
                  + '只回复"通过"或"不通过"三个字,不要其它内容。\n\n'
                  + `题目:\n${String(q.stem || '').slice(0, 1500)}\n\n`
                  + `回答:\n${String(parsed.normalized || '').slice(0, 2500)}`;
                // 题干带图时,自评也要看图,否则模型无法判断"图里的表"答对了没有
                let png = null;
                if (q.images && q.images.length && config.get('llm.vision') !== false) {
                  png = await fetchImageDataUrl(q.images[0]);
                }
                judged = png
                  ? await llm.vision(judgePrompt, png)
                  : await llm.chat(judgePrompt);
              } catch (e) {
                log.warn(module, `题目${q.index} 自评调用失败: ${e.message}`);
              }
              const j = String(judged || '').replace(/\s+/g, '');
              const passed = /通过/.test(j) && !/不通过/.test(j);
              c.recheck = { judged: j.slice(0, 10), consistent: passed };
              log.info(module, `题目${q.index} 主观题自评:${j.slice(0, 10)}(${passed ? '通过' : '不通过'})`);
              if (judged && !passed) {
                setPracticeBadge(q, `自评不通过(${parsed.display})`, 'doubt');
                log.warn(module, `题目${q.index} 主观题自评不通过,跳过不填,请人工定夺`);
                stats.failed.push(q.index);
                c.phase = 'failed';
                c.error = {
                  message: '主观题自评不通过',
                  hint: '模型对本题把握不定,已跳过不填。请人工核对后自行填写。',
                };
                writer(q.index).write(convSnapshot(c), true);
                aiMeta.failed += 1;
                metaWrite();
                return;
              }
            }
            setPracticeBadge(q, `AI: ${parsed.display}`, 'ok');
            if (config.get('quiz.auto_fill')) {
              // 闸口:已提交/批阅页只读,禁止填写
              const bt = (document.body && document.body.innerText) || '';
              if (/My Answer|我的答案|正确答案|批阅|查看答案|查看解析|得分/i.test(bt)) {
                log.warn(module, `题目${q.index} 检测到批阅/查看页特征,拒绝点击填写`);
                report(module, 'review', '批阅页特征,已停止填写');
                stats.failed.push(q.index);
                c.phase = 'failed';
                c.error = { message: '批阅/查看页特征,拒绝点击', hint: '该页不允许作答,脚本未做任何点击' };
                writer(q.index).write(convSnapshot(c), true);
                aiMeta.failed += 1;
                metaWrite();
                return;
              }
              const filled = fillPracticeAnswer(q, parsed);
              c.result.fillOk = filled.ok;
              if (!filled.ok) {
                setPracticeBadge(q, `AI: ${parsed.display}(填写失败)`, 'bad');
                stats.failed.push(q.index);
                c.phase = 'failed';
                c.error = { message: filled.message || '填写失败', hint: '本题未作答,请人工处理' };
                writer(q.index).write(convSnapshot(c), true);
                aiMeta.failed += 1;
                metaWrite();
                return;
              }
              // 填后校验:回读平台状态与意图比对。
              // 比较必须在同一个取值空间里:判断题模型的答案是 A/B,而平台存的是 "1"/"2",
              // 直接比会误判成"没填上"。
              const actual = readPracticeAnswer(q);
              const expect = (q.type === 'blank')
                ? (parsed.blanks || []).join('|')
                : (q.type === 'subjective'
                  ? parsed.normalized
                  : platformValuesOf(q, parsed.letters || []).join(''));
              c.result.verifyOk = (actual === expect);
              log.info(module, `题目${q.index} 填写校验: 意图=${expect} 实际=${actual}${actual === expect ? ' ✓' : ' ✗'}`);
              if (!c.result.verifyOk) {
                setPracticeBadge(q, `AI: ${parsed.display}(填写异常)`, 'bad');
                stats.failed.push(q.index);
                c.phase = 'failed';
                c.error = {
                  message: `填写与解析不一致(意图 ${expect},实际 ${actual})`,
                  hint: '本题不参与自动提交,请人工确认',
                };
                writer(q.index).write(convSnapshot(c), true);
                aiMeta.failed += 1;
                metaWrite();
                return;
              }
            }
            stats.ok += 1;
            c.phase = 'filled';
            writer(q.index).write(convSnapshot(c), true);
            aiMeta.answered += 1;
            metaWrite();
            return;
          } catch (e) {
            c.phase = 'failed';
            c.error = { message: e.message, hint: attempt < 2 ? '自动重试一次' : '本题放弃' };
            writer(q.index).write(convSnapshot(c), true);
            log.warn(module, `题目${q.index} 第${attempt}次调用失败: ${e.message}`);
          }
        }
        failStreak++;
        stats.failed.push(q.index);
        setPracticeBadge(q, '失败', 'bad');
        aiMeta.failed += 1;
        metaWrite();
        if (failStreak >= 3) {
          stopped = true;
          log.error(module, '连续 3 题失败,暂停答题。请检查 LLM 配置。');
          report(module, 'error', 'LLM 连续失败,已暂停');
        }
      };

      const queue = [...questions];
      const worker = async () => {
        while (queue.length && !stopped) {
          const q = queue.shift();
          if (!q) continue;
          await answerOne(q);
        }
      };
      await Promise.all([worker(), worker()]);

      if (stopped) return;

      // 无论开没开自动提交,都挂一个菜单入口,免得用户找不到提交按钮
      try {
        GM_registerMenuCommand('AutoCX: 提交本次随堂练习', () => {
          report(module, 'manual-submit', '用户从菜单触发提交');
          submitPractice(vm);
        });
      } catch (e) { log.debug(module, '注册提交菜单失败: ' + e.message); }

      if (config.get('quiz.auto_submit_practice')) {
        if (stats.failed.length === 0 && stats.ok === questions.length) {
          aiMeta.answered = stats.ok;
          sess.aiMeta.events.push({ ts: Date.now(), text: '全部题目已作答,准备自动提交' });
          metaWrite();
          submitPractice(vm);
        } else {
          const why = [];
          if (stats.failed.length) why.push(`${stats.failed.length} 题未答(题号 ${stats.failed.join(',')})`);
          const detail = why.join('、');
          log.warn(module, `${detail},不自动提交;需要提交可从脚本菜单「提交本次随堂练习」手动触发。`);
          report(module, 'filled', `${stats.ok}/${questions.length} 已答,${detail}`);
          sess.aiMeta.events.push({ ts: Date.now(), text: `${detail},不自动提交(可从脚本菜单手动提交)` });
          metaWrite();
        }
      } else {
        // 随堂练习在 isAutoSubmit=1 时由平台在截止时自动提交,这里默认只填不交
        const reason = '自动提交已关闭(quiz.auto_submit_practice)';
        log.info(module, `答题流程结束:${reason}。请核对后提交,或从脚本菜单「提交本次随堂练习」触发。`);
        report(module, 'filled', `${stats.ok}/${questions.length} 已答,等待人工核对提交`);
        sess.aiMeta.events.push({ ts: Date.now(), text: `${stats.ok}/${questions.length} 已答。${reason},请人工核对后提交` });
        metaWrite();
      }
    }

    /**
     * 平台公共图片(取原图而非缩略图)转成 data URL,供多模态使用。
     * 图片在 p.cldisk.com,跨域但带 Access-Control-Allow-Origin,可直接 fetch。
     */
    async function fetchImageDataUrl(url) {
      try {
        const r = await fetch(url, { credentials: 'omit' });
        if (!r.ok) return null;
        const blob = await r.blob();
        if (!/^image\//.test(blob.type || '')) return null;
        return await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ''));
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(blob);
        });
      } catch (e) {
        log.debug(module, '图片读取失败: ' + e.message);
        return null;
      }
    }

    /**
     * 解析平台的多选作答字符串成字母集合。
     * 平台有两种格式:选项名全是字母时用字母串("AB"),否则用逗号串("A,B")。
     */
    function parseMultiSet(str) {
      const s = String(str || '').trim();
      if (!s) return new Set();
      const parts = /^[A-Za-z]+$/.test(s) ? s.split('') : s.split(',');
      return new Set(parts.map((x) => x.trim()).filter(Boolean));
    }

    /** 提取题目:DOM 取结构与选项,Vue 实例取题型/答案状态(双源) */
    function extractPracticeQuestions(vm) {
      const items = Array.from(document.querySelectorAll(SELECTORS.practice.question));
      const out = [];
      items.forEach((el, i) => {
        const vmq = (vm && vm.questionList && vm.questionList[i]) || null;
        const stemEl = el.querySelector(SELECTORS.practice.stem);
        const stem = htmlToText(stemEl ? stemEl.textContent : '');
        if (!stem) return;

        // 题型:优先看 Vue 的 type(平台权威),DOM class 只作补充。
        // 注意 DOM class 不可靠:判断题(type 3/16)复用的也是 "single-choice",
        // 单选(type 0)与判断(type 3/16)光看 class 分不开,必须看 type。
        const cls = String(el.className || '');
        const vtype = vmq ? Number(vmq.type) : null;
        let type = 'single';
        if (vtype === 1) type = 'multi';
        else if (vtype === 2 || vtype === 9 || vtype === 10) type = 'blank';
        else if (vtype === 3 || vtype === 16) type = 'judge';
        else if (vtype === 4 || vtype === 5 || vtype === 6 || vtype === 7 || vtype === 18) type = 'subjective';
        else if (cls.indexOf('multiple-choice') >= 0) type = 'multi';
        else if (el.querySelector(SELECTORS.practice.blankInput)) type = 'blank';
        else if (el.querySelector(SELECTORS.practice.shortInput)) type = 'subjective';

        // 选项:DOM 的 .option-letter 是平台自己的字母,顺序与 vm 一致。
        // 字母取不到时退回 Vue 的 que.answer[k].name,再不行才按位置推 ——
        // 绝不能只按位置推(章节测验页的选项字母是打乱的)。
        //
        // 判断题(type 3/16)是个坑:平台的选项名是 "1"/"2"(内容"对"/"错"),不是 A/B。
        // 这里统一把展示给模型的字母改成 A/B,并用 value 记住平台真实取值,填的时候再映射回去。
        const optEls = Array.from(el.querySelectorAll(SELECTORS.practice.option));
        const opts = optEls.map((oe, k) => {
          const le = oe.querySelector(SELECTORS.practice.optionLetter);
          const te = oe.querySelector(SELECTORS.practice.optionText);
          const vmAns = (vmq && vmq.answer && vmq.answer[k]) || null;
          const rawName = (le && le.textContent || '').trim()
            || (vmAns && vmAns.name ? String(vmAns.name).trim() : '')
            || String.fromCharCode(65 + k);
          const isLetter = /^[A-Z]$/.test(rawName);
          const label = isLetter ? rawName : String.fromCharCode(65 + k);
          const text = htmlToText(te ? te.textContent : (vmAns ? vmAns.content : ''));
          return {
            el: oe,
            label,          // 展示给模型的字母
            value: rawName, // 平台真实取值(判断题是 "1"/"2")
            text,
          };
        }).filter((o) => o.text || o.label);

        // 题干/附件里的图片(主观题常见)。
        // 平台模板里图片不在题干 HTML 中,而是单独渲染在 .attach-img-list 里:
        //   <img :src=".../star3/100_100c/<id>.png" data-orignal=".../star3/origin/<id>.jpg">
        // 缩略图 100_100c 分辨率太低,多模态看不清表格,所以优先取 data-orignal 原图。
        const images = [];
        const pushImg = (u) => {
          if (!u) return;
          const s = String(u);
          if (!/^https?:/i.test(s)) return;
          if (images.indexOf(s) < 0 && images.length < 3) images.push(s);
        };
        el.querySelectorAll('.attach-img-list img').forEach((im) => {
          // 选项里的图不算题干图(选项图片在 .option-list 内)
          if (im.closest('.option-list')) return;
          pushImg(im.getAttribute('data-orignal') || im.getAttribute('data-original') || im.getAttribute('src'));
        });
        const stemHtml = (vmq && vmq.content) || (stemEl ? stemEl.innerHTML : '');
        const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
        let im2;
        while ((im2 = imgRe.exec(String(stemHtml))) && images.length < 3) {
          pushImg(im2[1].replace('/star3/100_100c/', '/star3/origin/'));
        }

        out.push({
          index: out.length + 1,
          // vueIndex: 本题在 vm.questionList 里的下标。
          // 不能用 index-1 反推 —— 若某题题干为空会被跳过,index 就与 questionList 错位,
          // 那样读写 personAnswer 会落到别的题上。
          vueIndex: i,
          type,
          stem,
          options: opts.map((o) => ({ label: o.label, text: o.text })),
          optEls: opts.map((o) => o.el),
          optLabels: opts.map((o) => o.label),
          // 平台真实取值(判断题是 "1"/"2",多选/单选是字母)
          optValues: opts.map((o) => o.value),
          // 多选题的平台限制(如"至少2项最多4项"),提交时平台会校验
          limits: (vmq && vmq.answerLimitMap) ? {
            min: Number(vmq.answerLimitMap.min || 0),
            max: Number(vmq.answerLimitMap.max || 0),
          } : null,
          dom: el,
          vmq,
          images,
          blankCount: el.querySelectorAll(SELECTORS.practice.blankInput).length,
          decode: null,
          grade: 'A',
        });
      });
      return out;
    }

    /** 取本题在 vm.questionList 里的对象(用 vueIndex,不靠 index 反推) */
    function vmQuestion(q) {
      const vm = getVm();
      const list = (vm && vm.questionList) || [];
      const i = (typeof q.vueIndex === 'number') ? q.vueIndex : (q.index - 1);
      return list[i] || q.vmq || null;
    }

    /**
     * 填写答案:一律走"点 DOM"的方式,让平台自己的处理函数去改状态。
     * 直接改 Vue 数据虽然快,但会绕过平台格式(如多选的字母串/逗号串),容易出现"填了但没生效"。
     */
    function fillPracticeAnswer(q, parsed) {
      const vmq = vmQuestion(q);
      if (!vmq) return { ok: false, message: '题目数据缺失' };
      const pa = vmq.personAnswer || {};

      if (q.type === 'blank') {
        const inputs = q.dom.querySelectorAll(SELECTORS.practice.blankInput);
        const parts = parsed.blanks || [];
        if (!inputs.length) return { ok: false, message: '未找到填空框' };
        if (parts.length !== inputs.length) {
          return { ok: false, message: `填空数量不符(模型给 ${parts.length} 个,题目需 ${inputs.length} 个)` };
        }
        inputs.forEach((el, i) => {
          el.value = parts[i];
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return { ok: true };
      }

      if (q.type === 'subjective') {
        const ta = q.dom.querySelector(SELECTORS.practice.shortInput);
        if (!ta) return { ok: false, message: '未找到简答输入框' };
        const text = parsed.text || parsed.display || '';
        if (!text) return { ok: false, message: '未生成简答内容' };
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }

      // 选择/判断/多选:点选项 li(平台自己的处理函数负责改状态)
      const want = new Set(parsed.letters || []);
      if (!want.size) return { ok: false, message: '未解析出选项字母' };
      if (q.type === 'multi') {
        // 多选是"切换"语义:先算出与目标的差集,只点需要改的项。
        // 平台的 myoption 存的是平台自己的选项名(判断题是 "1"/"2",多选是字母)。
        const lim = q.limits || null;
        if (lim && lim.max > 0 && want.size > lim.max) {
          return { ok: false, message: `选了 ${want.size} 项,超过平台上限 ${lim.max} 项` };
        }
        if (lim && lim.min > 0 && want.size < lim.min) {
          return { ok: false, message: `选了 ${want.size} 项,少于平台下限 ${lim.min} 项` };
        }
        const cur = new Set(parseMultiSet(pa.myoption));
        q.optEls.forEach((el, k) => {
          const v = q.optValues[k];
          const shouldHave = want.has(q.optLabels[k]);
          const has = cur.has(v);
          if (shouldHave !== has) el.click();
        });
        return { ok: true };
      }
      const idx = q.optLabels.findIndex((L) => want.has(L));
      if (idx < 0) return { ok: false, message: `选项 ${Array.from(want).join('')} 不在题目选项中` };
      q.optEls[idx].click();
      return { ok: true };
    }

    /** 把"展示给模型的字母"换成"平台真实取值"(判断题 A→"1") */
    function platformValuesOf(q, letters) {
      return letters.map((L) => {
        const i = (q.optLabels || []).indexOf(L);
        if (i < 0) return L;
        return (q.optValues && q.optValues[i]) || L;
      }).sort();
    }

    /** 回读平台作答状态,与意图比对 */
    function readPracticeAnswer(q) {
      const vmq = vmQuestion(q);
      if (!vmq || !vmq.personAnswer) return '';
      const pa = vmq.personAnswer;
      if (q.type === 'blank') {
        const arr = pa.blankAnswer || [];
        return arr.map((b) => String((b && b.content) || '').trim()).join('|');
      }
      if (q.type === 'subjective') return String(pa.content || '').trim();
      // 多选:平台存的是字母串(判断题是 "1,2"),统一解析成集合再排序
      return Array.from(parseMultiSet(pa.myoption)).sort().join('');
    }

    /** 题目标记 */
    function setPracticeBadge(q, text, state) {
      if (!q.dom) return;
      let b = q.dom.querySelector('.autocx-badge');
      if (!b) {
        b = document.createElement('span');
        b.className = 'autocx-badge';
        b.style.cssText = 'margin-left:8px;padding:1px 6px;border-radius:3px;font-size:12px;';
        const host = q.dom.querySelector(SELECTORS.practice.title) || q.dom;
        host.appendChild(b);
      }
      const colors = { thinking: '#63b4ff', ok: '#21d181', bad: '#ff4d4f', doubt: '#f59e0b' };
      b.textContent = text;
      b.style.background = colors[state] || '#999';
      b.style.color = '#fff';
    }

    /** 提交:点 .submit-btn,若平台弹二次确认框则点确认 */
    async function submitPractice(vm) {
      const btn = document.querySelector(SELECTORS.practice.submit);
      if (!btn) {
        log.warn(module, '未找到提交按钮(可能已提交或活动已结束)');
        report(module, 'review', '未找到提交按钮');
        return;
      }
      log.info(module, '点击提交按钮…');
      report(module, 'submitting', '正在提交');
      btn.click();
      // 平台弹确认框(有未答题时)需要再点一次确认
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const ok = document.querySelector(SELECTORS.practice.submitConfirm);
        if (ok) {
          const t = (ok.textContent || '').trim();
          // 只点"确定/提交"类按钮,取消类一律不点
          if (/^(Submit|OK|Ok|ok|确定|确认|提交)$/.test(t)) {
            log.info(module, `点击确认弹窗 ${t}`);
            ok.click();
          } else {
            log.warn(module, `确认弹窗按钮为「${t}」,不自动确认`);
            report(module, 'review', '提交需人工确认');
            return;
          }
          break;
        }
      }
      // 等平台结果:提交成功后 .submit-btn 会消失(active.status 变 2)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (!document.querySelector(SELECTORS.practice.submit)) {
          log.info(module, '随堂练习提交成功 ✅');
          report(module, 'submitted', '提交成功');
          return;
        }
      }
      log.warn(module, '提交结果未确认,请检查页面');
      report(module, 'error', '提交结果未确认');
    }
  }

  /* ============================== 通用:反后台节流 ========================= */
  // 1) 伪装页面可见性:学习通在 visibilitychange 时会暂停视频/停止接收进度,
  //    劫持 hidden/visibilityState 并阻断事件,让页面以为标签始终在前台
  function spoofVisibility() {
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      const block = (e) => { e.stopImmediatePropagation(); };
      document.addEventListener('visibilitychange', block, true);
      window.addEventListener('visibilitychange', block, true);
      // 防挂机补强:学习通顶层页监听 document mouseout(relatedTarget=null = 鼠标离开视口)
      // 并跨帧暂停视频。只拦截"离开视口"这一种,页内悬停交互不受影响。
      const leaveGuard = (e) => {
        if (!e.relatedTarget) e.stopImmediatePropagation();
      };
      document.addEventListener('mouseout', leaveGuard, true);
      document.addEventListener('mouseleave', leaveGuard, true);
    } catch (e) {
      log.warn('antithrottle', '可见性伪装失败: ' + e.message);
    }
  }
  // 2) Web Worker 心跳:Chrome 后台标签把 window 定时器节流到最狠 1 分钟一次,
  //    Worker 定时器不受此限。CSP 可能拦截 blob worker,失败退回普通定时器。
  function startHeartbeat(cb, ms) {
    try {
      const blob = new Blob([`setInterval(()=>postMessage(1),${ms})`], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = cb;
      return () => worker.terminate();
    } catch (e) {
      log.warn('antithrottle', 'Worker 心跳不可用(CSP?),退回普通定时器: ' + e.message);
      const t = setInterval(cb, ms);
      return () => clearInterval(t);
    }
  }

  /* ============================== knowledge-frame ========================= */
  // 任务点容器帧:轮询 .ans-job-finished(权威完成标记),上报给顶层切换任务。
  // 兜底:卡片里既没有完成标记,也没有可自动处理的嵌套帧(视频/文档/测验)时,
  // 说明这个任务点只能人工做(例如「自主学习资料」只有外链),否则助手会永远卡在这一页。
  // 这时上报 job-idle,让顶层换到下一个任务点(该任务点仍需人工完成,平台侧保持未完成)。
  function initKnowledgeFrame() {
    const module = 'knowledge';
    spoofVisibility();
    const AUTO_FRAME = /\/ananas\/modules\/(video|audio|pdf|ppt|pptdemo|innertemplet|book|read|work)/i;
    const started = Date.now();
    let reported = false;
    const hasAutoFrame = () => {
      try {
        if (document.querySelector('video')) return true; // 本帧内嵌播放器
        return Array.prototype.some.call(document.querySelectorAll('iframe'), (f) => AUTO_FRAME.test(f.src || ''));
      } catch (_) { return false; }
    };
    const hasDocUI = () => {
      try { return !!document.querySelector('.imglook_next, .page-next'); } catch (_) { return false; }
    };
    const check = () => {
      if (reported) return;
      if (document.querySelector('.ans-job-finished')) {
        reported = true;
        log.info(module, '检测到任务点完成标记(.ans-job-finished)');
        report(module, 'job-done', '当前任务点已完成');
        return;
      }
      // 兜底:25 秒后仍看不到可自动处理的嵌套帧 -> 判定为「只能人工」的任务点
      if (Date.now() - started < 25000) return;
      if (hasAutoFrame() || hasDocUI()) return;
      reported = true;
      log.warn(module, '该任务点没有可自动完成的内容(需人工),上报跳过');
      report(module, 'job-idle', '该任务点无可自动完成的内容,跳过');
    };
    setInterval(check, 3000);
    setTimeout(check, 1500);
  }


  // 页面真实播放 + 倍速 + 静音;弹题随机作答;风控验证暂停等人工;完成检测上报
  function initVideoFrame() {
    const module = 'video';
    if (config.get('assist.video') === false) {
      log.info(module, '看课助手已关闭,跳过');
      report(module, 'disabled', '看课助手已关闭');
      return;
    }
    report(module, 'start', '视频任务启动');
    log.info(module, '视频任务启动');
    spoofVisibility(); // 防止后台标签被暂停/停收进度
    let done = false;
    let riskPaused = false;
    onJobDone(module, () => { done = true; });

    // ---- 风控验证检测(滑块等):出现则暂停,消失自动恢复 ----
    setInterval(() => {
      const risk = $(SELECTORS.video.riskVerify).filter(':visible').length > 0;
      if (risk && !riskPaused) {
        riskPaused = true;
        log.warn(module, '检测到风控验证,已暂停,请人工完成');
        report(module, 'risk', '出现风控验证,等待人工处理');
      } else if (!risk && riskPaused) {
        riskPaused = false;
        log.info(module, '风控验证已解除,继续播放');
        report(module, 'resume', '风控解除,继续');
      }
    }, 2000);

    // ---- 视频中途弹题:随机选一选项提交(答错不阻断播放) ----
    let popupHandling = false;
    elmGetter.each(SELECTORS.video.popupQuiz, (el) => {
      if (popupHandling || done) return;
      popupHandling = true;
      log.info(module, '检测到视频弹题,随机作答');
      setTimeout(() => {
        try {
          const $opt = $(SELECTORS.video.popupOption).filter(':visible');
          if ($opt.length) $opt.get(Math.floor(Math.random() * $opt.length)).click();
          setTimeout(() => {
            const $btn = $(SELECTORS.video.popupSubmit).filter(':visible');
            if ($btn.length) $btn.get(0).click();
            popupHandling = false;
          }, 400 + Math.random() * 600);
        } catch (e) {
          log.warn(module, '弹题处理异常: ' + e.message);
          popupHandling = false;
        }
      }, 500 + Math.random() * 800);
    });

    // ---- 视频元素控制 ----
    elmGetter.get(SELECTORS.video.player, 30000).then((video) => {
      log.info(module, '找到 video 元素,开始控制播放');
      const markDone = () => {
        if (done) return;
        done = true;
        log.info(module, '视频播放结束');
        report(module, 'done', '视频播放完成');
      };
      video.addEventListener('ended', markDone);
      const apply = () => {
        // 播完即停手,否则会把暂停的播放器重新唤醒造成无限重播
        if (video.ended) return markDone();
        if (done || riskPaused || !isEnabled()) return;
        try {
          const mute = !!config.get('video.mute');
          if (video.muted !== mute) video.muted = mute;
          const speed = Math.min(16, Math.max(1, Number(config.get('video.speed')) || 2));
          if (Math.abs(video.playbackRate - speed) > 0.01) video.playbackRate = speed;
          if (video.paused) {
            video.play().catch(() => {
              // 浏览器自动播放限制:尝试点击播放按钮
              const btn = $('.vjs-big-play-button, .vjs-play-control, .xgplayer-start, .play-btn')
                .filter(':visible').get(0);
              if (btn) btn.click();
            });
          }
        } catch (e) { log.debug(module, '控制异常: ' + e.message); }
      };
      apply();
      // Worker 心跳驱动控制循环:后台标签不受 window 定时器节流影响
      startHeartbeat(apply, 3000);
      // 停滞检测:播放中但进度 15 秒不动,强制恢复(后台暂停/卡顿兜底)
      let lastT = -1, stallCount = 0;
      startHeartbeat(() => {
        if (done || riskPaused || !isEnabled()) return;
        if (video.paused || video.ended) { lastT = -1; stallCount = 0; return; }
        if (lastT >= 0 && Math.abs(video.currentTime - lastT) < 0.5) {
          if (++stallCount >= 3) {
            stallCount = 0;
            log.warn(module, '检测到播放停滞,强制恢复');
            report(module, 'stall', '播放停滞,已强制恢复');
            video.play().catch(() => {});
          }
        } else {
          stallCount = 0;
        }
        lastT = video.currentTime;
      }, 5000);

      // 进度上报(每 30 秒)
      setInterval(() => {
        if (!done && video.duration > 0) {
          const pct = Math.round(video.currentTime / video.duration * 100);
          report(module, 'playing', `播放中 ${pct}% (${Math.round(video.currentTime)}s/${Math.round(video.duration)}s, ${video.playbackRate}x)`);
        }
      }, 30000);
    }).catch(() => {
      log.error(module, '等待 video 元素超时(30s),页面结构可能已改版');
      report(module, 'error', '未找到 video 元素');
    });
  }

  // 顶层帧注册菜单:任意时候都能打开作答记录(单独打开答卷页时也没有别的入口)
  if (window.top === window.self) {
    try {
      GM_registerMenuCommand('打开 AI 作答记录', () => { AIW.ensure().open(); });
    } catch (e) { log.debug('bootstrap', '注册菜单命令失败: ' + e.message); }
  }

  const role = detectRole();
  if (!role) {
    // 非目标帧,静默退出
    return;
  }
  log.info('bootstrap', `角色识别: ${role} @ ${location.hostname}${location.pathname}`);

  switch (role) {
    case 'top':
      spoofVisibility(); // 顶层页是 mouseout 防挂机检测所在帧
      initTopPanel();
      initTopAdvance();
      // 调试钩子(与 __autocxQuiz 同一约定):离线核对窗口界面,不影响正常流程
      try {
        const pw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        pw.__autocxAI = {
          open: () => AIW.ensure().open(),
          close: () => { if (AIW.api) AIW.api.close(); },
          index: () => GM_getValue(AI_INDEX) || [],
          demo: () => { const sid = seedDemo(); AIW.ensure().open(); return sid; },
          clear: (sid) => {
            const target = sid || 'demo';
            let idx = [];
            try { idx = GM_getValue(AI_INDEX) || []; } catch (_) { idx = []; }
            if (!Array.isArray(idx)) idx = [];
            const item = idx.find((it) => it && it.sid === target);
            aibus.drop(target, item ? item.count : 12);
            try { GM_deleteValue(AI_S(target)); } catch (_) { /* 忽略 */ }
            try { GM_deleteValue(AI_PING); } catch (_) { /* 忽略 */ }
            aibus.put(AI_INDEX, idx.filter((it) => it && it.sid !== target));
            return 'cleared:' + target;
          },
        };
      } catch (e) { log.debug('ai', '调试钩子暴露失败: ' + e.message); }
      break;
    case 'knowledge':
      initKnowledgeFrame();
      break;
    case 'video':
    case 'audio':
      initVideoFrame();
      break;
    case 'doc':
    case 'book':
      initDocFrame();
      break;
    case 'quiz':
      // 有人会直接在新标签页打开答卷:这时候没有顶层悬浮面板,窗口只能挂在本帧
      if (window.top === window.self) {
        try { AIW.ensure(); } catch (e) { log.warn('ai', '挂载作答记录失败: ' + e.message); }
      }
      initQuizPage();
      break;
    case 'practice':
      // 随堂练习页自带 Vue2,作答记录窗口用我们自己的 Vue3 挂载
      if (window.top === window.self) {
        try { AIW.ensure(); } catch (e) { log.warn('ai', '挂载作答记录失败: ' + e.message); }
      }
      initPracticePage();
      break;
  }

})();

