# AutoCX 学习通自动看课+LLM答题助手

轻量级 ScriptCat 脚本：学习通自动看课（视频/文档课件）+ 自行接入大模型 API 辅助章节测验答题（不接题库）+「AI 作答记录」窗口。

[GitHub](https://github.com/lianjishu/autocx) · [Gitee](https://gitee.com/yake2024/autocx) · [反馈](https://github.com/lianjishu/autocx/issues)

设计文档：[docs/superpowers/specs/2026-11-18-chaoxing-auto-course-design.md](docs/superpowers/specs/2026-11-18-chaoxing-auto-course-design.md)

## 功能

| 模块 | 行为 |
|---|---|
| 视频/音频任务点 | 页面真实播放（不碰进度接口）、倍速（默认 2x，可调 1–16）、静音、中途弹题随机作答、风控验证自动暂停等人工；**反后台节流**（可见性伪装 + Web Worker 心跳 + 停滞自愈），后台标签也能刷 |
| 文档/课件任务点 | PPT/PDF 自动翻页、图书自动滚动，间隔随机化 |
| 章内任务切换 | 当前任务点完成（knowledge 帧 `.ans-job-finished` 权威标记）后自动点击下一个任务标签（视频 → 章节测验…） |
| 章节测验 | 提取题目 → OpenAI 兼容 LLM 答题（90s 超时、失败重试 1 次、2 路并发）→ 自动勾选 → 回读校验；**自动提交默认关** |
| **AI 作答记录** | 独立只读窗口：脚本发出的**请求**（prompt + temperature/stream/effort + 来源）、模型的**思考**（流式逐字）、模型的**回答**（流式逐字）、**解析 → 勾选 → 回读校验**结果、以及**提交轨迹**（点击提交 / 确认弹窗 / 验证码转人工 / 结果）。模型不返回思考内容时如实标注，绝不编造 |
| 自动推进 | 当前章节完成后自动切换目录中下一个未完成章节 |
| 悬浮面板 | 毛玻璃浅色面板：双助手渐变卡片（看课/答题独立开关+实时状态）/ 模块徽章状态流 / 跨帧日志 / AI 摘要页签 / 设置（底部有版本与仓库入口）；收起为**可拖迷你球**（外圈视频进度环 + 助手状态点 + 悬停快捷菜单） |

## 安装

1. 浏览器安装 [ScriptCat](https://scriptcat.org/) 扩展
2. 把 `学习通助手.user.js` 拖入 ScriptCat 管理面板（或新建脚本粘贴内容）
3. 打开学习通课程学习页（`mooc1.chaoxing.com/mycourse/studentstudy?...`），右下角出现蓝色 **CX** 悬浮球即生效
4. 想看答题过程：点面板 **AI** 页签 → 「打开作答记录窗口」（也可从迷你球悬停菜单「答题记录」进入，或 ScriptCat 菜单里的「打开 AI 作答记录」）

## 配置（面板 → 设置）

| 项 | 默认 | 说明 |
|---|---|---|
| LLM Base URL | `https://api.deepseek.com/v1` | 任意 OpenAI 兼容接口 |
| LLM API Key | 空 | 不填则测验只做题目提取，不答题 |
| LLM 模型 | `deepseek-chat` | 推理模型（`deepseek-reasoner` 等）的思考过程会进作答记录窗口 |
| 思考强度 | `low` | 推理模型必设 low,提速 10 倍;网关不认会自动降级 |
| 停滞超时 | 180s | N 秒完全无数据才判负；思考再久也不算失败 |
| 流式接收 | 开 | 思考/回答逐字进记录窗口；关掉则等整包返回再一次性展示（窗口会标「非流式回放」） |
| 视频倍速 | 2 | 1–16，建议 ≤4 降低风控概率 |
| 视频静音 | 开 | |
| 自动勾选答案 | 开 | 关闭则只看 AI 建议手动选 |
| 自动提交 | **关** | 开启后：全部题目答完才自动提交；有任何未答题则暂停等人工。全过程记在作答记录窗口 |
| 翻页间隔基数 | 2s | 文档任务 |
| 调试日志 | 关 | |

首次调用 LLM 时 ScriptCat 会弹"允许访问域名"，允许即可（脚本未声明 @connect，由用户按需授权，兼容任意自建/中转接口）。

## 安全边界

- **自动提交默认关**；开启后也需要「全部题目答完」这个前提，任何一题未答就停下等你。提交的每一步都会写进作答记录窗口，不做黑盒操作
- 风控验证（滑块/验证码）绝不自动处理，出现即暂停并转人工
- 视频走页面真实播放，不调用进度上报接口

## 已知限制

- **思考过程取决于模型**：非推理模型 / 不支持 `reasoning_content` 的网关不会返回思考内容，此时思考区显示「该模型未返回思考过程」，不会拿耗时或请求内容编一段推理
- **字体混淆**：学习通对部分题目用自定义字体混淆 DOM 文本（半明文半乱码）。脚本在 prompt 中提示模型按上下文推断，强模型通常能答对；彻底方案是字体映射解密（参考 ABC 助手的 ttf 表），列为后续可选增强
- 作业/考试（独立答卷、切屏检测）暂不支持
- 仅支持超星学习通（`*.chaoxing.com`）

## 技术栈

jQuery 3.7（DOM）+ ElementGetter 2.1（cxxjackie，异步元素监听）+ Ajax-hook（wendux，XHR 劫持备用）+ ScriptCat GM API。单文件零构建，**不引入 markdown 渲染库**：模型输出一律转义成纯文本展示（pre-wrap），避免 prompt injection 变成 DOM 注入。

跨帧数据流：答题在测验 iframe 里发生，窗口在顶层帧渲染；两者通过 GM 存储（`autocx.ai.*` 键）通信，流式文本按 300ms 节流写入，相位变化立即写。

## 开发调试

```powershell
# 静态检查(元数据/授权/@connect 等)
node ..\.agents\skills\scriptcat-userscript\scripts\check.mjs 学习通助手.user.js

# 回归测试(SSE 增量解析 / 答案解析)
node test\sse-parse.test.js
node test\parse-answer.test.js

# sctl 热更新调试循环
sctl install 学习通助手.user.js   # 浏览器内批准后生效
sctl page reload --tab <id>
sctl logs <uuid>                  # 读 [AutoCX] 日志
```

**界面核对钩子**：课程页控制台可执行 `__autocxAI.demo()` 造一份演示记录并打开窗口（不触发任何真实请求），`__autocxAI.clear('demo')` 清掉它。

> `check.mjs` 会报 3 条 `connect-missing`（github.com / gitee.com / api.deepseek.com）。这是它的启发式：把头部所有 URL 都当成请求目标。前两个只出现在 `@homepage`/`@supportURL` 元数据里，脚本从不请求它们；deepseek 那条是**故意**不加 `@connect` 的——一旦声明了 `@connect`，ScriptCat 就会拒绝列表外的任何域名，用户的自建/中转 LLM 网关就用不了了。

## 关于

- 版本：见脚本头部 `@version`（面板设置页底部也会显示）
- 许可证：MIT
- 仓库：[GitHub](https://github.com/lianjishu/autocx) / [Gitee 镜像](https://gitee.com/yake2024/autocx)
- 反馈：[Issues](https://github.com/lianjishu/autocx/issues)

界面里的仓库入口只做跳转（新标签打开、无跟踪参数、无自动跳转），不参与任何功能逻辑。