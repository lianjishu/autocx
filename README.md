# AutoCX 学习通自动看课+LLM答题助手

轻量级 ScriptCat 脚本：学习通自动看课（视频/文档课件）+ LLM 辅助章节测验答题。

设计文档：[docs/superpowers/specs/2026-11-18-chaoxing-auto-course-design.md](docs/superpowers/specs/2026-11-18-chaoxing-auto-course-design.md)

## 功能

| 模块 | 行为 |
|---|---|
| 视频/音频任务点 | 页面真实播放（不碰进度接口）、倍速（默认 2x，可调 1–16）、静音、中途弹题随机作答、风控验证自动暂停等人工 |
| 文档/课件任务点 | PPT/PDF 自动翻页、图书自动滚动，间隔随机化 |
| 章节测验 | 提取题目 → OpenAI 兼容 LLM 答题（90s 超时、失败重试 1 次、2 路并发）→ 自动勾选 → **人工核对后自行提交，脚本绝不自动提交** |
| 自动推进 | 当前章节完成后自动切换目录中下一个未完成章节 |
| 悬浮面板 | 状态聚合 / 跨帧日志 / 设置（LLM 配置、倍速、开关等） |

## 安装

1. 浏览器安装 [ScriptCat](https://scriptcat.org/) 扩展
2. 把 `学习通助手.user.js` 拖入 ScriptCat 管理面板（或新建脚本粘贴内容）
3. 打开学习通课程学习页（`mooc1.chaoxing.com/mycourse/studentstudy?...`），右下角出现蓝色 **CX** 悬浮球即生效

## 配置（面板 → 设置）

| 项 | 默认 | 说明 |
|---|---|---|
| LLM Base URL | `https://api.deepseek.com/v1` | 任意 OpenAI 兼容接口 |
| LLM API Key | 空 | 不填则测验只做题目提取，不答题 |
| LLM 模型 | `deepseek-chat` | |
| 视频倍速 | 2 | 1–16，建议 ≤4 降低风控概率 |
| 视频静音 | 开 | |
| 自动勾选答案 | 开 | 关闭则只看 AI 建议手动选 |
| 翻页间隔基数 | 2s | 文档任务 |
| 调试日志 | 关 | |

首次调用 LLM 时 ScriptCat 会弹"允许访问域名"，允许即可（脚本未声明 @connect，由用户按需授权，兼容任意自建/中转接口）。

## 安全边界（硬编码）

- **测验提交永远人工**：脚本只填写，任何失败退化为"暂停 + 提示人工"
- 风控验证（滑块/验证码）绝不自动处理，出现即暂停
- 视频走页面真实播放，不调用进度上报接口

## 已知限制

- **字体混淆**：学习通对部分题目用自定义字体混淆 DOM 文本（半明文半乱码）。脚本在 prompt 中提示模型按上下文推断，强模型通常能答对；彻底方案是字体映射解密（参考 ABC 助手的 ttf 表），列为后续可选增强
- 作业/考试（独立答卷、切屏检测）暂不支持
- 仅支持超星学习通（`*.chaoxing.com`）

## 技术栈

jQuery 3.7（DOM）+ ElementGetter 2.1（cxxjackie，异步元素监听）+ Ajax-hook（wendux，XHR 劫持备用）+ ScriptCat GM API。单文件零构建。

## 开发调试

```powershell
# 静态检查(元数据/授权/@connect 等)
node ..\.agents\skills\scriptcat-userscript\scripts\check.mjs 学习通助手.user.js

# sctl 热更新调试循环
sctl install 学习通助手.user.js   # 浏览器内批准后生效
sctl page reload --tab <id>
sctl logs <uuid>                  # 读 [AutoCX] 日志
```
