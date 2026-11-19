// ==UserScript==
// @name         AutoCX 学习通自动看课+LLM答题助手
// @namespace    autocx
// @version      0.11.1
// @description  学习通自动看课(视频/文档课件)+LLM辅助章节测验答题,附「AI 作答记录」窗口:请求/思考/回答全程留痕。轻量单文件,基于 jQuery + ElementGetter + Ajax-hook。
// @author       autocx
// @license      MIT
// @homepage     https://github.com/lianjishu/autocx
// @supportURL   https://github.com/lianjishu/autocx/issues
// @icon         https://pan-yz.chaoxing.com/favicon.ico
// @match        *://*.chaoxing.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// @require      https://cdn.jsdelivr.net/gh/wendux/Ajax-hook@master/dist/ajaxhook.min.js
// @require      https://scriptcat.org/lib/513/2.1.0/ElementGetter.js
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
      question: '.questionLi, .TiMu, .question-item, .question-wrapper', // 单题容器
      title: '.mark_name, .qyh-tit, .topic-title, .fontLabel, .question-title', // 题干
      optionList: 'ul li, .answerBg, .num_option, .choose-item',          // 选项
      blankInput: 'input[type=text], textarea',                           // 填空输入
      submit: '.btnSubmit, .btn-submit, .submitBtn, a[onclick*="btnBlueSubmit"], a[onclick*="submit"]', // 答卷页提交按钮
      submitConfirm: '.popBottom a.jb_btn, a.jb_btn', // workPop 确认弹窗按钮(在顶层页)
      captchaWin: '#verifyCodeWin',                  // 验证码弹窗(出现则转人工)
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
    'quiz.double_check': true, // 两答一致性校验:同题问两遍,不一致标记存疑不填
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
  // 返回: 'top' | 'video' | 'audio' | 'doc' | 'book' | 'quiz' | null
  function detectRole() {
    const { hostname, pathname, href } = location;
    const path = pathname.toLowerCase();

    // 任务点 iframe: ananas 模块(收紧到播放器主页,排除 subtitle-bridge 等辅助页)
    if (/\/ananas\/modules\/video\/index\.html/.test(path)) return 'video';
    if (/\/ananas\/modules\/audio\/index\.html/.test(path)) return 'audio';
    if (/\/ananas\/modules\/(pdf|ppt|pptdemo)\//.test(path)) return 'doc';
    if (/\/ananas\/modules\/(innertemplet|book|read)\//.test(path)) return 'book';

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

  /* ============================== 总开关 =================================== */
  function isEnabled() {
    return config.get('autocx.enabled') !== false;
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
          messages: [{ role: 'user', content: prompt }],
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
  };

  /* ============================== AI 作答记录窗口 =========================== */
  // 只读窗口:脚本请求 → 模型思考 → 模型回答 → 解析/勾选/校验 → 提交轨迹。
  // 顶层帧挂载;若某帧自己就是顶层(单独打开答卷页),也在本帧挂载。
  // 模型输出是不可信数据:一律 esc() 转义后写入 DOM,绝不拼原始 HTML。
  const AIW = {
    api: null,
    ensure() {
      if (!this.api) this.api = createAIWindow();
      return this.api;
    },
  };

  function createAIWindow() {
    GM_addStyle(`
      #autocx-ai{position:fixed;inset:0;z-index:2147483647;pointer-events:none}
      #autocx-ai .cxai-win{position:fixed;display:none;flex-direction:column;
        width:900px;height:640px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);
        background:#fff;border-radius:14px;overflow:hidden;pointer-events:auto;
        border:1px solid rgba(229,231,235,.9);
        box-shadow:0 2px 4px rgba(17,24,39,.05),0 22px 60px rgba(17,24,39,.22);
        font:13px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#111827}
      #autocx-ai.open .cxai-win{display:flex}
      /* 头部 */
      #autocx-ai .cxai-bar{flex:none;height:52px;display:flex;align-items:center;gap:10px;padding:0 12px 0 14px;
        border-bottom:1px solid #E8ECF3;background:linear-gradient(180deg,#fff,#FCFDFF);cursor:grab;user-select:none}
      #autocx-ai .cxai-bar:active{cursor:grabbing}
      #autocx-ai .cxai-logo{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;
        color:#fff;font-weight:700;font-size:11.5px;letter-spacing:.4px;
        background:linear-gradient(140deg,#3B7CFF,#6FA8FF);box-shadow:0 3px 10px rgba(59,124,255,.32)}
      #autocx-ai .cxai-titles{min-width:0}
      #autocx-ai .cxai-titles h1{font-size:13.5px;font-weight:650;letter-spacing:.1px;margin:0}
      #autocx-ai .cxai-titles p{font-size:11px;color:#98A1B0;margin:1px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
      #autocx-ai .cxai-grow{flex:1}
      #autocx-ai .cxai-pill{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid #E8ECF3;
        color:#4B5563;background:#FBFCFE;white-space:nowrap;font-family:Consolas,monospace}
      #autocx-ai .cxai-pill:empty{display:none}
      #autocx-ai .cx-model{max-width:230px;overflow:hidden;text-overflow:ellipsis}
      #autocx-ai .cxai-icon{width:26px;height:26px;border-radius:7px;border:1px solid transparent;background:none;
        color:#8A94A6;cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center}
      #autocx-ai .cxai-icon:hover{background:#F2F5FA;border-color:#E8ECF3;color:#4B5563}
      /* 主体 */
      #autocx-ai .cxai-body{flex:1;display:flex;min-height:0}
      #autocx-ai .cxai-rail{width:224px;flex:none;background:#F7F9FC;border-right:1px solid #E8ECF3;
        display:flex;flex-direction:column;min-height:0}
      #autocx-ai .cxai-rail-head{padding:12px 14px 8px;display:flex;align-items:center;justify-content:space-between}
      #autocx-ai .cxai-rail-head b{font-size:11.5px;color:#4B5563;font-weight:600}
      #autocx-ai .cxai-rail-head span{font-size:11px;color:#98A1B0}
      #autocx-ai .cxai-items{flex:1;overflow:auto;padding:2px 8px 8px}
      #autocx-ai .cxai-item{display:flex;gap:9px;padding:9px 10px;border-radius:10px;cursor:pointer}
      #autocx-ai .cxai-item+.cxai-item{margin-top:2px}
      #autocx-ai .cxai-item:hover{background:#EFF3FA}
      #autocx-ai .cxai-item.on{background:#fff;box-shadow:0 1px 2px rgba(17,24,39,.05),0 0 0 1px #E6ECF6}
      #autocx-ai .cxai-item .n{font:10.5px Consolas,monospace;color:#9AA5B6;width:16px;flex:none;padding-top:2px}
      #autocx-ai .cxai-item.on .n{color:#3B7CFF}
      #autocx-ai .cxai-item .tx{min-width:0;flex:1}
      #autocx-ai .cxai-item .q{font-size:12px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #autocx-ai .cxai-item .st{display:flex;align-items:center;gap:5px;margin-top:3px;font-size:10.5px;color:#98A1B0}
      #autocx-ai .cxai-dot{width:6px;height:6px;border-radius:50%;background:#CBD3DF;flex:none}
      #autocx-ai .cxai-dot.ok{background:#22C55E}
      #autocx-ai .cxai-dot.live{background:#7C5CE0;animation:cxai-pulse 1.4s infinite}
      #autocx-ai .cxai-dot.bad{background:#EF4444}
      @keyframes cxai-pulse{0%,100%{box-shadow:0 0 0 0 rgba(124,92,224,.45)}50%{box-shadow:0 0 0 4px rgba(124,92,224,0)}}
      #autocx-ai .cxai-rail-foot{flex:none;border-top:1px solid #E8ECF3;padding:10px 14px 12px;background:#FBFCFE}
      #autocx-ai .cxai-rail-foot p{font-size:10.5px;color:#98A1B0;display:flex;justify-content:space-between;margin:0}
      #autocx-ai .cxai-rail-foot p b{color:#4B5563;font-weight:600}
      #autocx-ai .cxai-meter{height:4px;border-radius:2px;background:#E7ECF4;overflow:hidden;margin:7px 0 6px}
      #autocx-ai .cxai-meter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3B7CFF,#7FA9FF);transition:width .3s}
      /* 主线程 */
      #autocx-ai .cxai-main{flex:1;display:flex;flex-direction:column;min-width:0;background:#fff}
      #autocx-ai .cxai-session{flex:none;display:flex;align-items:center;gap:7px;flex-wrap:wrap;
        padding:11px 22px 10px;font-size:11px;color:#94A0B2;border-bottom:1px solid #F1F4F9}
      #autocx-ai .cxai-session:empty{display:none}
      #autocx-ai .cxai-session .k{color:#5B6678}
      #autocx-ai .cxai-session .m{font-family:Consolas,monospace;font-size:10.5px;color:#AAB3C0}
      #autocx-ai .cxai-sm{font-size:10.5px;padding:1px 7px;border-radius:5px;background:#F1F4F9;color:#64748B}
      #autocx-ai .cxai-thread{flex:1;overflow:auto;padding:16px 22px 6px}
      #autocx-ai .cxai-empty{color:#A9B3C2;font-size:12.5px;line-height:1.9;padding:8px 0}
      #autocx-ai .cxai-turn{padding-bottom:16px}
      #autocx-ai .cxai-turn+.cxai-turn{border-top:1px dashed #F1F4F9;padding-top:16px}
      #autocx-ai .cxai-turn-head{display:flex;align-items:center;gap:8px;margin-bottom:11px}
      #autocx-ai .cxai-idx{font:11px Consolas,monospace;color:#fff;background:#3B7CFF;border-radius:5px;padding:1px 6px}
      #autocx-ai .cxai-q{font-size:12.5px;color:#374151;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #autocx-ai .cxai-chip{font-size:10.5px;padding:1px 7px;border-radius:5px;background:#F1F4F9;color:#64748B;white-space:nowrap}
      #autocx-ai .cxai-chip.v{background:#F6F3FF;color:#6D49D6}
      /* 已完成轮次:一行回执 */
      #autocx-ai .cxai-receipt{display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid #E8ECF3;
        border-radius:10px;background:#FCFDFF;cursor:pointer}
      #autocx-ai .cxai-receipt:hover{background:#F7F9FD;border-color:#DDE5F1}
      #autocx-ai .cxai-receipt .cxai-idx{background:#94A3B8}
      #autocx-ai .cxai-receipt .q{font-size:12px;color:#4B5563;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #autocx-ai .cxai-key{font:600 12px Consolas,monospace;color:#fff;background:#111827;border-radius:5px;padding:1px 8px;letter-spacing:1px}
      #autocx-ai .cxai-key.ok{background:#15803D}
      #autocx-ai .cxai-key.bad{background:#B91C1C}
      #autocx-ai .cxai-okn{font-size:11px;color:#15803D;white-space:nowrap}
      #autocx-ai .cxai-badn{font-size:11px;color:#B91C1C;white-space:nowrap}
      #autocx-ai .cxai-m{font-family:Consolas,monospace;font-size:10.5px;color:#AAB3C0;white-space:nowrap}
      #autocx-ai .cxai-caret-r{color:#A9B3C2;font-size:10px;transform:rotate(90deg);display:inline-block}
      /* 请求块 */
      #autocx-ai .cxai-req{border:1px solid #E8ECF3;border-radius:10px;background:#FCFDFF;overflow:hidden;margin-bottom:10px}
      #autocx-ai .cxai-req-row{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:11.5px;color:#5B6678;cursor:pointer}
      #autocx-ai .cxai-req-row .who{color:#334155}
      #autocx-ai .cxai-req-row .arrow{color:#3B7CFF;font-weight:600}
      #autocx-ai .cxai-req-body{border-top:1px solid #F1F4F9;padding:10px 12px;background:#fff;display:none}
      #autocx-ai .cxai-req.open .cxai-req-body{display:block}
      #autocx-ai .cxai-req-body pre{font:11px/1.6 Consolas,monospace;color:#4B5563;white-space:pre-wrap;word-break:break-word;margin:0}
      #autocx-ai .cxai-tags{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
      /* 思考块 */
      #autocx-ai .cxai-think{border-left:2px solid #D9CCFA;background:linear-gradient(180deg,#FAF8FF,#FEFDFF);
        border-radius:0 10px 10px 0;padding:9px 12px 10px;margin-bottom:10px}
      #autocx-ai .cxai-think-head{display:flex;align-items:center;gap:7px;font-size:11.5px;color:#6D49D6;margin-bottom:5px}
      #autocx-ai .cxai-think-head .lbl{font-weight:600}
      #autocx-ai .cxai-think-head .time{font-family:Consolas,monospace;font-size:10.5px;color:#A78BFA}
      #autocx-ai .cxai-think-body{font-size:12px;line-height:1.7;color:#5B5470;white-space:pre-wrap;word-break:break-word;margin:0}
      #autocx-ai .cxai-think.collapsed .cxai-think-body{display:none}
      #autocx-ai .cxai-think-head{cursor:pointer}
      #autocx-ai .cxai-cursor{display:inline-block;width:6px;height:13px;background:#8B5CF6;vertical-align:-2px;margin-left:2px;
        border-radius:1px;animation:cxai-blink 1s steps(2) infinite}
      @keyframes cxai-blink{50%{opacity:0}}
      @media (prefers-reduced-motion:reduce){#autocx-ai .cxai-cursor,#autocx-ai .cxai-dot.live{animation:none}}
      /* 回答块 */
      #autocx-ai .cxai-ans{border:1px solid #E8ECF3;border-radius:10px;padding:10px 12px 11px;background:#fff}
      #autocx-ai .cxai-ans-head{display:flex;align-items:center;gap:7px;font-size:11.5px;color:#64748B;margin-bottom:6px}
      #autocx-ai .cxai-ans-head .lbl{font-weight:600;color:#334155}
      #autocx-ai .cxai-ans-head .time{font-family:Consolas,monospace;font-size:10.5px;color:#AAB3C0}
      #autocx-ai .cxai-ans-body{font-size:13px;line-height:1.75;color:#1F2937;white-space:pre-wrap;word-break:break-word;margin:0}
      #autocx-ai .cxai-ans-body.pending{color:#A9B3C2;font-size:12.5px}
      #autocx-ai .cxai-verdict{display:flex;align-items:center;gap:7px;margin-top:9px;padding-top:9px;
        border-top:1px dashed #F1F4F9;flex-wrap:wrap;font-size:11.5px;color:#64748B}
      #autocx-ai .cxai-sep{width:1px;height:12px;background:#E8ECF3}
      #autocx-ai .cxai-foot2{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:10.5px;color:#A9B3C2}
      #autocx-ai .cxai-foot2 .acts{margin-left:auto;display:flex;gap:4px}
      #autocx-ai .cxai-foot2 button{font:11px inherit;color:#7C8798;background:none;border:1px solid transparent;
        border-radius:6px;padding:2px 7px;cursor:pointer}
      #autocx-ai .cxai-foot2 button:hover{background:#F3F6FA;border-color:#E8ECF3;color:#475569}
      /* 错误 / 提交事件 */
      #autocx-ai .cxai-err{border:1px solid #FCE4E4;background:#FEF7F7;border-radius:10px;padding:10px 12px;
        font-size:12px;color:#B91C1C;line-height:1.7}
      #autocx-ai .cxai-err b{color:#991B1B}
      #autocx-ai .cxai-submit-card{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:10px;
        background:linear-gradient(180deg,#FFFCF5,#FEF8EC);border:1px solid #F2E6CC;font-size:11.5px;color:#8A6A2F}
      #autocx-ai .cxai-submit-card b{color:#B45309}
      #autocx-ai .cxai-submit-card ul{margin:4px 0 0;padding-left:16px}
      /* 底部 */
      #autocx-ai .cxai-note{flex:none;display:flex;align-items:center;gap:6px;border-top:1px solid #E8ECF3;
        padding:9px 20px;background:#FCFDFF;font-size:10.5px;color:#A9B3C2}
      #autocx-ai .cxai-note b{color:#7C8798;font-weight:600;letter-spacing:.2px;margin-right:2px}
      #autocx-ai .cxai-note-r{margin-left:auto;color:#B6BFCC;white-space:nowrap}
      #autocx-ai .cxai-note-r a{color:#8A94A6;text-decoration:none}
      #autocx-ai .cxai-note-r a:hover{color:#3B7CFF;text-decoration:underline}
      #autocx-ai .cxai-status{flex:none;display:flex;align-items:center;gap:9px;padding:9px 16px;
        border-top:1px solid #F2E6CC;background:linear-gradient(180deg,#FFFCF5,#FEF8EC);font-size:11px;color:#8A6A2F}
      #autocx-ai .cxai-status b{color:#B45309;font-weight:600}
      #autocx-ai .cxai-status .right{margin-left:auto;display:flex;align-items:center;gap:8px;color:#8B9099}
      #autocx-ai .cxai-status .right .cxai-sm{background:#EAF1FF;color:#2E6BD6}
    `);

    const esc = escHtml; // 本模块内的简写
    const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
    const sec = (ts) => (ts ? new Date(ts).toTimeString().slice(0, 8) : '');
    const dur = (ms) => {
      if (!ms || ms < 0) return '';
      return ms < 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 100) / 10 + 's';
    };
    const TYPE = { single: '单选', multi: '多选', judge: '判断', blank: '填空' };
    const LIVE = { queued: 1, requesting: 1, thinking: 1, answering: 1 };
    const state = {
      sid: null, meta: null, convs: new Map(), order: [],
      offs: [], submitEvents: [], openReq: new Set(), openTurn: new Set(),
      pinned: true, raf: 0,
    };

    const $win = $(`<div id="autocx-ai"><div class="cxai-win">
      <header class="cxai-bar">
        <div class="cxai-logo">CX</div>
        <div class="cxai-titles"><h1>AI 作答记录</h1><p class="cxai-sub">等待测验…</p></div>
        <div class="cxai-grow"></div>
        <span class="cxai-pill cx-model"></span>
        <span class="cxai-pill cx-effort"></span>
        <button class="cxai-icon" data-a="copy" title="复制全部记录">⧉</button>
        <button class="cxai-icon" data-a="close" title="关闭 (Esc)">×</button>
      </header>
      <div class="cxai-body">
        <aside class="cxai-rail">
          <div class="cxai-rail-head"><b>本次测验</b><span class="cxai-rail-meta"></span></div>
          <div class="cxai-items"></div>
          <div class="cxai-rail-foot">
            <p><span>已答</span><b class="cxai-done">0 / 0</b></p>
            <div class="cxai-meter"><i></i></div>
            <p><span class="cxai-left">等待开始</span><b class="cxai-fail"></b></p>
          </div>
        </aside>
        <main class="cxai-main">
          <div class="cxai-session"></div>
          <div class="cxai-thread"><div class="cxai-empty">还没有记录。<br>测验页开始答题后,脚本发出的每一次请求都会出现在这里。</div></div>
          <div class="cxai-note"><b>只读记录</b>不提供输入、不改答案;模型输出按纯文本转义展示。
            <span class="cxai-note-r">AutoCX v${VERSION} · <a href="${REPO.github}" target="_blank" rel="noopener noreferrer">仓库</a></span></div>
        </main>
      </div>
      <footer class="cxai-status">
        <span class="cxai-submit"></span>
        <span class="right"><span class="cxai-pill cx-key"></span><span class="cxai-pill cx-host"></span></span>
      </footer>
    </div></div>`);
    $(document.body || document.documentElement).append($win);

    /* ---------- 订阅与数据 ---------- */
    const safeGet = (k) => { try { return GM_getValue(k); } catch (_) { return undefined; } };

    function unbind() {
      state.offs.forEach((off) => { try { off(); } catch (_) { /* 忽略 */ } });
      state.offs = [];
      state.convs.clear();
      state.order = [];
    }

    function bind(sid) {
      if (state.sid === sid) return;
      unbind();
      state.sid = sid;
      state.meta = null;
      state.submitEvents = [];
      if (!sid) { draw(); return; }
      const meta = safeGet(AI_S(sid));
      state.offs.push(aibus.on(AI_S(sid), (m) => { if (m) applyMeta(m); }));
      if (meta) applyMeta(meta);
      draw();
    }

    function applyMeta(meta) {
      state.meta = meta;
      state.submitEvents = Array.isArray(meta.events) ? meta.events.slice() : [];
      const count = Number(meta.count) || 0;
      const bound = new Set(state.order);
      for (let i = 1; i <= count; i++) {
        const n = i;
        if (bound.has(n)) continue;
        const cur = safeGet(AI_C(state.sid, n));
        if (cur) {
          state.convs.set(n, cur);
          if (!state.order.includes(n)) state.order.push(n);
        }
        state.offs.push(aibus.on(AI_C(state.sid, n), (v) => { if (v) { state.convs.set(n, v); upsertOrder(n); schedule(); } }));
      }
      state.order.sort((a, b) => a - b);
      schedule();
    }

    function upsertOrder(n) {
      if (!state.order.includes(n)) { state.order.push(n); state.order.sort((a, b) => a - b); }
    }

    function schedule() {
      if (state.raf || !$win.hasClass('open')) return;
      state.raf = requestAnimationFrame(() => { state.raf = 0; draw(); });
    }

    /* ---------- 渲染 ---------- */
    function phaseInfo(c) {
      const t = c.t || {};
      const now = Date.now();
      if (c.phase === 'queued') return { dot: '', text: '排队中' };
      if (c.phase === 'requesting') return { dot: 'live', text: '请求中 · ' + dur(now - (t.reqAt || now)) };
      if (c.phase === 'thinking') return { dot: 'live', text: '思考中 · ' + dur(now - (t.reqAt || now)) };
      if (c.phase === 'answering') return { dot: 'live', text: '回答中 · ' + dur(now - (t.reqAt || now)) };
      if (c.phase === 'parsed') return { dot: 'live', text: '已解析 · ' + (c.result && c.result.display || '') };
      if (c.phase === 'filled') return { dot: 'ok', text: '已完成 · ' + (c.result && c.result.display || '') + (c.result && c.result.fillOk ? ' · 已勾选' : '') };
      if (c.phase === 'failed') return { dot: 'bad', text: '失败' + (c.error && c.error.message ? ' · ' + String(c.error.message).slice(0, 18) : '') };
      return { dot: '', text: c.phase || '' };
    }

    function draw() {
      drawHeader();
      drawRail();
      drawSession();
      drawThread();
      drawStatus();
    }

    function drawHeader() {
      const m = state.meta || {};
      $win.find('.cxai-sub').text(m.title || '等待测验…');
      $win.find('.cx-model').text(m.model || '');
      $win.find('.cx-effort').text(m.effort ? 'effort ' + m.effort : '');
      $win.find('.cx-key').text(m.keyTail ? '密钥 ●●●●' + m.keyTail : '');
      $win.find('.cx-host').text(m.host || '');
    }

    function drawRail() {
      const total = (state.meta && state.meta.count) || state.order.length;
      let done = 0;
      let bad = 0;
      state.order.forEach((n) => {
        const c = state.convs.get(n) || {};
        if (c.phase === 'filled' || c.phase === 'parsed') done++;
        if (c.phase === 'failed') bad++;
      });
      const $items = $win.find('.cxai-items').empty();
      state.order.forEach((n) => {
        const c = state.convs.get(n) || { n, phase: 'queued' };
        const info = phaseInfo(c);
        const on = (c.phase === 'requesting' || c.phase === 'thinking' || c.phase === 'answering') ? ' on' : '';
        $items.append([
          '<div class="cxai-item' + on + '" data-n="' + n + '">',
          '<div class="n">' + pad2(n) + '</div>',
          '<div class="tx"><div class="q">' + esc(c.stem || '(读取中)') + '</div>',
          '<div class="st"><i class="cxai-dot ' + info.dot + '"></i>' + esc(info.text) + '</div></div>',
          '</div>',
        ].join(''));
      });
      if (!state.order.length) $items.append('<div class="cxai-empty" style="padding:6px 10px">暂无题目</div>');
      $win.find('.cxai-rail-meta').text(state.meta && state.meta.concurrency ? state.meta.concurrency + ' 路并发' : '');
      $win.find('.cxai-done').text(done + ' / ' + total);
      $win.find('.cxai-meter i').css('width', total ? Math.round(done / total * 100) + '%' : '0%');
      $win.find('.cxai-left').text(state.meta && state.meta.submitState ? '提交' : '待你核对提交');
      $win.find('.cxai-fail').text(bad ? bad + ' 题失败' : (total - done > 0 ? (total - done) + ' 题未答' : '全部完成'));
    }

    function drawSession() {
      const m = state.meta;
      const $s = $win.find('.cxai-session');
      if (!m) { $s.empty(); return; }
      const parts = [];
      parts.push('<span class="k">提取</span><span class="cxai-sm">' + esc((m.count || 0) + ' 题 · ' + (m.source || '未知来源')) + '</span>');
      if (m.startAt) parts.push('<span class="m">' + esc(sec(m.startAt)) + '</span>');
      if (m.answeredAt) parts.push('<span class="k">→ 开始作答</span><span class="m">' + esc(sec(m.answeredAt)) + '</span>');
      if (m.concurrency) parts.push('<span class="k">→ 并发</span><span class="cxai-sm">' + m.concurrency + ' 路</span>');
      if (m.note) parts.push('<span class="cxai-sm">' + esc(m.note) + '</span>');
      $s.html(parts.join(''));
    }

    function drawThread() {
      const $t = $win.find('.cxai-thread');
      const top = $t[0] ? $t[0].scrollTop : 0;
      const nearBottom = !$t[0] || ($t[0].scrollHeight - $t[0].clientHeight - top < 40);
      const pinned = state.pinned || nearBottom;
      if (!state.order.length && !state.submitEvents.length) {
        $t.html('<div class="cxai-empty">还没有记录。<br>测验页开始答题后,脚本发出的每一次请求都会出现在这里。</div>');
        return;
      }
      // 正在跑的题优先;已完成的收成回执
      const active = state.order.filter((n) => LIVE[(state.convs.get(n) || {}).phase]);
      const doneList = state.order.filter((n) => !LIVE[(state.convs.get(n) || {}).phase]);
      $t.empty();
      doneList.forEach((n) => {
        const c = state.convs.get(n) || {};
        const isOpen = state.openTurn.has(n);
        if (!isOpen && (c.phase === 'filled' || c.phase === 'parsed')) { $t.append(receipt(c)); return; }
        $t.append(turn(c));
      });
      active.forEach((n) => { $t.append(turn(state.convs.get(n) || {})); });
      // 提交轨迹
      if (state.submitEvents.length) $t.append(submitCard());
      else if (state.order.length && !active.length && state.meta && state.meta.submitState !== 'done') {
        $t.append('<div class="cxai-submit-card" style="background:#FBFCFE;border-color:#E8ECF3;color:#7C8798">'
          + '⏸ ' + esc(state.meta.submitState === 'off' ? '自动提交已关闭:答案已填写,提交请你在答卷页自己点。' : '等待全部题目答完后再判断是否提交。')
          + '</div>');
      }
      if (pinned) $t.scrollTop($t[0].scrollHeight);
      state.pinned = false;
    }

    function receipt(c) {
      const info = phaseInfo(c);
      const $r = $('<div class="cxai-receipt"><span class="cxai-idx">' + pad2(c.n) + '</span>'
        + '<span class="cxai-chip">' + esc(TYPE[c.type] || '') + '</span>'
        + '<span class="q">' + esc(c.stem || '') + '</span></div>');
      const res = c.result || {};
      if (res.display) $r.append('<span class="cxai-key ' + (res.ok === false ? 'bad' : 'ok') + '">' + esc(res.display) + '</span>');
      if (res.fillOk) $r.append('<span class="cxai-okn">✓ 已勾选</span>');
      const t = c.t || {};
      if (t.doneAt) $r.append('<span class="cxai-m">' + esc(dur(t.doneAt - (t.reqAt || t.queuedAt || t.doneAt))) + '</span>');
      if (c.usage && c.usage.total_tokens) $r.append('<span class="cxai-m">' + c.usage.total_tokens + ' tok</span>');
      $r.append('<span class="cxai-caret-r">›</span>');
      $r.on('click', () => { state.openTurn.add(c.n); drawThread(); });
      return $r;
    }

    function turn(c) {
      const n = c.n;
      const info = phaseInfo(c);
      const $t = $('<section class="cxai-turn"></section>');
      $t.append('<div class="cxai-turn-head"><span class="cxai-idx">' + pad2(n) + '</span>'
        + '<span class="cxai-q">' + esc(c.stem || '') + '</span>'
        + '<span class="cxai-chip">' + esc(TYPE[c.type] || '') + '</span></div>');
      if (c.phase === 'queued') {
        $t.append('<div class="cxai-receipt" style="cursor:default"><span class="cxai-dot"></span>'
          + '<span class="q">排队中 —— 并发已占满,前面的题结束后自动开始</span></div>');
        return $t;
      }
      // 请求块
      const params = c.params || {};
      const $req = $('<div class="cxai-req"></div>');
      const $row = $('<div class="cxai-req-row"><span class="who">脚本</span><span class="arrow">→</span>'
        + '<span class="who">' + esc(params.model || 'model') + '</span>'
        + '<span class="cxai-m">' + esc(sec((c.t || {}).reqAt)) + '</span>'
        + '<span class="cxai-m">prompt ' + String((c.prompt || '').length) + ' 字</span>'
        + '<span class="cxai-caret-r" style="margin-left:auto">›</span></div>');
      $row.on('click', () => {
        const open = !$req.hasClass('open');
        $req.toggleClass('open', open);
        if (open) state.openReq.add(n); else state.openReq.delete(n);
        drawThread();
      });
      $req.append($row);
      const tags = [
        params.temperature != null ? 'temperature ' + params.temperature : '',
        'stream: ' + (c.streamed === false ? 'false' : 'true'),
        params.effort ? 'reasoning_effort: ' + params.effort : '',
        c.source ? '来源 ' + c.source : '',
      ].filter(Boolean).map((x) => '<span class="cxai-chip">' + esc(x) + '</span>').join('');
      $req.append('<div class="cxai-req-body"><pre>' + esc(c.prompt || '(未记录 prompt)') + '</pre>'
        + '<div class="cxai-tags">' + tags + '</div></div>');
      if (state.openReq.has(n) || c.phase === 'requesting') $req.addClass('open');
      $t.append($req);
      // 思考块
      if (c.thinking) {
        const expanded = !state.openTurn.has(-n); // 负数键表示"用户手动折叠/展开"
        $t.append('<div class="cxai-think' + (expanded ? '' : ' collapsed') + '">'
          + '<div class="cxai-think-head"><span class="lbl">' + (c.phase === 'thinking' ? '思考中' : '思考过程') + '</span>'
          + '<span class="time">' + esc(thinkTime(c)) + '</span><span class="cxai-caret-r" style="margin-left:auto">›</span></div>'
          + '<p class="cxai-think-body">' + esc(c.thinking) + (c.phase === 'thinking' ? '<span class="cxai-cursor"></span>' : '') + '</p>'
          + '</div>');
      } else if (c.phase === 'thinking') {
        $t.append('<div class="cxai-think"><div class="cxai-think-head"><span class="lbl">思考中</span>'
          + '<span class="time">' + esc(dur(Date.now() - ((c.t || {}).reqAt || Date.now()))) + '</span></div>'
          + '<p class="cxai-think-body">等待模型吐出第一个思考片段…</p></div>');
      } else if ((c.phase === 'answering' || c.phase === 'parsed' || c.phase === 'filled') && !c.thinking) {
        $t.append('<div class="cxai-think"><div class="cxai-think-head"><span class="lbl" style="color:#94A0B2">该模型未返回思考过程</span></div></div>');
      }
      // 回答块
      if (c.phase === 'failed') {
        const err = c.error || {};
        $t.append('<div class="cxai-err"><b>失败</b> · 第 ' + (c.attempt || 1) + ' 次尝试<br>' + esc(err.message || '未知错误')
          + (err.hint ? '<br><span style="color:#8A6A2F">' + esc(err.hint) + '</span>' : '') + '</div>');
      } else {
        const body = c.answer
          ? '<p class="cxai-ans-body">' + esc(c.answer) + (c.phase === 'answering' ? '<span class="cxai-cursor"></span>' : '') + '</p>'
          : '<p class="cxai-ans-body pending">' + (c.phase === 'thinking' ? '模型还在想,回答会在这里逐字出现…' : '等待回答…') + '</p>';
        const ansTime = (c.t && c.t.firstAnswerAt && c.t.doneAt) ? dur(c.t.doneAt - c.t.firstAnswerAt) : (c.phase === 'answering' ? '生成中' : '');
        const $ans = $('<div class="cxai-ans"><div class="cxai-ans-head"><span class="lbl">回答</span>'
          + '<span class="time">' + esc(ansTime) + '</span></div>' + body + '</div>');
        const res = c.result || {};
        if (res.display) {
          const bits = ['<span class="cxai-key ' + (res.ok === false ? 'bad' : 'ok') + '">' + esc(res.display) + '</span>'];
          if (res.normalized) bits.push('<span>解析 → ' + esc(res.normalized) + '</span>');
          $ans.append('<div class="cxai-verdict">' + bits.join('<span class="cxai-sep"></span>')
            + (res.fillOk ? '<span class="cxai-sep"></span><span class="cxai-okn">✓ 已在页面上勾选</span>' : '')
            + (res.verifyOk === true ? '<span class="cxai-sep"></span><span class="cxai-okn">✓ 回读校验一致</span>' : '')
            + (res.verifyOk === false ? '<span class="cxai-sep"></span><span class="cxai-badn">✗ 回读不一致</span>' : '')
            + '</div>');
        }
        $t.append($ans);
      }
      // 页脚
      const t = c.t || {};
      const metaBits = [];
      if (c.usage) {
        if (c.usage.completion_tokens != null) metaBits.push('回答 ' + c.usage.completion_tokens + ' tok');
        if (c.usage.total_tokens != null) metaBits.push('共 ' + c.usage.total_tokens + ' tok');
      }
      if (t.reqAt && t.doneAt) metaBits.push(dur(t.doneAt - t.reqAt));
      if (c.streamed === false) metaBits.push('非流式回放');
      const $f = $('<div class="cxai-foot2"><span class="cxai-m">' + esc(metaBits.join(' · ') || info.text) + '</span>'
        + '<span class="acts"><button data-a="copyturn">复制本题</button><button data-a="collapse">收起</button></span></div>');
      $t.find('.cxai-think-head').on('click', function () { $(this).parent().toggleClass('collapsed'); });
      $f.find('[data-a=copyturn]').on('click', () => copy(turnText(c), ''));
      $f.find('[data-a=collapse]').on('click', () => { state.openTurn.delete(n); drawThread(); });
      $t.append($f);
      return $t;
    }

    function thinkTime(c) {
      const t = c.t || {};
      if (t.firstThinkAt && t.firstAnswerAt) return dur(t.firstAnswerAt - t.firstThinkAt);
      if (t.firstThinkAt) return dur(Date.now() - t.firstThinkAt);
      return '';
    }

    function submitCard() {
      const ev = state.submitEvents.slice(-8);
      const $c = $('<div class="cxai-submit-card"><div><b>提交轨迹</b><ul></ul></div></div>');
      ev.forEach((e) => {
        $c.find('ul').append('<li>' + esc(sec(e.ts)) + ' · ' + esc(e.text || e.state || '') + '</li>');
      });
      return $c;
    }

    function drawStatus() {
      const m = state.meta;
      const $s = $win.find('.cxai-submit');
      if (!m) { $s.html(''); return; }
      const st = m.submitState;
      const label = {
        off: '<b>自动提交 关</b> 开启后也只在全部题目答完时触发',
        wait: '<b>自动提交 开</b> 等待全部题目答完',
        ready: '<b>自动提交 开</b> 全部答完,即将提交',
        done: '<b>已提交</b> ' + esc(m.submitDetail || ''),
        blocked: '<b>未提交</b> ' + esc(m.submitDetail || '有未答题,已停下等你'),
        captcha: '<b>未提交</b> 出现验证码,转人工',
      }[st] || '<b>自动提交 关</b>';
      $s.html(label);
    }

    /* ---------- 复制 ---------- */
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
    function copy(text, label) {
      try { GM_setClipboard(text); } catch (_) { /* 剪贴板不可用就静默 */ }
      log.info('ai', '已复制' + (label || '记录'));
    }

    /* ---------- 位置/开关 ---------- */
    function clamp() {
      const el = $win.find('.cxai-win').get(0);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
      const top = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - r.height));
      $win.find('.cxai-win').css({ left: left + 'px', top: top + 'px' });
    }
    function place() {
      const pos = config.get('autocx.ai.winPos');
      const $w = $win.find('.cxai-win');
      if (pos && pos.left != null) {
        $w.css({ left: pos.left + 'px', top: pos.top + 'px' });
      } else {
        $w.css({
          left: Math.max(0, Math.round((window.innerWidth - 900) / 2)) + 'px',
          top: Math.max(0, Math.round((window.innerHeight - 640) / 2)) + 'px',
        });
      }
      setTimeout(clamp, 30);
    }
    function draggable() {
      $win.find('.cxai-bar').on('mousedown', (e0) => {
        if ($(e0.target).closest('button').length) return;
        const rect0 = $win.find('.cxai-win').get(0).getBoundingClientRect();
        const dx = e0.clientX - rect0.left;
        const dy = e0.clientY - rect0.top;
        const onMove = (e) => {
          const $w = $win.find('.cxai-win');
          const rect = $w.get(0).getBoundingClientRect();
          $w.css({
            left: Math.min(Math.max(0, e.clientX - dx), Math.max(0, window.innerWidth - rect.width)) + 'px',
            top: Math.min(Math.max(0, e.clientY - dy), Math.max(0, window.innerHeight - rect.height)) + 'px',
          });
        };
        const onUp = () => {
          $(document).off('mousemove', onMove).off('mouseup', onUp);
          const pr = $win.find('.cxai-win').get(0).getBoundingClientRect();
          config.set('autocx.ai.winPos', { left: Math.round(pr.left), top: Math.round(pr.top) });
        };
        $(document).on('mousemove', onMove).on('mouseup', onUp);
        e0.preventDefault();
      });
    }

    const api = {
      open() {
        $win.addClass('open');
        place();
        unbind();
        state.sid = null;
        bind(safeIndex());
        draw();
        // GM 存储写入是异步的:150ms 后再校一次,避免首帧读到旧值
        setTimeout(() => {
          const sid = safeIndex();
          if (sid !== state.sid) bind(sid); else draw();
        }, 150);
      },
      close() { $win.removeClass('open'); },
      toggle() { if ($win.hasClass('open')) api.close(); else api.open(); },
      refresh() { if ($win.hasClass('open')) { draw(); } },
    };

    function safeIndex() {
      const idx = safeGet(AI_INDEX);
      if (Array.isArray(idx) && idx.length) return idx[0].sid;
      return null;
    }

    // 索引变化(新会话/新测验)时切到最新一份
    // 索引订阅独立保存:它不能随会话切换被 unbind() 一起解绑
    state.indexWatch = aibus.on(AI_INDEX, (idx) => {
      if (!$win.hasClass('open')) return;
      const list = Array.isArray(idx) ? idx : [];
      const sid = list.length ? list[0].sid : null;
      if (sid !== state.sid) bind(sid);
      else draw();
    });

    $win.find('[data-a=close]').on('click', () => api.close());
    $win.find('[data-a=copy]').on('click', () => {
      const out = state.order.map((n) => turnText(state.convs.get(n) || { n })).join('\n\n---\n\n');
      copy(out || '(没有记录)', '全部记录');
    });
    $win.on('mousedown', (e) => { if (e.target === $win.get(0)) api.close(); });
    $(document).on('keydown', (e) => { if (e.key === 'Escape' && $win.hasClass('open')) api.close(); });
    draggable();

    // 打开即绑定最新会话(可能已在答题中)
    return api;
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

  /* ============================== 悬浮面板 ================================= */
  // 仅在 top 帧渲染;通过 GM_addValueChangeListener 聚合各任务帧的日志/状态
  // 形态:可拖迷你球(进度环+状态点+悬停菜单) <-> 毛玻璃完整面板(助手卡片+三页签)
  function initTopPanel() {
    GM_addStyle(`
      #autocx-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;
        font:13px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}
      /* ---------- 迷你球 ---------- */
      #autocx-panel .cx-ball{position:relative;width:46px;height:46px;cursor:grab;user-select:none}
      #autocx-panel .cx-ball:active{cursor:grabbing}
      #autocx-panel .cx-ball svg{position:absolute;inset:0;transform:rotate(-90deg)}
      #autocx-panel .cx-ball .ring-bg{fill:none;stroke:rgba(59,124,255,.18);stroke-width:3.5}
      #autocx-panel .cx-ball .ring-fg{fill:none;stroke:#3B7CFF;stroke-width:3.5;stroke-linecap:round;
        stroke-dasharray:125.6;stroke-dashoffset:125.6;transition:stroke-dashoffset .5s}
      #autocx-panel .cx-ball .core{position:absolute;inset:4px;border-radius:50%;
        background:linear-gradient(135deg,#3B7CFF,#60A5FA);display:flex;align-items:center;justify-content:center;
        color:#fff;font-weight:700;font-size:13px;box-shadow:0 2px 10px rgba(59,124,255,.45)}
      #autocx-panel .cx-ball.off .core{background:#b9c0cc}
      #autocx-panel .cx-dots{position:absolute;right:-2px;bottom:-2px;display:flex;gap:3px}
      #autocx-panel .cx-dots i{width:9px;height:9px;border-radius:50%;border:2px solid #fff;display:block}
      #autocx-panel .cx-dots .d-v{background:#c8cdd6}
      #autocx-panel .cx-dots .d-v.on{background:#22C55E}
      #autocx-panel .cx-dots .d-q{background:#c8cdd6}
      #autocx-panel .cx-dots .d-q.on{background:#8B5CF6}
      /* ---------- 悬停快捷菜单 ---------- */
      #autocx-panel .cx-menu{position:absolute;bottom:56px;right:0;width:172px;background:rgba(255,255,255,.96);
        backdrop-filter:blur(12px);border-radius:12px;box-shadow:0 6px 24px rgba(31,41,55,.18);
        padding:6px;display:none;border:1px solid rgba(229,231,235,.8)}
      #autocx-panel .cx-ball:hover .cx-menu{display:block}
      #autocx-panel .cx-menu .mi{display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#1f2937}
      #autocx-panel .cx-menu .mi:hover{background:#F3F6FB}
      #autocx-panel .cx-menu .mi .st{font-size:11px;color:#9ca3af}
      #autocx-panel .cx-menu .mi .st.on{color:#22C55E}
      /* ---------- 完整面板 ---------- */
      #autocx-panel .cx-box{display:none;width:392px;max-height:66vh;background:rgba(255,255,255,.94);
        backdrop-filter:blur(14px);border-radius:14px;box-shadow:0 10px 40px rgba(31,41,55,.22);
        overflow:hidden;flex-direction:column;border:1px solid rgba(229,231,235,.9)}
      #autocx-panel.open .cx-box{display:flex}
      #autocx-panel.open .cx-ball{display:none}
      #autocx-panel .cx-head{display:flex;align-items:center;gap:8px;padding:10px 14px;
        background:linear-gradient(135deg,#3B7CFF,#60A5FA);color:#fff;cursor:grab;user-select:none}
      #autocx-panel .cx-head:active{cursor:grabbing}
      #autocx-panel .cx-head b{flex:1;font-size:14px;letter-spacing:.5px}
      #autocx-panel .cx-head button{background:none;border:0;color:#fff;cursor:pointer;font-size:15px;opacity:.9}
      /* ---------- 助手卡片 ---------- */
      #autocx-panel .cx-cards{display:flex;gap:10px;padding:12px 14px 4px}
      #autocx-panel .cx-card{flex:1;border-radius:12px;padding:10px 12px;cursor:pointer;position:relative;
        background:#EEF1F6;color:#6b7280;transition:transform .12s, box-shadow .12s;border:1px solid transparent}
      #autocx-panel .cx-card:hover{transform:translateY(-1px)}
      #autocx-panel .cx-card .t{font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px}
      #autocx-panel .cx-card .s{font-size:11px;margin-top:5px;opacity:.85;display:flex;align-items:center;gap:5px}
      #autocx-panel .cx-card .s i{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
      #autocx-panel .cx-card .ck{position:absolute;top:8px;right:10px;width:16px;height:16px;border-radius:50%;
        border:1.5px solid currentColor;display:flex;align-items:center;justify-content:center;font-size:10px;opacity:.5}
      #autocx-panel .cx-card.on{color:#fff;border:0;box-shadow:0 4px 14px rgba(59,124,255,.3)}
      #autocx-panel .cx-card.on .ck{opacity:1;border-color:#fff}
      #autocx-panel .cx-card.on .ck::after{content:"✓"}
      #autocx-panel .cx-card.video.on{background:linear-gradient(135deg,#3B7CFF,#60A5FA)}
      #autocx-panel .cx-card.quiz.on{background:linear-gradient(135deg,#8B5CF6,#A78BFA);box-shadow:0 4px 14px rgba(139,92,246,.3)}
      /* ---------- 页签 ---------- */
      #autocx-panel .cx-tabs{display:flex;padding:8px 14px 0;gap:4px}
      #autocx-panel .cx-tabs button{flex:1;padding:6px 0;background:none;border:0;color:#6b7280;cursor:pointer;
        font-size:13px;border-bottom:2px solid transparent}
      #autocx-panel .cx-tabs button.active{color:#3B7CFF;border-bottom-color:#3B7CFF;font-weight:600}
      #autocx-panel .cx-body{padding:10px 14px 12px;overflow-y:auto;min-height:120px}
      #autocx-panel .cx-page{display:none}
      #autocx-panel .cx-page.active{display:block}
      /* ---------- 状态流 ---------- */
      #autocx-panel .cx-status-item{padding:6px 0;border-bottom:1px solid #EEF1F6;font-size:12px}
      #autocx-panel .cx-status-item .badge{display:inline-block;padding:1px 7px;border-radius:6px;color:#fff;
        font-size:11px;margin-right:6px}
      #autocx-panel .cx-status-item .t{color:#9ca3af;font-size:11px;margin-top:2px}
      #autocx-panel .badge-video{background:#3B7CFF}
      #autocx-panel .badge-quiz{background:#8B5CF6}
      #autocx-panel .badge-knowledge{background:#22C55E}
      #autocx-panel .badge-advance{background:#F59E0B}
      #autocx-panel .badge-doc{background:#06B6D4}
      #autocx-panel .badge-panel,#autocx-panel .badge-bootstrap,#autocx-panel .badge-antithrottle{background:#9ca3af}
      /* ---------- 日志 ---------- */
      #autocx-panel .cx-log{height:220px;overflow-y:auto;font:11px Consolas,monospace;color:#4b5563}
      #autocx-panel .cx-log div{padding:2px 0;border-bottom:1px solid #F1F3F7;word-break:break-all}
      #autocx-panel .cx-log .warn{color:#d97706}.cx-log .error{color:#dc2626}
      /* ---------- 设置 ---------- */
      #autocx-panel .cx-item{display:flex;align-items:center;justify-content:space-between;padding:5px 0;gap:8px}
      #autocx-panel .cx-item label{flex:1;color:#4b5563;font-size:12.5px}
      #autocx-panel .cx-item input[type=text],#autocx-panel .cx-item input[type=password],
      #autocx-panel .cx-item input[type=number],#autocx-panel .cx-item select{width:170px;background:#F5F7FA;
        border:1px solid #E5E7EB;border-radius:7px;color:#1f2937;padding:4px 8px;font-size:12.5px}
      #autocx-panel .cx-item input:focus,#autocx-panel .cx-item select:focus{outline:none;border-color:#3B7CFF}
      #autocx-panel .cx-btn{background:linear-gradient(135deg,#3B7CFF,#60A5FA);border:0;border-radius:8px;
        color:#fff;padding:6px 14px;cursor:pointer;font-size:12.5px}
      #autocx-panel .cx-test-result{margin-top:6px;font-size:12px}
      /* ---------- 关于(仓库入口) ---------- */
      #autocx-panel .cx-about{margin-top:10px;padding-top:9px;border-top:1px solid #EEF1F6;
        display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:#9ca3af}
      #autocx-panel .cx-about a{color:#7C8798;text-decoration:none}
      #autocx-panel .cx-about a:hover{color:#3B7CFF;text-decoration:underline}
      #autocx-panel .cx-about .cx-about-sep{color:#D5DBE5}
      /* ---------- 开关 ---------- */
      #autocx-panel .cx-switch{position:relative;width:36px;height:20px;background:#d1d5db;border-radius:10px;
        cursor:pointer;transition:background .15s}
      #autocx-panel .cx-switch.on{background:#3B7CFF}
      #autocx-panel .cx-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;
        border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
      #autocx-panel .cx-switch.on::after{left:18px}
      /* ---------- AI 页签 ---------- */
      #autocx-panel .cx-ai-tip{font-size:11px;color:#9ca3af;line-height:1.6;margin:2px 0 8px}
      #autocx-panel .cx-ai-row{display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:5px 0;border-bottom:1px solid #EEF1F6;font-size:12px;color:#4b5563}
      #autocx-panel .cx-ai-row b{color:#1f2937;font-size:12px;font-weight:600;white-space:nowrap}
    `);

    elmGetter.get('body', 15000).then((body) => {
      const RING_LEN = 125.6; // 2πr (r=20) 进度环周长
      const $panel = $(`
        <div id="autocx-panel">
          <div class="cx-ball" title="AutoCX(拖动移动,点击展开)">
            <svg viewBox="0 0 46 46"><circle class="ring-bg" cx="23" cy="23" r="20"/><circle class="ring-fg" cx="23" cy="23" r="20"/></svg>
            <div class="core">CX</div>
            <div class="cx-dots"><i class="d-v" title="看课助手"></i><i class="d-q" title="答题助手"></i></div>
            <div class="cx-menu">
              <div class="mi" data-act="open">展开窗口 <span class="st">›</span></div>
              <div class="mi" data-act="toggle-video">看课助手 <span class="st st-v"></span></div>
              <div class="mi" data-act="toggle-quiz">答题助手 <span class="st st-q"></span></div>
              <div class="mi" data-act="ai">答题记录 <span class="st">›</span></div>
              <div class="mi" data-act="toggle-main">总开关 <span class="st st-m"></span></div>
            </div>
          </div>
          <div class="cx-box">
            <div class="cx-head">
              <b>AutoCX 学习通助手</b>
              <span class="cx-enabled cx-switch" title="总开关"></span>
              <button class="cx-close" title="收起">—</button>
            </div>
            <div class="cx-cards">
              <div class="cx-card video" data-assist="assist.video">
                <div class="t">▶ 看课助手</div>
                <div class="s"><i></i><span class="st-v-txt">待命</span></div>
                <div class="ck"></div>
              </div>
              <div class="cx-card quiz" data-assist="assist.quiz">
                <div class="t">✎ 答题助手</div>
                <div class="s"><i></i><span class="st-q-txt">待命</span></div>
                <div class="ck"></div>
              </div>
            </div>
            <div class="cx-tabs">
              <button data-tab="status" class="active">状态</button>
              <button data-tab="log">日志</button>
              <button data-tab="ai">AI</button>
              <button data-tab="settings">设置</button>
            </div>
            <div class="cx-body">
              <div class="cx-page active" data-page="status"><div class="cx-status-list"><i style="color:#9ca3af">等待任务帧上报…</i></div></div>
              <div class="cx-page" data-page="log"><div class="cx-log"></div></div>
              <div class="cx-page" data-page="ai">
                <div class="cx-ai-tip">答题时,脚本发出的请求、模型思考与回答都会记进「AI 作答记录」窗口。</div>
                <div class="cx-item"><button class="cx-btn cx-ai-open">打开作答记录窗口</button></div>
                <div class="cx-ai-list"></div>
              </div>
              <div class="cx-page" data-page="settings">
                <div class="cx-item"><label>LLM Base URL</label><input type="text" data-cfg="llm.base_url"></div>
                <div class="cx-item"><label>LLM API Key</label><input type="password" data-cfg="llm.api_key"></div>
                <div class="cx-item"><label>LLM 模型</label><input type="text" data-cfg="llm.model"></div>
                <div class="cx-item"><label>思考强度(推理模型提速)</label>
                  <select data-cfg="llm.effort">
                    <option value="low">low (推荐,快)</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="">不发送该参数</option>
                  </select></div>
                <div class="cx-item"><label>停滞超时(秒,慢模型调大)</label><input type="number" min="15" max="600" data-cfg="llm.timeout"></div>
                <div class="cx-item"><label>流式接收(思考过程逐字显示)</label><input type="checkbox" data-cfg="llm.stream"></div>
                <div class="cx-item"><label>视频倍速 (1-16)</label><input type="number" min="1" max="16" data-cfg="video.speed"></div>
                <div class="cx-item"><label>视频静音</label><input type="checkbox" data-cfg="video.mute"></div>
                <div class="cx-item"><label>自动勾选答案</label><input type="checkbox" data-cfg="quiz.auto_fill"></div>
                <div class="cx-item"><label>自动提交(全答完才生效)</label><input type="checkbox" data-cfg="quiz.auto_submit"></div>
                <div class="cx-item"><label>两答一致性校验(防手滑)</label><input type="checkbox" data-cfg="quiz.double_check"></div>
                <div class="cx-item"><label>翻页间隔基数(秒)</label><input type="number" min="1" max="10" data-cfg="doc.interval"></div>
                <div class="cx-item"><label>调试日志</label><input type="checkbox" data-cfg="debug"></div>
                <div class="cx-item"><button class="cx-btn cx-test-llm">测试 LLM 连接</button></div>
                <div class="cx-test-result"></div>
                <div class="cx-about">
                  <span class="cx-about-v"></span>
                  <span class="cx-about-sep">·</span>
                  <a href="${REPO.github}" target="_blank" rel="noopener noreferrer">GitHub</a>
                  <span class="cx-about-sep">·</span>
                  <a href="${REPO.gitee}" target="_blank" rel="noopener noreferrer">Gitee</a>
                  <span class="cx-about-sep">·</span>
                  <a href="${REPO.issues}" target="_blank" rel="noopener noreferrer">反馈</a>
                  <span class="cx-about-sep">·</span>
                  <span>MIT</span>
                </div>
              </div>
            </div>
          </div>
        </div>`);
      $(body).append($panel);
      $panel.find('.cx-about-v').text('AutoCX v' + VERSION);

      // ---- 助手开关渲染 ----
      const assistOn = (k) => config.get(k) !== false;
      const renderAssist = () => {
        $panel.find('.cx-card.video').toggleClass('on', assistOn('assist.video'));
        $panel.find('.cx-card.quiz').toggleClass('on', assistOn('assist.quiz'));
        $panel.find('.cx-dots .d-v').toggleClass('on', assistOn('assist.video'));
        $panel.find('.cx-dots .d-q').toggleClass('on', assistOn('assist.quiz'));
        $panel.find('.cx-menu .st-v').text(assistOn('assist.video') ? '已开启' : '已关闭').toggleClass('on', assistOn('assist.video'));
        $panel.find('.cx-menu .st-q').text(assistOn('assist.quiz') ? '已开启' : '已关闭').toggleClass('on', assistOn('assist.quiz'));
        $panel.find('.cx-menu .st-m').text(isEnabled() ? '已开启' : '已关闭').toggleClass('on', isEnabled());
        $panel.find('.cx-ball').toggleClass('off', !isEnabled());
      };
      renderAssist();
      const toggleAssist = (k, name) => {
        config.set(k, !assistOn(k));
        renderAssist();
        log.info('panel', `${name}: ${assistOn(k) ? '开' : '关'}`);
      };
      $panel.find('.cx-card.video').on('click', () => toggleAssist('assist.video', '看课助手'));
      $panel.find('.cx-card.quiz').on('click', () => toggleAssist('assist.quiz', '答题助手'));

      // ---- 拖动与位置约束:迷你球和展开窗口都可拖,且始终钳制在可视区内 ----
      const clampIntoView = () => {
        const rect = $panel.get(0).getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - rect.width - 8);
        const maxTop = Math.max(0, window.innerHeight - rect.height - 8);
        const left = Math.min(Math.max(0, rect.left), maxLeft);
        const top = Math.min(Math.max(0, rect.top), maxTop);
        $panel.css({ left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
      };
      const makeDraggable = (handle) => {
        let moved = false;
        handle.on('mousedown', (e0) => {
          if (e0.target.closest('.cx-menu,button,.cx-switch')) return; // 控件不触发拖动
          const off = $panel.offset();
          const dx = e0.clientX - off.left, dy = e0.clientY - off.top;
          moved = false;
          const onMove = (e) => {
            moved = true;
            const rect = $panel.get(0).getBoundingClientRect();
            const left = Math.min(Math.max(0, e.clientX - dx), Math.max(0, window.innerWidth - rect.width - 8));
            const top = Math.min(Math.max(0, e.clientY - dy), Math.max(0, window.innerHeight - rect.height - 8));
            $panel.css({ left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
          };
          const onUp = () => {
            $(document).off('mousemove', onMove).off('mouseup', onUp);
            if (moved) {
              const p = $panel.offset();
              config.set('autocx.ballPos', { left: Math.round(p.left), top: Math.round(p.top) });
            }
          };
          $(document).on('mousemove', onMove).on('mouseup', onUp);
          e0.preventDefault();
        });
        return () => moved;
      };

      const $ball = $panel.find('.cx-ball');
      const savedPos = config.get('autocx.ballPos');
      if (savedPos && savedPos.left != null) {
        $panel.css({ left: savedPos.left + 'px', top: savedPos.top + 'px', right: 'auto', bottom: 'auto' });
        // 加载即钳制:窗口缩放/上次拖到边缘都可能出屏
        setTimeout(clampIntoView, 100);
      }
      const ballMoved = makeDraggable($ball);
      makeDraggable($panel.find('.cx-head')); // 展开后拖头部移动窗口

      const openPanel = () => { $panel.addClass('open'); setTimeout(clampIntoView, 50); };
      const openAI = () => {
        try { AIW.ensure().open(); } catch (e) { log.error('panel', '打开作答记录失败: ' + e.message); }
      };
      $ball.on('click', (e) => {
        if (ballMoved() || e.target.closest('.cx-menu')) return;
        openPanel();
      });
      $panel.find('.cx-menu .mi').on('click', function (e) {
        e.stopPropagation();
        const act = $(this).data('act');
        if (act === 'open') openPanel();
        else if (act === 'ai') openAI();
        else if (act === 'toggle-video') toggleAssist('assist.video', '看课助手');
        else if (act === 'toggle-quiz') toggleAssist('assist.quiz', '答题助手');
        else if (act === 'toggle-main') { config.set('autocx.enabled', !isEnabled()); renderAssist(); renderSwitch(); }
      });
      $panel.find('.cx-close').on('click', () => $panel.removeClass('open'));
      // 窗口尺寸变化时重新钳制,避免面板被挤出屏幕
      window.addEventListener('resize', clampIntoView);

      // ---- 总开关 ----
      const $sw = $panel.find('.cx-enabled');
      const renderSwitch = () => { $sw.toggleClass('on', isEnabled()); $panel.find('.cx-ball').toggleClass('off', !isEnabled()); };
      renderSwitch();
      $sw.on('click', () => {
        config.set('autocx.enabled', !isEnabled());
        renderSwitch();
        renderAssist();
        log.info('panel', `总开关: ${isEnabled() ? '开' : '关'}`);
      });

      // ---- 页签 ----
      $panel.find('.cx-tabs button').on('click', function () {
        $panel.find('.cx-tabs button').removeClass('active');
        $(this).addClass('active');
        $panel.find('.cx-page').removeClass('active');
        $panel.find(`.cx-page[data-page="${$(this).data('tab')}"]`).addClass('active');
      });

      // ---- 设置绑定 ----
      $panel.find('[data-cfg]').each(function () {
        const key = $(this).data('cfg');
        const isCheckbox = this.type === 'checkbox';
        if (isCheckbox) this.checked = !!config.get(key); else this.value = config.get(key);
        $(this).on('change', () => {
          config.set(key, isCheckbox ? this.checked : (this.type === 'number' ? Number(this.value) : this.value));
          log.debug('panel', `配置更新 ${key}`);
        });
      });

      // ---- AI 页签:实时摘要 + 打开记录窗口 ----
      const $aiList = $panel.find('.cx-ai-list');
      const AI_STATE = {
        off: '自动提交 关', wait: '自动提交 开 · 等待答完', ready: '自动提交 开 · 即将提交',
        done: '已提交', blocked: '未提交(有未答题)', captcha: '未提交(验证码转人工)',
      };
      const renderAIPanel = () => {
        let m = null;
        try { m = GM_getValue(AI_PING) || null; } catch (_) { m = null; }
        if (!m || !m.count) {
          $aiList.html('<i style="color:#9ca3af">还没有记录。测验页开始答题后,这里会显示进度。</i>');
          return;
        }
        const bad = Number(m.failed) || 0;
        $aiList.html(
          '<div class="cx-ai-row"><span>' + escHtml(m.title || '章节测验') + '</span><b>'
            + (Number(m.answered) || 0) + ' / ' + m.count + '</b></div>'
          + '<div class="cx-ai-row"><span>失败</span><b style="color:' + (bad ? '#dc2626' : '#1f2937') + '">'
            + bad + ' 题</b></div>'
          + '<div class="cx-ai-row"><span>提交</span><b>' + (AI_STATE[m.submitState] || '未知') + '</b></div>'
          + '<div class="cx-ai-row"><span>' + escHtml(m.model || '') + '</span><b>' + escHtml(m.source || '') + '</b></div>'
        );
      };
      renderAIPanel();
      $panel.find('.cx-ai-open').on('click', openAI);
      GM_addValueChangeListener(AI_PING, (_k, _o, nv, remote) => { if (remote && nv) renderAIPanel(); });

      // ---- LLM 测试 ----
      $panel.find('.cx-test-llm').on('click', function () {
        const $r = $panel.find('.cx-test-result').css('color', '#6b7280').text('测试中…');
        $(this).prop('disabled', true);
        llm.test()
          .then((msg) => $r.css('color', '#16a34a').text('✅ ' + msg))
          .catch((e) => $r.css('color', '#dc2626').text('❌ ' + e.message))
          .finally(() => $(this).prop('disabled', false));
      });

      // ---- 进度环 ----
      const setRing = (pct) => {
        const p = Math.min(100, Math.max(0, pct));
        $panel.find('.ring-fg').css('stroke-dashoffset', RING_LEN * (1 - p / 100));
      };

      // ---- 助手卡片实时状态 ----
      const setCardStatus = (assist, text) => {
        $panel.find(assist === 'assist.video' ? '.st-v-txt' : '.st-q-txt').text(text);
      };

      // ---- 跨帧日志/状态聚合 ----
      const fmt = (ts) => new Date(ts).toTimeString().slice(0, 8);
      GM_addValueChangeListener(LOG_KEY, (_k, _o, nv, remote) => {
        if (!remote || !nv) return;
        const $log = $panel.find('.cx-log');
        $log.append(`<div class="${nv.level}">${fmt(nv.ts)} [${nv.module}] ${nv.msg}</div>`);
        const items = $log.children();
        if (items.length > 200) items.slice(0, items.length - 200).remove();
        $log.scrollTop($log[0].scrollHeight);
      });
      GM_addValueChangeListener(STATUS_KEY, (_k, _o, nv, remote) => {
        if (!remote || !nv) return;
        const $list = $panel.find('.cx-status-list');
        $list.find('i').remove();
        $list.prepend(`<div class="cx-status-item"><span class="badge badge-${nv.module}">${nv.module}</span>${nv.state} ${nv.detail || ''}<div class="t">${fmt(nv.ts)} ${nv.frame}</div></div>`);
        const items = $list.children();
        if (items.length > 20) items.slice(20).remove();
        // 驱动卡片状态与进度环
        const detail = nv.detail || '';
        if (nv.module === 'video' || nv.module === 'doc' || nv.module === 'knowledge') {
          setCardStatus('assist.video', detail || nv.state);
        }
        if (nv.module === 'quiz') {
          setCardStatus('assist.quiz', detail || nv.state);
        }
        if (nv.module === 'video') {
          const m = detail.match(/(\d+)%/);
          if (nv.state === 'playing' && m) setRing(Number(m[1]));
          if (nv.state === 'done') setRing(100);
        }
      });

      log.info('panel', '悬浮面板已加载');
    }).catch((e) => log.error('panel', '等待 body 超时: ' + e));
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
              const nameEl = $it.find('.posCatalog_name').get(0) || $it.get(0);
              nameEl.click();
              const title = $it.text().replace(/\s+/g, ' ').trim().slice(0, 40);
              log.info('advance', '切换到: ' + title);
              report('advance', 'next', title);
              clicked = true;
              break;
            }
          }
          if (!clicked) {
            log.info('advance', '后面没有未完成任务了 🎉');
            report('advance', 'all-done', '全部任务已完成');
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
    const tryNextTask = () => {
      if (taskSwitching || !isEnabled()) return;
      const $tabs = $('li[onclick*="changeDisplayContent"]');
      if ($tabs.length < 2) return; // 单任务章节,交给整章推进
      const cur = $tabs.index($tabs.filter('.active').get(0));
      const $next = $tabs.eq(cur + 1);
      if (!$next.length) return;    // 已是最后一个任务,交给整章推进
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
    // 3) 任务帧事件:knowledge 帧的完成标记(权威) / 视频 ended(兜底)
    GM_addValueChangeListener(STATUS_KEY, (_k, _o, nv, remote) => {
      if (!remote || !nv) return;
      if (nv.state === 'job-done' || nv.state === 'done') tryNextTask();
      if (nv.state === 'done') tryAdvance('done-event');
    });
  }

  /* ============================== quiz-page =============================== */
  // 章节测验: 接口劫持/DOM 提取题目 -> LLM -> 自动勾选 -> 人工确认提交(绝不自动提交)
  function initQuizPage() {
    const module = 'quiz';
    if (config.get('assist.quiz') === false) {
      log.info(module, '答题助手已关闭,跳过');
      report(module, 'disabled', '答题助手已关闭');
      return;
    }
    report(module, 'start', '检测到测验页面');
    log.info(module, '测验页面启动');

    // ---- 作答记录:会话句柄 + 提交轨迹事件(autoSubmit 等散点通过它留痕) ----
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

      // ---- 闸口2: 批阅/查看模式内容级复检(URL 闸的漏网之鱼) ----
      // 批阅页特征:出现"我的答案/正确答案/得分"等标记;或没有可见提交按钮。
      // 注意:不能含 score——答卷页头部有 "Total score: 100.0",会误伤
      const bodyText = (document.body && document.body.innerText) || '';
      const hasReviewMark = /My Answer|我的答案|正确答案|批阅|查看答案|查看解析|得分/.test(bodyText);
      const hasSubmit = $(SELECTORS.quiz.submit).filter(':visible').length > 0;
      if (hasReviewMark || !hasSubmit) {
        log.info(module, `判定为批阅/查看页(批阅标记=${hasReviewMark}, 提交按钮=${hasSubmit}),不操作`);
        report(module, 'review', '批阅/查看页,不操作');
        return;
      }
      // ---- 闸口2b: 可答性正向校验 ----
      if (!$('li[onclick*="addChoice"], input[type=radio], input[type=checkbox]').length) {
        log.info(module, '未发现可交互选项,非答卷页,退出');
        report(module, 'review', '无可交互选项,不操作');
        return;
      }

      // 跨帧锁:同一测验可能被多个嵌套帧同时识别(ananas/work + doHomeWorkNew),
      // 抢锁成功的实例才干活,其余退出,防止重复答题/重复提交
      const workKey = (location.href.match(/workId=([0-9a-z]+)/i) || [null, location.pathname])[1];
      const LOCK_KEY = 'autocx.quiz.lock';
      const lock = GM_getValue(LOCK_KEY);
      if (lock && lock.workKey === workKey && Date.now() - lock.ts < 5 * 60 * 1000) {
        log.info(module, '另一个帧已接管本测验,本帧退出');
        return;
      }
      GM_setValue(LOCK_KEY, { workKey, ts: Date.now() });

      const questions = (captured && captured.length ? captured : extractQuestionsFromDOM())
        .map((q, i) => ({ ...q, index: i + 1 }));
      if (!questions.length) {
        log.warn(module, '题目提取失败(接口和 DOM 均无结果)');
        report(module, 'error', '题目提取失败');
        return;
      }
      log.info(module, `共 ${questions.length} 题,来源: ${captured ? '接口明文' : 'DOM(可能被字体混淆)'}`);
      report(module, 'extracted', `提取到 ${questions.length} 题`);

      /* ---------- 作答记录:会话快照 + 每题初始状态(供 AI 记录窗口消费) ---------- */
      const sid = 'w' + String(workKey).replace(/[^0-9a-z]/gi, '').slice(0, 16);
      const aiMeta = {
        sid, workKey,
        title: String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '章节测验',
        count: questions.length,
        source: captured ? '接口明文' : 'DOM 提取',
        concurrency: 2,
        model: config.get('llm.model'),
        effort: String(config.get('llm.effort') || ''),
        host: String(config.get('llm.base_url') || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
        keyTail: String(config.get('llm.api_key') || '').slice(-4),
        startAt: Date.now(),
        answeredAt: 0,
        answered: 0,
        failed: 0,
        submitState: config.get('quiz.auto_submit') ? 'wait' : 'off',
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
      aiSession = { sid, meta: aiMeta };

      const convs = questions.map((q) => {
        const c = {
          index: q.index, type: q.type, stem: q.stem, options: q.options || [],
          source: aiMeta.source, phase: 'queued', prompt: '', params: null,
          thinking: '', answer: '', streamed: true, result: null, usage: null,
          error: null, attempt: 0, t: { queuedAt: Date.now() },
        };
        aibus.put(AI_C(sid, q.index), convSnapshot(c));
        return c;
      });
      const writers = new Map();
      const writer = (index) => {
        if (!writers.has(index)) writers.set(index, makeConvWriter(sid, index));
        return writers.get(index);
      };

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
            if (config.get('quiz.double_check')) {
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
          if (q) await answerOne(q);
        }
      };
      await Promise.all([worker(), worker()]);

      if (stopped) return;
      if (config.get('quiz.auto_submit')) {
        if (stats.failed.length === 0 && stats.ok === questions.length) {
          aiMeta.answered = stats.ok;
          aiEvent('全部题目已作答,准备自动提交', { submitState: 'ready' });
          autoSubmit();
        } else {
          log.warn(module, `有 ${stats.failed.length} 题未答(题号: ${stats.failed.join(',')}),不自动提交,请人工处理后提交。`);
          report(module, 'filled', `${stats.ok}/${questions.length} 已答,有未答题,等待人工`);
          aiEvent(`有 ${stats.failed.length} 题未答(题号: ${stats.failed.join(',')}),不自动提交`, {
            submitState: 'blocked', submitDetail: `${stats.failed.length} 题未答`,
          });
        }
      } else {
        log.info(module, '答题流程结束。请人工核对后自行提交(自动提交可在设置中开启)。');
        report(module, 'filled', '答题完成,等待人工核对提交');
        aiEvent(`${stats.ok}/${questions.length} 已答。自动提交已关闭,请人工核对后提交`, {
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

          const btn = $(SELECTORS.quiz.submit).filter(':visible').get(0);
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
                  return $(this).is(':visible') && /^(Submit|确定|确认|提交)$/.test(t);
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

    /* ---------- 选项元素去重(外层 li 与内层字母元素会重复命中) ---------- */
    function pickOptionEls($q) {
      const all = $q.find(SELECTORS.quiz.optionList).get();
      const outer = all.filter((el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        return /^[A-Z][、.\s]/.test(t) && t.length > 2;
      });
      return outer.length ? outer : all;
    }

    /* ---------- 题目提取:DOM 降级 ---------- */
    function extractQuestionsFromDOM() {
      return $(SELECTORS.quiz.question).map(function () {
        const $q = $(this);
        const stemRaw = $q.find(SELECTORS.quiz.title).first().text().replace(/\s+/g, ' ').trim()
          || $q.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
        const typeText = $q.text();
        const type = detectType($q, typeText);
        const optEls = pickOptionEls($q);
        const options = optEls.map((el, i) => {
          const t = $(el).text().replace(/\s+/g, ' ').trim();
          const m = t.match(/^([A-Z])[、.\s]/);
          return { label: m ? m[1] : String.fromCharCode(65 + i), text: t.replace(/^[A-Z][、.\s]/, '').trim() };
        }).filter((o) => o.text);
        const stem = stemRaw.replace(/^【.*?】/, '').trim();
        return { type, stem, options, dom: this, optDoms: optEls };
      }).get().filter((q) => q.stem);
    }

    /* ---------- Prompt 构建 ---------- */
    function buildPrompt(q) {
      const typeName = { single: '单选题', multi: '多选题', judge: '判断题', blank: '填空题' }[q.type];
      let p = `请回答下面这道${typeName}。\n注意:题目文本可能混有个别形近乱码字符(网站字体混淆所致),请结合上下文语义推断原题含义后作答。\n题目:${q.stem}\n`;
      if (q.type === 'judge' && !q.options.length) {
        p += 'A、正确\nB、错误\n';
      } else if (q.options.length) {
        p += q.options.map((o) => `${o.label}、${o.text}`).join('\n') + '\n';
      }
      if (q.type === 'blank') {
        p += '要求:直接给出每个空的答案,多空用|分隔,不要任何解释。\n';
      } else if (q.type === 'multi') {
        p += '要求:这是多选题,只回复所有正确选项的字母(如 BCD),不要任何解释。\n';
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
      if (q.type === 'blank') {
        const parts = text.split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
        return parts.length
          ? { ok: true, display: parts.join(' | '), blanks: parts, normalized: parts.join('|') }
          : { ok: false, display: text.slice(0, 30), normalized: '' };
      }
      const norm = normalizeLetters(text);
      if (!norm) return { ok: false, display: text.slice(0, 30), normalized: '' };
      if (q.type === 'single' || q.type === 'judge') {
        const letter = norm[0];
        return { ok: true, display: letter, letters: [letter], normalized: letter };
      }
      // 多选:保留完整字母序列(排序规范化,填写用 includes 判断与顺序无关)
      const sorted = norm.split('').sort().join('');
      return { ok: true, display: sorted, letters: sorted.split(''), normalized: sorted };
    }

    /* ---------- 填后校验:回读 DOM 勾选状态与意图比对 ---------- */
    function readCheckedLetters(q) {
      const letters = [];
      (q.optDoms || []).forEach((el, i) => {
        const input = $(el).find('input[type=radio],input[type=checkbox]').get(0);
        const checked = (input && input.checked) || el.getAttribute('aria-checked') === 'true';
        if (checked) letters.push(String.fromCharCode(65 + i));
      });
      return letters.join('');
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
        const letter = String.fromCharCode(65 + i);
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
  // 任务点容器帧:轮询 .ans-job-finished(权威完成标记),上报给顶层切换任务
  function initKnowledgeFrame() {
    const module = 'knowledge';
    spoofVisibility();
    let reported = false;
    const check = () => {
      if (reported) return;
      if (document.querySelector('.ans-job-finished')) {
        reported = true;
        log.info(module, '检测到任务点完成标记(.ans-job-finished)');
        report(module, 'job-done', '当前任务点已完成');
      }
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
  }

})();
