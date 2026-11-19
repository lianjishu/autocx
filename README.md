# AutoCX 学习通自动看课+LLM答题助手

ScriptCat 脚本：学习通自动看课（视频/文档课件）+ 自行接入大模型 API 辅助章节测验答题（不接题库）+「AI 作答记录」窗口。

[GitHub](https://github.com/lianjishu/autocx) · [Gitee](https://gitee.com/yake2024/autocx) · [反馈](https://github.com/lianjishu/autocx/issues)

设计文档：[Vue 前端重写设计](docs/superpowers/specs/2026-11-19-autocx-vue-ui-rewrite-design.md) · [自动看课设计](docs/superpowers/specs/2026-11-18-chaoxing-auto-course-design.md)

## 功能

| 模块 | 行为 |
|---|---|
| 视频/音频任务点 | 页面真实播放（不碰进度接口）、倍速（默认 2x，可调 1–16）、静音、中途弹题随机作答、风控验证自动暂停等人工；**反后台节流**（可见性伪装 + Web Worker 心跳 + 停滞自愈），后台标签也能刷 |
| 文档/课件任务点 | PPT/PDF 自动翻页、图书自动滚动，间隔随机化 |
| 章内任务切换 | 当前任务点完成（knowledge 帧 `.ans-job-finished` 权威标记）后自动点击下一个任务标签（视频 → 章节测验…） |
| 章节测验 | 提取题目 → **字体反混淆解出明文** → OpenAI 兼容 LLM 答题（90s 超时、失败重试 1 次、2 路并发）→ 自动勾选 → 回读校验 → 按置信度决定是否自动提交（**默认关**） |
| 作业（work） | 与章节测验同一条链路，独立开关 `作业自动提交`（默认关，作业常只能交一次）；已批阅/已提交/已截止的页面一律不动手，草稿态只补空白题、不覆盖已有作答 |
| **随堂练习**（课堂测验） | 课程主页「任务」页里的随堂练习（`mobilelearn` 的 `answerQuestion2` 页）：独立 Vue2 应用，题目与作答状态直接取自页面数据，**无字体混淆**。支持单选/多选/判断/填空/简答；题干带图时自动转多模态作答。填完逐题回读平台状态校验。独立开关 `随堂练习自动提交`（**默认关**），另提供脚本菜单「提交本次随堂练习」手动提交 |
| **AI 作答记录** | 独立只读窗口：脚本发出的**请求**（prompt + temperature/stream/effort + 来源）、模型的**思考**（流式逐字）、模型的**回答**（流式逐字）、**解析 → 勾选 → 回读校验**结果、以及**提交轨迹**（点击提交 / 确认弹窗 / 验证码转人工 / 结果）。模型不返回思考内容时如实标注，绝不编造 |
| 自动推进 | 当前章节完成后自动切换目录中下一个未完成章节 |
| 悬浮面板 | 批注纸风格：纸白网格面板 + 红笔页边 + 双助手账本状态 / 模块徽章状态流 / 跨帧日志 / AI 摘要页签 / 设置（底部有版本与仓库入口）；收起为**右缘书签**（红色进度压条 + 悬停快捷菜单，可上下拖动，单击展开） |

## 安装

1. 浏览器安装 [ScriptCat](https://scriptcat.org/) 扩展
2. 把 `学习通助手.user.js` 拖入 ScriptCat 管理面板（或新建脚本粘贴内容）
3. 打开学习通课程学习页（`mooc1.chaoxing.com/mycourse/studentstudy?...`），右侧出现 **AutoCX 书签**即生效，点书签展开面板
4. 想看答题过程：点面板 **AI** 页签 → 「打开作答记录窗口」（也可从书签悬停菜单「答题记录」进入，或 ScriptCat 菜单里的「打开 AI 作答记录」）

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
| 自动提交 | **关** | 开启后：只有**全部题目都答完且解码置信度够**（A/B 级）才自动提交；有任何未答或存疑就停下等你。全过程记在作答记录窗口 |
| 作业自动提交 | **关** | 作业常只能提交一次，单独一个开关 |
| 随堂练习自动提交 | **关** | 平台本身会在截止时自动交，默认只填不交；也可用脚本菜单「提交本次随堂练习」手动提交 |
| 视觉兜底 | 开 | 解码有未定字时，把字形拼成一张图交给**同一个**多模态模型识别，与位图结果一致才采纳 |
| 参考库地址 | 空 | 留空=用脚本内置的一级常用字库（断网可用）；填 URL 可换成全量 6763 字库 |
| 翻页间隔基数 | 2s | 文档任务 |
| 调试日志 | 关 | |

首次调用 LLM 时 ScriptCat 会弹"允许访问域名"，允许即可（脚本未声明 @connect，由用户按需授权，兼容任意自建/中转接口）。

## 安全边界

- **自动提交默认关**；开启后也需要「全部题目答完」这个前提，任何一题未答就停下等你。提交的每一步都会写进作答记录窗口，不做黑盒操作
- 随堂练习的自动提交是**独立开关**（同样默认关），不跟随章节测验/作业的开关——三类页面的提交代价完全不同
- 风控验证（滑块/验证码）绝不自动处理，出现即暂停并转人工
- 视频走页面真实播放，不调用进度上报接口
- 已提交/已批阅/已截止的题目**一律不填**：页面出现「已提交」「正确答案」「批阅」等特征时脚本只读不写

## 已知限制

- **思考过程取决于模型**：非推理模型 / 不支持 `reasoning_content` 的网关不会返回思考内容，此时思考区显示「该模型未返回思考过程」，不会拿耗时或请求内容编一段推理
- **字体反混淆**：已实现（见下文），但**讲评/已提交页没有内嵌字体，解不了**——所以解码必须在提交前做，这也是脚本不轻易自动提交的原因之一
- **参考库只含 GB2312 一级常用字**（3755 个，覆盖实测真题 99.3% 的明文）；遇到二级/生僻字会标 `?`，可换全量库或靠视觉兜底
- 考试（独立答卷、切屏检测）暂不支持；作业已支持答题与状态机判断
- 随堂练习的**填空题**按「模型给的答案数 = 填空框数」对齐，数量不符就跳过不填；多选题会遵守平台给的项数上下限
- 仅支持超星学习通（`*.chaoxing.com`）

## 字体反混淆（v0.12 起）

学习通把题干/选项里的**一部分**汉字换成密文码点，页面靠内嵌的 `font-cxsecret` 字体把密文字形画成真字——所以**屏幕上是对的、复制出来是乱的、`innerText` 拿到的是密文**。截图里那种「艺术洿格拳珙」不是形近字，和原文毫无形状关系，让模型"按上下文猜"只能得到随机答案（旧版"两次作答不一致"就是这么来的）。

现在的做法：

1. 找出页面里 `font-cxsecret` 字体的实际字体族名，把密文字**用 canvas 渲染**出来（不解析 TTF、不读 base64）；
2. 裁到字形 bbox、缩放到 24×24 二值图；
3. 与脚本内置的**参考位图库**（GB2312 一级常用字 3755 个，gzip 后 base64 内联，约 207 KB）做 IoU 匹配；
4. 匹配到自己＝本来就是明文（不计入置信度分母）；低于阈值标 `?`，可交给视觉兜底。

实测：本课程 4 道题、42 个密文字，**42/42 命中、0 低置信、约 100 ms**。参考库可用 `tools/gen_refdb.py` 从思源黑体重新生成（换字体族时用得上），`tools/check_refdb.py` 可用真实密文字体做体检。

> 参考库必须**与查询端同一条渲染流程**（渲染→裁 bbox→缩放到 N→阈值）。图省事从 48×48 二次降采样会掉 0.1~0.2 IoU、还多出两个错字（括→恬、大→犬）。

## 技术栈

Vue 3.5（`vue.global.prod.js`，组件化 UI）+ Ant Design Vue 4.2（表单控件与主题 token）+ dayjs + ElementGetter 2.1（cxxjackie，异步元素监听）+ Ajax-hook（wendux，XHR 劫持备用）+ ScriptCat GM API。单文件零构建，**不引入 markdown 渲染库**：模型输出一律转义成纯文本展示（pre-wrap），避免 prompt injection 变成 DOM 注入。

跨帧数据流：答题在测验 iframe 里发生，窗口在顶层帧渲染；两者通过 GM 存储（`autocx.ai.*` 键）通信，流式文本按 300ms 节流写入，相位变化立即写。

## 开发调试

```powershell
# 静态检查(元数据/授权/@connect 等)
node ..\.agents\skills\scriptcat-userscript\scripts\check.mjs 学习通助手.user.js

# 回归测试(SSE 增量解析 / 答案解析 / 随堂练习纯函数)
node test\sse-parse.test.js
node test\parse-answer.test.js
node test\practice-parse.test.js

# 字体解码：真字体 + 12 条真密文（起个静态服务，两个页面都要看）
python test\fontdec\cors_server.py 8778
#   http://127.0.0.1:8778/harness.html         → 全量参考库路径
#   http://127.0.0.1:8778/harness-inline.html  → 内联库解压路径（等价于断网）

# 重新生成/注入参考库（换参考字体时用）
python tools\gen_refdb.py --ref <refbits.json> --font <参考字体.ttf> --size 24 --charset l1 --name refdb-l1-24
python tools\inject_refdb.py --bin test\fontdec\refdb-l1-24.bin
python tools\check_refdb.py --refdb test\fontdec\refdb-l1-24.bin --ttf <密文字体.ttf> --expect <已知map.json>

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