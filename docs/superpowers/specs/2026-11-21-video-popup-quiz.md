# 视频中途弹题：交给 LLM 作答

> 2026-11-21 · 针对 AutoCX v1.0.13（`学习通助手.user.js`）
> 现场核查：生命安全与救援 · 课程 269158619 / 班级 159668111 · 章节 705053897（三角巾包扎法）
> 起因：用户要求「适配处理视频任务中出现的题目」，并带了一张视频弹题的截图

---

## 0. 结论先行

1. **原来的"随机作答"其实是坏的**。脚本用的选择器是旧版结构
   （`.xTiTle` / `.tkList li` / `.xAnswer li` / `.btn-submit`），
   而 2026 版平台早就不长这样了 —— 所以这段功能等于**从来没生效过**。
2. **现在改用 LLM 作答**：识别单选/多选/判断，题干带图就多模态，答完点提交。
3. **弹题不影响任务点完成**（用户实测确认）。平台统计的是"观看时长"，
   弹题是覆盖在视频上的浮层，**视频本身继续播**；就算不答，任务点照样算完成。
4. 但脚本仍然**先恢复播放再答题** —— 因为平台偶尔会暂停视频，
   而模型思考可能要几十秒，这段时间不该白丢（见 §4.1）。

---

## 1. 现场证据

### 1.1 旧选择器为什么失效

脚本里原有的：

```js
popupQuiz:   '.xTiTle',
popupOption: '.tkList li, .xAnswer li',
popupSubmit: '.btn-submit, .xBtn',
```

这些是 2019 年前后的学习通弹题结构。2026 版换了另一套（见 §1.3），
所以 `elmGetter.each('.xTiTle', ...)` 永远等不到元素 —— 静默失效。

### 1.2 新结构的来源

`ananas/modules/video/index.html` 加载了两个关键样式表：

- `/ananas/videojs-ext/videojs-ans.css`
- `/ananas/videojs-ext/videojs-test-ans.css`

CSS 选择器直接把 DOM 结构暴露出来了：

```css
.ans-timelineobjectsbg { background: rgba(0,0,0,.7); z-index: 1 }   /* 黑色遮罩 */
.ans-timelineobjects   { position:absolute; width:100%; height:100% }
.ans-videoquiz         { text-align:left; padding:20px }
.ans-videoquiz-title   { white-space:pre-wrap }
.ans-videoquiz-opts    { padding:0; margin-top:20px }
.ans-videoquiz-opt     { list-style:none; margin-top:20px }
.ans-videoquiz-opt input { vertical-align:middle; margin-right:10px }
.ans-videoppt          { float:left; cursor:pointer }
.tkTopic / .tkTopic_title / .tkTopic_con / .tkTopic_oper / .tkTopic_numbar
.tkItem / .tkItem_title / .tkItem_ul
.tkRadio / .tkCheck
.ans-videoquiz-submit / .ans-videoquiz-continue
```

`videojs-ext.min.js` 里的模板片段进一步确认了层级：

```
'<div class="tkTopic">',
  '<div class="tkTopic_title">…题型标题…</div>',
  '<div class="tkTopic_numbar fr">…{interactiveQuestionCount} 题中已答对 <i id="rightNum"></i> 题…</div>',
  '<div class="tkTopic_con tkScroll">',
    '<ul class="tkItem_ul">',
      '<li …><span class="tkRadio"><input type="{多选题?checkbox:radio}" name="ans-videoquiz-opt" value="{isRight}"><i></i></span>{name}、{description}</li>',
    '</ul>',
  '</div>',
'<div class="tkTopic_oper">',
  '<a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submitting" style="display:none">Submitting</a>',
  '<a class="ans-videoquiz-continue bntLinear fr" id="videoquiz-continue">Continuing</a>',
  '<span class="spanHas" id="spanHas">Correct answer</span>',
  '<span class="spanNot" id="spanNot">Wrong answer</span>',
  '<span class="spanNotBack" id="spanNotBack">Wrong answer，Looking back at minutes</span>',
'</div>',
```

### 1.3 实测的真实 DOM（2026-11-21 15:29 抓取）

```html
<div class="x-component ans-videoquiz" id="videoquiz-1048">
  <div class="tkTopic">
    <div class="tkTopic_title">True or false</div>
    <div class="tkTopic_con tkScroll" id="ext-gen1065">
      <div class="tkItem">
        <div class="tkItem_title">包扎过程中，被包扎处粗细不均匀的情况下，不能使用环形包扎法。</div>
        <ul class="tkItem_ul">
          <li class="ans-videoquiz-opt">
            <label><span class="tkRadio"><input type="radio" name="ans-videoquiz-opt" value=""><i></i></span>A、对</label>
          </li>
          <li class="ans-videoquiz-opt">
            <label><span class="tkRadio"><input type="radio" name="ans-videoquiz-opt" value=""><i></i></span>B、错</label>
          </li>
        </ul>
      </div>
    </div>
    <div class="tkTopic_oper" id="ext-gen1066">
      <a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submit">Submit</a>
      <a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submitting" style="display:none">Submitting</a>
      <a class="ans-videoquiz-continue bntLinear fr" id="videoquiz-continue">Continuing</a>
      <span class="spanHas fr" id="spanHas">Correct answer</span>
      <span class="spanNot fr" id="spanNot">Wrong answer</span>
      <span class="spanNotBack fr" id="spanNotBack">Wrong answer，Looking back at minutes</span>
    </div>
  </div>
</div>
```

要点：

| 项 | 实测 |
|---|---|
| 题干 | `.tkItem_title` |
| 题型标题 | `.tkTopic_title`（如 "True or false"） |
| 选项 | `ul.tkItem_ul > li.ans-videoquiz-opt`，文字形如 `A、对` |
| 选项输入 | `input[name=ans-videoquiz-opt]`，`type` 是 `radio`（单选/判断）或 `checkbox`（多选） |
| 提交 | `#videoquiz-submit`（一开始就可见）；`#videoquiz-submitting` 是提交中的状态 |
| 继续 | `#videoquiz-continue` |
| 平台判定 | `#spanHas`(对) / `#spanNot`(错) / `#spanNotBack`(错，可回看) |
| 一个面板的题数 | `.tkTopic_con` 下可以有**多个** `.tkItem` |

> `input[value="{isRight}"]` 里的 `isRight` 在这个题型下是**空串**，
> 正确答案不在 DOM 里 —— 只能靠模型答。

---

## 2. 设计

### 2.1 处理顺序：先恢复播放，再答题

```js
// 1) 先恢复播放:弹题期间平台是暂停的,不恢复就等于白看
if (video && video.paused) video.play();
// 2) 再问模型 → 3) 点选项 → 4) 提交 → 5) 再恢复一次播放 + 点"继续"
```

理由：模型的思考时间（可达几十秒）不该让"观看时长"停摆。
弹题本身不阻断任务点完成（§4.1），所以**先恢复播放是零风险的**。

### 2.2 题型判定

```js
const isCheckbox = options.some((o) => o.input && o.input.type === 'checkbox');
let type = 'single';
if (isCheckbox) type = 'multi';
else if (options.length === 2) type = 'judge';
```

两个选项的 radio 判为判断题（题干通常写着 True/False）。
同时把面板标题（`.tkTopic_title`）拼进题干，让模型知道这是判断题：

```
True or false｜包扎过程中，被包扎处粗细不均匀的情况下，不能使用环形包扎法。
```

### 2.3 选项文字拆分

选项文字是 `A、对` / `A.“8”字包扎法` / `A 螺旋形`。
拆成 `{label:'A', text:'对'}` 给模型 —— 纯函数 `splitVideoQuizOption()`，有回归测试。

### 2.4 答不上来怎么办

| 情况 | 处理 |
|---|---|
| 没配 API Key | 退回随机选一个（保持旧行为，至少让弹题消失） |
| 模型回答无法解析成字母 | 跳过该题，不作答 |
| 模型超时（45s） | 跳过该题，不作答 |
| 找不到对应选项 | 跳过该题，不作答 |
| 单题没答上 | 面板照常提交（平台会判错），视频继续播 |

**任何失败都不影响观看进度** —— 因为播放早就恢复了。

### 2.5 记录

弹题也写进「AI 作答记录」（`startAiSession`，sid 前缀 `v`），
在课程页的 AI 页签里能看到每一题的 prompt / 回答 / 是否勾选。

---

## 3. 验证结果

### 3.1 回归测试

```
node test\sse-parse.test.js       → 9/9
node test\parse-answer.test.js    → 14/14
node test\practice-parse.test.js  → 55/55
node test\video-quiz.test.js      → 14/14   （新增）
```

### 3.2 实测（用户真实浏览器 + 真实 ScriptCat）

| 项 | 结果 |
|---|---|
| 识别 | `检测到视频弹题,共 1 题,交给模型作答` ✓ |
| 播放 | `检测到视频弹题,已恢复播放(不影响观看进度)` ✓ |
| 作答 | `弹题第 1 题作答:A → 对`（模型答 A，选项文字"对"）✓ |
| 提交 | `已提交视频弹题` ✓ |
| 平台反馈 | 弹题面板提交后消失（判对时平台会自动继续）✓ |
| 任务点 | 随后 `检测到任务点完成标记(.ans-job-finished)` ✓ |
| 记录 | AI 作答记录里出现「视频弹题」会话（1 题，prompt/回答/勾选状态齐全）✓ |

题目是「包扎过程中，被包扎处粗细不均匀的情况下，不能使用环形包扎法。」——
按急救常识该说法为真（A=对），模型答 A 与之一致。

---

## 4. 关键结论与坑

### 4.1 弹题到底影不影响任务点完成？

**不影响。** 三条依据：

1. **用户实测**：弹题未作答时，任务点照样完成。
2. **平台弹题是浮层，不改视频状态**：实测弹题出现时
   `video.paused === false`、`currentTime` 继续增长。
3. **参考实现（ABC学习通网课助手）直接跳过**：它检测到弹题就把容器和遮罩 `display:none`，
   然后 `video.play()` 继续播，压根不答题 —— 也就是说这条路上游也没把它当"必须答"。

> 但脚本仍然先恢复播放再答题：平台偶尔会暂停视频，而模型思考可能要几十秒，
> 那段时间不该白丢。这是"锦上添花"，不是"必须"。

### 4.2 旧选择器静默失效

这是本次最大的发现：**功能看起来存在，实际从来没跑过**。
`.xTiTle` 这种老选择器在新版页面上匹配不到任何东西，
`elmGetter.each` 不会报错，只会一直等下去 —— 没有日志、没有提示。

同类风险还有：`SELECTORS.quiz.option` 等章节测验选择器也是老结构，
本轮已经单独核对过（见 §1.3 的 `ans-videoquiz-opt` 对照）。

### 4.3 `value="{isRight}"` 是空的

模板里 `<input ... value="{isRight}">` 看着像"答案就在 DOM 里"，
但实测这个题型下 `value=""` —— 正确答案不下发到前端，只能靠模型。

### 4.4 判定题型不能只看选项数

多选题的 `<input type="checkbox">`、单选/判断的 `type="radio"` 才是权威，
选项数只是辅助（两个 radio → 判断题）。

---

## 5. 涉及文件

| 文件 | 改动 |
|---|---|
| `学习通助手.user.js` | `SELECTORS.video` 换成 2026 版弹题结构（保留老结构兜底）；新增 `handleVideoQuiz()` / `extractVideoQuizItems()` / `collectVideoQuizImages()` / `pickVideoQuizOption()` / `pickVideoQuizRandomly()` / `submitVideoQuiz()` / `splitVideoQuizOption()`；`fetchImageDataUrl` 提到模块作用域供两个模块共用；新增 `withTimeout()` |
| `test/video-quiz.test.js` | 新增：弹题选项文字拆分 + 判断题文案反查 |
| `README.md` | 功能表/安全边界/回归测试命令补充弹题 |
