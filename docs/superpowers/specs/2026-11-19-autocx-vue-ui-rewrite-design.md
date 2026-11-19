# AutoCX 前端重写设计（Vue 3 + Ant Design Vue · 批注纸）

- 日期：2026-11-19
- 状态：已确认，进入实现
- 基线：`v0.14.0`（jQuery UI 稳定版，已打 annotated tag）
- 目标版本：`v1.0.0`
- 代码库：`autocx/学习通助手.user.js`（单文件 userscript）

## 1. 背景与目标

现有脚本（v0.14.0）的悬浮面板与「AI 作答记录」窗口全部由 jQuery + 手写 HTML/CSS 渲染，共约 1,100 行 UI 代码。功能完整，但存在三个问题：

1. 视觉语言是渐变 + 毛玻璃 + 圆角卡片，和课程页面之间没有明确的“工具”身份；
2. DOM 操作分散在 `initTopPanel()` / `createAIWindow()` 两段大函数里，状态变化靠手写 `draw*()` 重绘；
3. 新增面板状态或设置项需要同时改 HTML 字符串、CSS 和 jQuery 绑定，维护成本高。

本次重写只替换**视图层**，业务逻辑（看课、文档翻页、章节推进、测验提取、字体解码、LLM 请求、勾选/回填/校验、提交状态机）保持不动。完成后发布 `v1.0.0`。

### 非目标

- 不新增业务功能，不改 GM 存储键，不改跨帧通信协议；
- 不引入构建步骤，仍然交付单个 `.user.js`；
- 不重写题库/AI 请求链路；
- 不改变风控、验证码转人工等安全边界。

## 2. 技术方案

### 2.1 依赖与加载

沿用「单文件 + CDN `@require`」方案（与参考脚本 ABC 一致，但不使用其失效的 baomitu 路径）：

```js
// @require https://cdn.jsdelivr.net/npm/vue@3.5.22/dist/vue.global.prod.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js
// 以下 7 个 dayjs 插件为 AntD UMD 的运行期依赖
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/advancedFormat.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/customParseFormat.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/localeData.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/quarterOfYear.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/weekOfYear.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/weekYear.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/weekday.js
// ScriptCat 的 @require 作用域不保证 UMD 的 window 绑定，补一行 shim：
// @require data:application/javascript,window.Vue%3DVue%3Bwindow.dayjs%3Ddayjs%3B
// @require https://cdn.jsdelivr.net/npm/ant-design-vue@4.2.6/dist/antd.min.js
```

- `Vue` / `antd` 取 `window.Vue` / `window.antd`（取不到再回退到脚本作用域的同名变量）；Vue 运行时编译器通过 `new Function` 执行模板，挂载前把 Vue 3 实例补到 `unsafeWindow.Vue`（仅当页面没有 Vue 时），否则会报 `Vue is not defined`。

- 顺序必须是 Vue → dayjs → Ant Design Vue；AntD UMD 依赖 `Vue` 与 `dayjs` 全局。
- 不引入 Pinia：面板状态规模小，`reactive` / `ref` 足够。
- 不引入 `@ant-design/icons-vue`：图标用内联 SVG 或文字符号，减少一个依赖。
- 所有版本固定，不使用 `@latest`。
- 资源加载失败时（`typeof Vue === 'undefined' || typeof antd === 'undefined'`）：在顶层帧显示一条原生错误条「AutoCX UI 资源加载失败，业务逻辑继续运行」，不阻塞看课/答题逻辑。

### 2.2 单文件组件写法

不使用 SFC / Vite。每个 Vue 组件用 `defineComponent` + `template` 字符串声明，统一放在 `学习通助手.user.js` 的 UI 段内：

```
/* ===== UI: Vue 根 ===== */
const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch } = Vue;
const { ConfigProvider, Input, Select, Switch, Button, Tooltip } = antd;
```

组件清单（逻辑分组，不要求拆成独立文件）：

| 组件 | 职责 |
|---|---|
| `AutoCxRoot` | 顶层挂载点；持有 `panelOpen`、`activeTab`、`settings`、拖拽位置 |
| `BookmarkTab` | 收起态书签：竖排 AutoCX、红色进度压条、悬停菜单 |
| `PanelShell` | 纸面面板骨架：印章标题、总开关、两个助手折叠行、页签容器、页脚 |
| `StatusPage` | 跨帧状态流（`STATUS_KEY` 最新 20 条） |
| `LogPage` | 跨帧日志（`LOG_KEY` 最新 200 条），自动滚底 |
| `AiSummaryPage` | 轻量摘要（`AI_PING`）+ 打开记录窗口按钮 |
| `SettingsPage` | 现有全部配置项；分组：模型接口 / 看课 / 答题 / 字体与调试 |
| `AiWindow` | 900×640 只读记录窗口；左侧题目索引 + 右侧单题详情 + 提交轨迹 |
| `QuestionRail` | 题目列表、键盘导航、完成/失败计数 |
| `TurnView` | 请求 / 思考 / 回答 / 结果 / 页脚；流式光标、折叠、复制本题 |
| `SubmitStrip` | 全局提交轨迹卡片（固定正文下方，不参与单题滚动） |

### 2.3 挂载与生命周期

- `initTopPanel()` 保留原调用入口与 `elmGetter.get('body', 15000)` 等待逻辑；内部改为创建 `#autocx-vue-root` 并 `createApp(AutoCxRoot).mount(...)`。
- 只在顶层帧挂载面板；各 iframe 继续只跑业务模块。
- `AIW.ensure()` / `AIW.api.open()` / `close()` / `toggle()` / `refresh()` 的接口保持不变，内部改为创建/操作 Vue `AiWindow` 实例；`GM_registerMenuCommand('打开 AI 作答记录')` 与 `__autocxAI` 调试钩子无需改动。
- 组件卸载时清理 `GM_addValueChangeListener` 返回的 off 函数、window 监听器与定时器。

## 3. 视觉系统：批注纸

### 3.1 设计概念

把面板当作一张**带红边的批注纸**，而不是悬浮卡片：

- **纸**：微冷纸白 + 20px 浅网格，像一本摊开的学习讲义；
- **页边**：左侧 1px 红笔页边线，时间/题号沿页边排列；
- **印章**：面板左上与 AI 窗口左上各有一枚红色方印（CX / AI），作为唯一的高饱和色块；
- **书签**：收起态不是圆球，而是贴在屏幕右缘的一枚纸书签，红色压条显示进度；
- **红笔**：`#C2453A` 只用于“正在发生/需要注意/主操作”，不用于大面积装饰；
- **荧光笔**：`#E9C46A` 只用于 AI 思考段落的行内高亮，表达“这是模型的草稿”。

### 3.2 Design tokens

| Token | 值 | 用途 |
|---|---|---|
| `--paper` | `#FAFAF5` | 面板 / AI 窗口纸面 |
| `--paper-deep` | `#F1F2EA` | 页签、AI 左栏、页脚 |
| `--ink` | `#1E2A2F` | 主文字、2px 结构线 |
| `--ink-2` | `#334246` | 正文 |
| `--ink-3` | `#5C6B6E` | 次要文字 |
| `--ink-4` | `#7C8688` | 辅助信息 |
| `--ink-5` | `#8B9495` | 时间戳、页脚 |
| `--red` | `#C2453A` | 印章、页边、激活页签、主按钮、错误/注意 |
| `--blue` | `#2E5A75` | 模块名、链接、信息 |
| `--highlight` | `#E9C46A` | 思考段落荧光笔 |
| `--rule` | `rgba(30,42,47,.16)` | 分隔线 |

### 3.3 字体

- 展示 / 印章旁标题：`Georgia, "Songti SC", "SimSun", serif`，600 weight；
- 正文与控件：`-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`；
- 所有数字（时间、题号、百分比、token）使用 `font-variant-numeric: tabular-nums`；
- 不使用全大写英文标签、不滥用等宽字体；日志行用正文字体，仅时间列等宽。

### 3.4 面板布局

```
┌──────────────────────────────┐  ← 纸白 #FAFAF5，右上 22px 折角
│ [CX] AutoCX          [开关][—]│  印章 32×32 / 标题 19px serif
│      学习通助手               │
├──────────────────────────────┤  ← 2px 墨线 + 1px 红笔线
│ ▶ 看课助手 ······ 播放中 42% │  两行账本式状态，无卡片
│ ✎ 答题助手 ······ 待命       │
├──────────────────────────────┤
│ 状态 │ 日志 │ AI │ 设置      │  纸质索引页签，激活红顶边
├──────────────────────────────┤
│ 18:38 video     视频任务点…  │  左页边时间栏
│ 18:39 quiz      提取到 3 题   │
│ …                            │
├──────────────────────────────┤
│ AutoCX 1.0.0      GitHub MIT │
└──────────────────────────────┘
```

- 尺寸：`400 × 610`（`max-height: calc(100vh - 32px)`），右下角 `16px`。
- 展开/收起：右上角 `—` 收起为书签；点书签或悬停菜单「展开面板」恢复。
- 拖拽：按住标题栏拖动；位置写入 `autocx.ballPos`；窗口 resize 时钳制回可视区。
- 动画：面板展开 180ms `cubic-bezier(.2,.8,.2,1)` 的纸张滑出（`transform-origin: right bottom`）；`prefers-reduced-motion: reduce` 时关闭。
- 书签：`28 × 124`，固定右缘；左侧 4px 红条；竖排 AutoCX；底部百分比；悬停展开 248px 菜单（展开面板 / 看课助手 / 答题助手 / 答题记录 / 总开关）。

### 3.5 AI 作答记录窗口

- 尺寸：`980 × 640`（`max-width: calc(100vw - 48px)`），居中，可拖拽，位置写入 `autocx.ai.winPos`。
- 结构：顶部印章条（AI 印章 + 标题 + 模型/effort + 关闭）→ 左侧 260px 题目索引（纸深色底、红左边选中）→ 右侧单题正文（请求 / 思考 / 回答 / 结果 / 页脚）→ 全局提交轨迹 → 底部只读说明。
- 思考区：行内荧光笔高亮，流式时末尾 6×13px 红色光标；未返回思考时如实标注「该模型未返回思考过程」。
- 回答区：答案字母用红底白字小印章（如 `B`），结果行用墨绿色 `✓`；失败用红笔写明第几次尝试与 hint。
- 左栏题目索引：题号 01/02…、题干两行截断、状态点；`↑/↓/Home/End` 键盘导航，`←/→` 翻题。
- 复制：保留「复制本题」「复制全部记录」行为，文本格式与 v0.14.0 一致。
- 关闭：`Esc`、右上 `×`、点击遮罩空白处。

### 3.6 组件形态

- 页签：不是 AntD `a-tabs` 默认胶囊，改为纸索引页签（`border-radius: 3px 3px 0 0`，激活红顶边）。
- 开关：AntD `a-switch` 仅用于设置页/总开关，`checkedChildren` 关闭，尺寸 32×16，方形；外观由 CSS 覆盖。
- 输入：`a-input` / `a-select` 使用 `bordered` 关闭或 `variant="borderless"`，只保留 1px 下划线；聚焦时下划线变红。
- 按钮：主按钮为红底纸白字直角按钮；次按钮为红描边透明底。
- 所有 AntD 组件通过 `ConfigProvider` 设置：
  ```js
  theme: {
    token: {
      colorPrimary: '#C2453A',
      colorText: '#1E2A2F',
      colorBgContainer: '#FAFAF5',
      colorBorder: 'rgba(30,42,47,.25)',
      borderRadius: 2,
      controlHeight: 28,
      fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    },
  }
  ```
- 不允许 AntD 默认的圆角、阴影、蓝色 focus ring 漏出；必要时用 `:deep` 或全局 `#autocx-vue-root` 选择器覆盖。

## 4. 数据流与状态

### 4.1 面板

```
各任务帧 ──GM_setValue(LOG_KEY/STATUS_KEY/AI_PING)──▶ 顶层帧
顶层帧 GM_addValueChangeListener ──▶ reactive logs / statusItems / aiPing ──▶ Vue 渲染
```

- `logs`：最多 200 条；新日志追加后若原本贴底则自动滚底。
- `statusItems`：最多 20 条；新状态置顶；`video` 的 `detail` 中 `\d+%` 驱动书签/账本进度。
- `aiPing`：`AI_PING` 变化时刷新 AI 摘要页。
- 设置：每个字段 `v-model` 绑定 `settings` 对象；`@change` 写 `config.set(key, value)`。数字字段转 `Number`，复选框转 `boolean`。
- 总开关/助手开关：直接读写现有 `config`；`render` 由响应式状态自动完成。

### 4.2 AI 窗口

- 保持现有 `aibus.on` / `safeGet` / `AI_INDEX` / `AI_S` / `AI_C` 数据层。
- Vue 侧维护 `reactive({ sid, meta, order, convs, submitEvents, openReq, openTurn, sel, follow })`。
- `aibus.on` 回调更新响应式数据；`watch` 触发滚动位置修正（换题回顶、同题贴底保持）。
- 新增 `now` tick（500ms）仅在窗口打开时运行，用于刷新 `请求中/思考中/回答中 · Ns` 的时长；关闭时清理。
- `AIW.api.open()`：打开窗口 → 读取 `AI_INDEX` → `bind(sid)` → 150ms 后复查一次（保持现有行为）。

## 5. 错误处理与降级

| 场景 | 行为 |
|---|---|
| Vue / AntD `@require` 加载失败 | 顶层帧显示原生错误条，业务逻辑继续；AIW 调用变为 no-op 并 `log.error` |
| `GM_addValueChangeListener` 不可用 | 与现状一致：`try/catch`，不阻断主流程 |
| `aibus` 无会话 / 无题目 | 面板显示「还没有记录」；AI 窗口左栏「暂无题目」，正文空态文案 |
| 单题 `phase: failed` | 红笔错误卡片，显示尝试次数与错误提示，不自动重试 |
| 窗口位置越界 | `clampIntoView()` 在打开/拖拽结束/resize 时钳制 |
| 页面 CSP 阻止样式 | 所有自定义 CSS 通过 `GM_addStyle` 注入；AntD cssinjs 若被 CSP 阻止，至少保留纸面样式与原生控件可用（记录 warn） |

## 6. 文件与提交

- 修改：`autocx/学习通助手.user.js`
  - 头部 `@version` → `1.0.0`；新增 3 条 `@require`；
  - 删除 `initTopPanel()` 与 `createAIWindow()` 的 jQuery DOM 构建代码，替换为 Vue 组件；
  - 保留全部业务模块、选择器、GM 键名、`AIW`/`seedDemo` 接口。
- 修改：`autocx/README.md` 的技术栈/界面说明、版本号、开发调试命令。
- 设计文档：`autocx/docs/superpowers/specs/2026-11-19-autocx-vue-ui-rewrite-design.md`（`docs/` 当前被 `.gitignore` 忽略，提交时使用 `git add -f` 或调整 ignore 规则）。
- 施工前基线：`v0.14.0` tag 已存在，指向 `7c17b92`；实现完成后打 `v1.0.0`。

## 7. 验证计划

1. **静态检查**：`node .agents/skills/scriptcat-userscript/scripts/check.mjs autocx/学习通助手.user.js`
   - 预期仍有 3 条 `connect-missing` 误报（github / gitee / deepseek），不得为此加 `@connect`。
2. **回归测试**：`node autocx/test/sse-parse.test.js`、`node autocx/test/parse-answer.test.js`。
3. **sctl 真机**：
   - `sctl install autocx/学习通助手.user.js` 安装到用户 ScriptCat；
   - 打开 `mooc1.chaoxing.com` 课程学习页，确认右下角书签出现，点击展开；
   - 切状态/日志/AI/设置四个页签，改设置并重载确认持久化；
   - 点「打开作答记录窗口」→ 用 `__autocxAI.demo()` 造演示数据，检查左栏、请求/思考/回答、复制、Esc 关闭；
   - 控制台无 Vue/AntD 报错，日志无异常。
4. **视觉核对**：对面板展开/收起/设置页/AI 窗口各截一张图，确认与设计稿一致；浅色课程页、深色视频页两种背景都看。
5. **通过标准**：现有自动看课与答题流程不变；UI 交互全部可用；无新增 console error；`v1.0.0` 可安装。

## 8. 风险与取舍

- **体积**：Vue + AntD UMD + dayjs 约 1.5MB（首次下载后缓存），且 `@require` 会在每个匹配帧加载。接受此成本换取组件化与 AntD 行为层；不做动态懒加载，避免 CSP 与沙箱不确定性。
- **AntD 默认样式**：必须在 `ConfigProvider` token + 全局 CSS 两层覆盖，否则圆角/蓝色 focus 会破坏纸面语言；实现时以截图核对。
- **Vue runtime compiler**：使用 `vue.global.prod.js`（含编译器）以支持 `template` 字符串；若页面 CSP 限制 `new Function`，需验证 ScriptCat 沙箱下可用（ABC 脚本同方案已验证可行）。
- **重写范围**：只替换 UI 层，不动业务；如出现回归，优先对照 `v0.14.0` 的 DOM 结构与事件顺序排查。
