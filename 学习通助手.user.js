// ==UserScript==
// @name         AutoCX 学习通自动看课+LLM答题助手
// @namespace    autocx
// @version      0.8.2
// @description  学习通自动看课(视频/文档课件)+LLM辅助章节测验答题(人工确认提交)。轻量单文件,基于 jQuery + ElementGetter + Ajax-hook。
// @author       autocx
// @license      MIT
// @icon         https://pan-yz.chaoxing.com/favicon.ico
// @match        *://*.chaoxing.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// @require      https://cdn.jsdelivr.net/gh/wendux/Ajax-hook@master/dist/ajaxhook.min.js
// @require      https://scriptcat.org/lib/513/2.1.0/ElementGetter.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
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
  const DEFAULTS = {
    'autocx.enabled': true, // 总开关(面板启停)
    'assist.video': true,   // 看课助手(视频/文档任务点)
    'assist.quiz': true,    // 答题助手(章节测验)
    'llm.base_url': 'https://api.deepseek.com/v1',
    'llm.api_key': '',
    'llm.model': 'deepseek-chat',
    'llm.effort': 'low',   // 思考强度: ''(不发送)/low/medium/high;推理模型建议 low 提速
    'llm.timeout': 180,    // 响应停滞超时(秒):N 秒完全无数据才判负;网关排队/缓冲/慢思考都覆盖
    'video.speed': 2,
    'video.mute': true,
    'quiz.auto_fill': true,
    'quiz.auto_submit': false, // 自动提交(仅全部答完才生效,默认关闭)
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
    if (/\/(mooc2?-ans\/)?(work|exam)\//.test(path) || /dowork|studentwork/.test(href) ||
        /\/mooc-ans\/api\/work/.test(path)) return 'quiz';

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

  /* ============================== 总开关 =================================== */
  function isEnabled() {
    return config.get('autocx.enabled') !== false;
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
    /** 面板"测试连接"按钮用 */
    test() {
      return this.chat('请只回复两个字:正常').then((t) => `连接成功,模型回复: ${t.slice(0, 50)}`);
    },
  };

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
      /* ---------- 开关 ---------- */
      #autocx-panel .cx-switch{position:relative;width:36px;height:20px;background:#d1d5db;border-radius:10px;
        cursor:pointer;transition:background .15s}
      #autocx-panel .cx-switch.on{background:#3B7CFF}
      #autocx-panel .cx-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;
        border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
      #autocx-panel .cx-switch.on::after{left:18px}
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
              <button data-tab="settings">设置</button>
            </div>
            <div class="cx-body">
              <div class="cx-page active" data-page="status"><div class="cx-status-list"><i style="color:#9ca3af">等待任务帧上报…</i></div></div>
              <div class="cx-page" data-page="log"><div class="cx-log"></div></div>
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
                <div class="cx-item"><label>视频倍速 (1-16)</label><input type="number" min="1" max="16" data-cfg="video.speed"></div>
                <div class="cx-item"><label>视频静音</label><input type="checkbox" data-cfg="video.mute"></div>
                <div class="cx-item"><label>自动勾选答案</label><input type="checkbox" data-cfg="quiz.auto_fill"></div>
                <div class="cx-item"><label>自动提交(全答完才生效)</label><input type="checkbox" data-cfg="quiz.auto_submit"></div>
                <div class="cx-item"><label>翻页间隔基数(秒)</label><input type="number" min="1" max="10" data-cfg="doc.interval"></div>
                <div class="cx-item"><label>调试日志</label><input type="checkbox" data-cfg="debug"></div>
                <div class="cx-item"><button class="cx-btn cx-test-llm">测试 LLM 连接</button></div>
                <div class="cx-test-result"></div>
              </div>
            </div>
          </div>
        </div>`);
      $(body).append($panel);

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
      $ball.on('click', (e) => {
        if (ballMoved() || e.target.closest('.cx-menu')) return;
        openPanel();
      });
      $panel.find('.cx-menu .mi').on('click', function (e) {
        e.stopPropagation();
        const act = $(this).data('act');
        if (act === 'open') openPanel();
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

      // 单题处理(含一次重试)
      const answerOne = async (q) => {
        if (stopped || !isEnabled()) return;
        setBadge(q, '思考中…', 'thinking');
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const raw = await llm.chat(buildPrompt(q));
            failStreak = 0;
            const parsed = parseAnswer(q, raw);
            setBadge(q, `AI: ${parsed.display}`, parsed.ok ? 'ok' : 'bad');
            log.info(module, `题目${q.index} AI回答: ${parsed.display}${parsed.ok ? '' : ' (解析失败,未作答)'}`);
            if (parsed.ok) {
              stats.ok++;
              if (config.get('quiz.auto_fill')) fillAnswer(q, parsed);
            } else {
              stats.failed.push(q.index);
            }
            return;
          } catch (e) {
            log.warn(module, `题目${q.index} 第${attempt}次调用失败: ${e.message}`);
          }
        }
        failStreak++;
        stats.failed.push(q.index);
        setBadge(q, '失败', 'bad');
        if (failStreak >= 3) {
          stopped = true;
          log.error(module, '连续 3 题失败,暂停答题。请检查 LLM 配置。');
          report(module, 'error', 'LLM 连续失败,已暂停');
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
          autoSubmit();
        } else {
          log.warn(module, `有 ${stats.failed.length} 题未答(题号: ${stats.failed.join(',')}),不自动提交,请人工处理后提交。`);
          report(module, 'filled', `${stats.ok}/${questions.length} 已答,有未答题,等待人工`);
        }
      } else {
        log.info(module, '答题流程结束。请人工核对后自行提交(自动提交可在设置中开启)。');
        report(module, 'filled', '答题完成,等待人工核对提交');
      }
    }

    /* ---------- 自动提交(仅在全部答完时调用) ---------- */
    // 提交流程:点 .btnSubmit -> 顶层 workPop 弹窗("Submit?") -> 点其确认按钮
    // -> 可能出现验证码(#verifyCodeWin,转人工) -> 验证结果(修掉假阳性)
    function autoSubmit() {
      log.info(module, '全部题目已作答,3 秒后自动提交…');
      report(module, 'submitting', '全部答完,自动提交中');
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
            } else {
              log.error(module, '未找到提交按钮,请人工提交(选择器可能已改版)');
              report(module, 'error', '未找到提交按钮,请人工提交');
            }
            return;
          }
          btn.click();
          log.info(module, '已点击提交按钮,等待确认弹窗…');

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
        }
      }, 3000);

      // 提交结果验证(最多 10 秒):验证码出现转人工;Submit 消失/状态完成才算成功
      function verifySubmitted(round) {
        if (round > 20) {
          log.error(module, '提交结果未确认,请检查页面后人工处理');
          report(module, 'error', '提交结果未确认');
          return;
        }
        setTimeout(() => {
          try {
            // 1) 验证码弹窗出现 -> 转人工
            const cap = document.querySelector(SELECTORS.quiz.captchaWin);
            if (cap && cap.offsetWidth && cap.offsetHeight) {
              log.warn(module, '出现图片验证码,请人工输入并完成提交');
              report(module, 'captcha', '出现验证码,等待人工');
              return;
            }
            // 2) 提交按钮消失或页面出现完成态文本 -> 成功
            const stillBtn = $(SELECTORS.quiz.submit).filter(':visible').length > 0;
            const bodyText = document.body.innerText || '';
            const doneText = /已提交|已完成|查看答案|答案解析|成绩|得分/.test(bodyText) && !/To do/.test(bodyText);
            if (!stillBtn || doneText) {
              log.info(module, '自动提交成功 ✅');
              report(module, 'submitted', '自动提交成功');
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
        const rawType = String(q.type ?? q.questionType ?? '');
        const type = /多选|multiple|multi/i.test(rawType) ? 'multi'
          : /判断|judge|truefalse/i.test(rawType) ? 'judge'
          : /填空|blank|fill/i.test(rawType) ? 'blank' : 'single';
        const optsRaw = q.options || q.titleOption || q.answers || [];
        const options = (Array.isArray(optsRaw) ? optsRaw : []).map((o, i) => ({
          label: String.fromCharCode(65 + i),
          text: String(typeof o === 'string' ? o : (o.text || o.content || o.value || '')).replace(/<[^>]+>/g, '').trim(),
        }));
        return { type, stem, options, dom: null };
      } catch (_) { return null; }
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
        const type = /多选题/.test(typeText) ? 'multi' : /判断题/.test(typeText) ? 'judge'
          : /填空题/.test(typeText) ? 'blank' : 'single';
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
        p += '要求:这是多选题,只回复正确选项的字母(如 ACD),不要任何解释。\n';
      } else {
        p += '要求:只回复正确选项的字母(如 B),不要任何解释。\n';
      }
      return p;
    }

    /* ---------- 答案解析(正则容错) ---------- */
    function parseAnswer(q, raw) {
      const text = raw.trim();
      if (q.type === 'blank') {
        const parts = text.split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
        return parts.length ? { ok: true, display: parts.join(' | '), blanks: parts } : { ok: false, display: text.slice(0, 30) };
      }
      const letters = [...new Set((text.toUpperCase().match(/[A-G]/g) || []))].sort();
      if (!letters.length) return { ok: false, display: text.slice(0, 30) };
      if (q.type === 'single' || q.type === 'judge') {
        return { ok: true, display: letters[0], letters: [letters[0]] };
      }
      return { ok: true, display: letters.join(''), letters };
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
      // 选择/判断:点击对应选项行(用提取时去重后的同一份元素,避免错位)
      (parsed.letters || []).forEach((letter) => {
        const idx = letter.charCodeAt(0) - 65;
        const optEl = (q.optDoms || [])[idx];
        if (!optEl) return;
        const input = $(optEl).find('input[type=radio],input[type=checkbox]').get(0);
        if (input && !input.checked) input.click();
        else if (!input) optEl.click();
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
      const colors = { thinking: '#63b4ff', ok: '#21d181', bad: '#ff4d4f' };
      $b.text(text).css({ background: colors[state] || '#999', color: '#fff' });
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
      initQuizPage();
      break;
  }

})();
