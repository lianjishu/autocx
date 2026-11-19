# 随堂练习（课堂测验）适配方案

> 2026-11-19 · 针对 AutoCX v1.0.7（`学习通助手.user.js`）
> 现场核查：数据库原理 · 课程 222368544 / 班级 153111863 · 随堂练习 `activeId=1000180349926`
> 起因：用户反馈「我们的答题助手这里没法解」，入口是课程主页
> `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?...` → 任务页 → 随堂练习

---

## 0. 结论先行

1. **这不是章节测验页，是另一个应用**。随堂练习跑在 `mobilelearn.chaoxing.com/page/quiz/stu/answerQuestion2`，
   是一套**独立 Vue 2** 应用（章节测验是 Vue 3 壳 + 服务端渲染的 `doHomeWorkNew`）。
2. **原脚本完全不匹配**，因为它按 URL 特征认角色：`detectRole()` 里没有这条路径，
   脚本在该页**静默退出**，一个日志都不打——这就是"没法解"的直接原因。
3. **该页没有字体混淆**（0 个 `cxsecret` 节点、无 `@font-face`），题干与选项都是明文。
   所以字体解码、Ajax-hook 抓接口这套重 machinery 一概不需要。
4. **题目与作答状态的权威来源是页面自己的 Vue 实例**（`#main.respond-container.__vue__`），
   DOM 与它一一对应。直接操作 DOM 的 `li.active` 即可让平台自己的处理函数更新状态。
5. 适配后实测：5 道单选**全部答对且回读校验通过**；1 道带图片的简答题走多模态**作答并填入成功**。

---

## 1. 现场证据

### 1.1 页面链路

```
课程主页  mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=222368544&clazzid=153111863&...
   └─ 任务 tab → iframe https://mobilelearn.chaoxing.com/page/active/stuActiveList?...&fid=2401
        └─ 该列表是 Vue 应用，每个 li 带 activeid / activetype / activestatus
             └─ activetype='42' → activeRowClick() → window.location.href =
                  /page/quiz/stu/answerQuestion2?courseId=..&classId=..&activeId=..&fid=..&timetable=..
```

注意 `activeType=42` 的任务**在同一标签页整页跳转**（不是开 iframe），所以脚本在新页面里独立运行。

### 1.2 该页的结构（取自平台模板 `answerQuestion2` 的 HTML）

| 项 | 实测 |
|---|---|
| Vue 版本 | `window.Vue.version === '2.6.10'`（**与脚本自带的 Vue 3 冲突**，见 §4.3） |
| 挂载点 | `#main.respond-container`（`__vue__` 挂在这里） |
| 题目容器 | `.left-question-list > .question-item`（class 随题型变：`single-choice` / `multiple-choice` / 无 class） |
| 题干 | `.question-name > .html-content-box`（`v-html="que.content"`） |
| 题型标记 | `.question-name > .grey-text`（`[Monoselect]` / `[Multichoice]` / `[TrueOrFalse]` / `[ShortAnswer]`…） |
| 选项 | `ul.option-list > li` > `span.option-letter` + `p.option-result` |
| 选中态 | `li.active` |
| 填空 | `ul.option-fill-list > li > input.ofl-ipt`（`v-model="que.personAnswer.blankAnswer[i].content"`） |
| 简答 | `.short-answer-textarea > textarea`（`v-model="que.personAnswer.content"`） |
| 提交 | `div.submit-btn`（`@click="submitCheck"`），`active.status === 2` 时不渲染 |
| 题目数据 | `vm.questionList[]`：`type` / `content` / `answer[]` / `personAnswer` / `answerLimitMap` |

### 1.3 题型编号（平台 `que.type`）

| type | 含义 | DOM class | 选项名 | `personAnswer` |
|---|---|---|---|---|
| 0 | 单选 | `single-choice` | A/B/C/D | `myoption: 'B'` |
| 1 | 多选 | `multiple-choice` | A/B/C/D | `myoption: 'AB'`（字母串，排序） |
| 2 / 9 / 10 | 填空/分录/资料 | 无 | — | `blankAnswer: [{name, content}]` |
| 3 / 16 | 判断 | `single-choice` | **`'1'` / `'2'`** | `myoption: '1'` |
| 4/5/6/7/18 | 简答/计算等 | 无 | — | `content: ''` |

> **判断题用 `'1'`/`'2'` 而不是 A/B** —— 这是本次最容易踩的坑，详见 §4.1。

### 1.4 关键接口

| 接口 | 用途 |
|---|---|
| `GET /v2/apis/quiz/quizDetail2?activeId=..&courseId=..&classId=..&DB_STRATEGY=PRIMARY_KEY&STRATEGY_PARA=activeId` | 取题目 JSON（`data.questionlist`） |
| `POST /v2/apis/studentQuestion/saveStuAnswerQuizTemp` | 临时保存（平台自己每 30s + 变更时触发） |
| `POST /v2/apis/studentQuestion/doQuestionAnswering` / `reDoQuestionAnswering` | 正式提交 / 复答 |

**不需要** `quizDetail2`：页面的 Vue 实例里已经有 `questionList`（同一份数据），直接读即可，
少一次网络往返，也避免 `quizDetail2` 在部分网关上 500。

### 1.5 提交流程

`submitCheck()` → 校验必填(`ismust===1`)、校验多选项数上下限(`answerLimitMap`) →
若仍有未答题则弹 `$.selectDialog`（`pop.js`）二次确认 → 否则直接 `submitAdd()`。

确认按钮：`a.jb_btn.jb_btn_92.fr.fs14.dialog_affrim`（文案「提交」）；
取消按钮：`a.btnBlue.btn_92_cancel.fr.fs14.dialog_cancle`。

### 1.6 图片

题干/附件里的图片**不在 `que.content` 里**，而是单独渲染：

```html
<div class="attach-img-list">
  <img :src="picDomainWithProtocol + '/star3/100_100c/' + rec.objectid + '.png'"
       v-bind:data-orignal="picDomainWithProtocol + '/star3/origin/' + rec.objectid + '.jpg'">
</div>
```

`src` 是 100×100 缩略图，**原图在 `data-orignal`**（注意平台自己把 `original` 拼错成了 `orignal`）。
多模态必须用原图，缩略图看不清表格。

---

## 2. 设计

### 2.1 角色识别

在 `detectRole()` 里加一条，且**必须排在批阅回看页判断之前**：

```js
// /page/quiz/stu/answerQuestion2  -> 作答页(本脚本要答的就是它)
// /page/quiz/stu/quizStudentQuestion -> 成绩/批阅回看页,绝不作答
if (/\/page\/quiz\/stu\/answerquestion2/i.test(path)) return 'practice';
```

回看页 `quizStudentQuestion` 天然落到 `null`（静默退出），已实测：脚本在该页零日志、零操作。

### 2.2 模块划分

新增 `initPracticePage()`（与 `initQuizPage()` 平级），职责：

```
detectRole → 'practice'
  └─ initPracticePage()
       ├─ 闸门: assist.quiz 关 / hasAnswerPermission=0 / active.status=2 / 页面已跳转
       ├─ extractPracticeQuestions(vm)   题干/选项/题型/图片/限制
       ├─ startAiSession(...)            与章节测验共用同一套作答记录协议
       ├─ answerOne(q) → LLM → parseAnswer → 复核 → fillPracticeAnswer → 回读校验
       └─ submitPractice(vm)             点 .submit-btn + 处理确认弹窗
```

**共用**（提到模块作用域，两边复用）：

| 函数 | 说明 |
|---|---|
| `htmlToText(html)` | HTML → 纯文本（题干/选项文案） |
| `buildPrompt(q)` | 组 prompt（含主观题、填空题数、多选项数上下限） |
| `normalizeLetters(raw)` | 模型回答 → 字母序列 |
| `parseAnswer(q, raw)` | 模型回答 → 结构化答案（新增 `subjective` 分支） |
| `startAiSession(opts)` | 作答记录会话（原来在 `initQuizPage` 里内联，提到模块作用域） |

### 2.3 填写方式：只点 DOM，不改 Vue 数据

**为什么不直接写 `vm.questionList[i].personAnswer.myoption`？**

平台对多选的存储格式有两种（`multipleChoiceClick` 里按 `isAllLetters(name)` 分支）：

- 选项名全是字母 → `myoption` 存字母串 `'AB'`
- 选项名不是字母（判断题的 `'1'`/`'2'`）→ 存逗号串 `'1,2'`

直接赋值得自己复刻这套格式规则，**很容易"填了但平台不认"**。
所以统一**点 `li`**，让平台自己的 `multipleChoiceClick` / `que.personAnswer.myoption = item.name` 去改状态：

- 单选/判断：`li` 的 `@click="que.personAnswer.myoption = item.name"`
- 多选：`li` 的 `@click="multipleChoiceClick(que,item,index)"`（切换语义）

多选是**切换**语义，所以要先算差集：把"当前已选"与"目标"不同的那些项点一下即可，
而不是无脑全点一遍（那会把已对的也点掉）。

### 2.4 回读校验：同一个取值空间里比

填完必须回读平台状态再比对意图。**两边必须用同一个取值空间**，否则会误判：

- 模型给的字母：`'A'` / `'B'`
- 平台存的值：判断题是 `'1'` / `'2'`，多选是 `'AB'`

所以提取时记两套：

```js
optLabels: ['A', 'B'],   // 展示给模型的字母
optValues: ['1', '2'],   // 平台真实取值
```

比对时用 `platformValuesOf(q, letters)` 把字母换算成平台取值再比。

### 2.5 复核策略按题型分

| 题型 | 复核方式 | 理由 |
|---|---|---|
| 多选 | **再答一次，要求规范化结果一致** | 客观题，字符串比较就是对的 |
| 填空 | 同上 | 同上 |
| 简答 | **让模型自评这一份答案** | 见下 |

**简答题为什么不能"答两次要比一致"？**

实测量到的一个反例（同一道"三范式"题，两次独立作答）：

- 作答一：拆成 员工 / 项目 / 员工参与项目 三个模式，**称各模式均满足 3NF，无需进一步分解**
- 作答二：拆成 员工 / 项目 / 员工参与项目，指出**员工表存在传递依赖，还要再拆出部门表**

两次都自洽、都可能对，但结论不同——字符串比当然"不一致"，判成"模型没把握"就白白丢掉好答案。

所以简答题改成**单份答案 + 自评**：把题目和这份回答交给模型，问"是否正确且完整地回答了题目"，
只回「通过」/「不通过」。只有明确不通过才跳过不填。
自评时若题干带图，同样把原图带上（否则模型看不到"图里的表"，无法判断答对没有）。

### 2.6 带图题目走多模态

`q.images` 非空且 `llm.vision` 开启时，用 `llm.visionMany(prompt, dataUrls)` 而不是 `llm.stream`。
图片走 `fetch` + `FileReader` 转 data URL（`p.cldisk.com` 带 `Access-Control-Allow-Origin: *`，可直连）。

**不只主观题**：单选/多选/判断的题干里也常嵌表格图，一样要带。

**取图失败不许静默降级**：原来 `fetchImageDataUrl` 失败只写 `log.debug`（默认关），
于是"取不到图 → 退化成纯文本 → 模型在瞎猜"这件事完全无声。改为 `log.warn`，
并在作答记录里标 `imageFailed`。

**主答与复核必须走同一条通道**：若主答带图、复核不带图，模型两次看到的信息不同，
复核必然判成"不一致"，带图的题就永远填不上。故抽 `askModel()` 统一处理。

**prompt 里要明说附了图**：一是部分模型对"裸图"权重不足，二是记录窗口里能一眼看出带了图。

### 2.7 提交策略

| 场景 | 行为 |
|---|---|
| `quiz.auto_submit_practice` 关（默认） | **只填不交**。平台本身在截止时会自动提交，没必要抢 |
| 开 + 全部题都答完且都校验通过 | 点 `.submit-btn`，再处理可能出现的确认弹窗 |
| 开 + 有题未答/存疑 | **不提交**，日志写明哪几题没答 |
| 任意时候 | 脚本菜单「提交本次随堂练习」可手动提交 |

确认弹窗只点文案为「提交/Submit/确定/确认/OK」的按钮，取消类一律不点（避免误关）。

---

## 3. 安全边界

沿用脚本既有原则：

- **自动提交默认关**，且是独立开关（不跟随章节测验/作业的开关）——三类页面的提交代价完全不同
- 任一题未答/存疑 ⇒ 整体不提交
- 页面出现「已提交 / 我的答案 / 正确答案 / 批阅 / 查看答案 / 得分」等特征 ⇒ **拒绝点击填写**
- `active.status === 2`（已结束）、`hasAnswerPermission === 0`（不在参与范围）⇒ 不动手
- 等待期间页面跳走（已提交的测验会跳回看页）⇒ 中止
- 验证码/风控 ⇒ 转人工（该页无此机制，保留既有兜底）

---

## 4. 踩过的坑

### 4.1 判断题的选项名是 `'1'`/`'2'`

平台判断题（type 3/16）的 `que.answer` 是 `[{name:'1',content:'对'},{name:'2',content:'错'}]`。
若按字母处理，会出现「提示词里写 A/B，平台存的是 1/2」→ 点得对、校验却不过。

**处理**：提取时展示字母统一改写成 A/B，同时用 `optValues` 记住平台真实取值；
prompt 里判断题固定写「A、正确 / B、错误」（语义固定，不必依赖平台文案）。

### 4.2 题目下标不能靠 `index - 1` 反推

提取时若跳过"题干为空"的题，`out` 的下标就和 `vm.questionList` 错位，
后续读写 `personAnswer` 会落到**别的题**上。故额外记 `vueIndex`。

### 4.3 页面自带 Vue 2，会覆盖脚本的 Vue 3

`@require` 的 `vue.global.prod.js` 在页面脚本之前求值，但页面自己的 `vue.js` 之后会把 `window.Vue` 换成 Vue 2。
脚本原先在运行时读 `window.Vue`，在该页拿到的是 Vue 2 → `createApp` 不存在 → 面板挂不上。

**处理**：脚本 IIFE 开头就把 Vue 3 / AntD 引用**抓住**（`const VUE3 = ...; const ANTD = ...;`），
后续不再依赖 `window.Vue`。

### 4.4 章节测验页的选项字母是打乱的

顺手修掉的既有 bug：`span.num_option[data]` 才是真字母，DOM 文本是显示字母，且两者**错位**
（实测第一题是 `["C/A","B/B","D/C","A/D"]`）。

原实现里 `readOption` 用 `data` 取字母（对），但 `fillAnswer` / `readCheckedLetters` 却按
**DOM 位置**推字母（`65+i`）——两者不一致，会**点错选项**，而"填后校验"又按同一套错字母自比，
于是**错答案还显示校验通过**。

**处理**：提取时把每个选项元素的真实字母一并记下（`optLabels`），填与校验都用它，不再按位置推。

### 4.5 章节测验的"已作答题数"统计误判

`input[type=hidden][name^=answer]` 会命中 `answerId`（答卷 id）和 `answertype`（题型标记），
被当成"已作答"，导致状态机判断偏乐观。改为只认 `answer + 数字`。

另外"已截止"的判据不能只匹配「截止/Deadline」——**未开放**的测验也会显示截止时间，
会误判成已截止。改为只认「已过期 / 不允许作答 / expired / unable to answer」这类明确文案。

### 4.7 章节测验的判断题：`data` 存的是 "true"/"false"，不是字母

用户反馈某一题作答失败（徽标显示「AI: A(填写异常)」）。

现场 DOM（章节测验页 `doHomeWorkNew`）：

```html
<li onclick="addChoice(this);" qid="402652498" qtype="3" role="radio" aria-label="对选择">
  <label class="fl before"><span class="num_option" name="answer402652498" data="true">A</span></label>
  <a class="fl after"><p>True</p></a>
</li>
<li ... aria-label="错选择">
  <label class="fl before"><span class="num_option" name="answer402652498" data="false">B</span></label>
  <a class="fl after"><p>False</p></a>
</li>
```

这里有**两个"字母"**，之前被混为一谈：

| | 含义 | 判断题的值 |
|---|---|---|
| 显示字母 | `span.num_option` 的**文字**，学生看到的就是它 | `A` / `B` |
| 平台取值 | `span.num_option[data]`，平台存进 `#answer<qid>` 的值 | **`true` / `false`** |

老实现一律拿 `data` 当字母，于是判断题变成 `label="true"` / `label="false"`：

- 提示词里出现 `true、True` / `false、False`（模型没法按字母答）
- 模型回了 `A` → `fillAnswer` 找不到 label 为 `A` 的选项 → **一个都没点中**
- 回读为空 → `意图=A 实际=` → 报「填写异常」

同一次运行里单选/多选都过了（日志：`题目1 填写校验: 意图=A 实际=A ✓`），
只有判断题失败 —— 因为只有判断题的 `data` 不是字母。

**修法**：拆成 `label`（显示字母，给模型/给点击）与 `value`（平台取值）。
显示字母只认 `span.num_option` 的文字（个别页面 `data` 与显示字母是错位的，
如 `data=C`/显示 `A`，所以更不能拿 `data` 当显示字母）。

另外把 `buildPrompt` 里"判断题写死 A、正确 / B、错误"的特判去掉了 ——
判断题要列**页面上的真实选项**（有的页面是 True/False，有的平台选项名是 1/2），
写死会在选项顺序或文案不同的页面上答反。

**实测**：修复后同一门课的章节测验 4 题（含 1 道判断题）全部校验通过，
判断题记录为 `My Answer: True`，该题得分 25.0，整套 100/100。

### 4.8 顺带核对了自动提交的开关语义

`config.get()` 读不到存储值时回落到 `DEFAULTS`，新加的 `quiz.auto_submit_practice` 默认 `false`。
实测该用户当前三个提交开关**都是开的**（`quiz.auto_submit` / `auto_submit_work` / `auto_submit_practice` 全为 `true`），
所以"随堂练习被自动提交了"是**按用户自己的设置**发生的，不是 bug。

为此给调试钩子加了 `__autocxAI.cfg()`：回显当前生效的全部开关（API Key 只露末 4 位），
以后再遇到"为什么它自动提交了/自动勾选了"这类问题，可以直接查。


模板里绑的是 `acx-open`：

```html
<div class="acx-ai-req" :class="{ 'acx-open': s.openReq[currentN] || ... }">
```

而 CSS 规则写的是 `.open`：

```css
#autocx-ai-vue-root .acx-ai-req.open .acx-ai-req-body{display:block}
```

两个类名对不上 ⇒ `.acx-ai-req-body` 永远是 `display:none`。
**结果：AI 作答记录里"脚本 → 模型"那一块的 prompt、参数、来源从来没显示过**，
点开也没反应。这正是"看起来没把题图发给模型"的直接原因——
不是没发，是**根本看不见请求内容**。

修法：CSS 改成 `.acx-ai-req.acx-open .acx-ai-req-body{display:block}`。
（`acx-ai-think` 那块用的 `acx-collapsed` 前后一致，没这个问题。）

---

## 5. 验证结果

### 5.1 静态检查与回归测试

```
node ..\.agents\skills\scriptcat-userscript\scripts\check.mjs 学习通助手.user.js
  → 3 个 connect-missing 告警（github/gitee/deepseek），与既有版本一致，不加 @connect

node test\sse-parse.test.js       → 9/9
node test\parse-answer.test.js    → 14/14
node test\practice-parse.test.js  → 22/22   （新增）
```

### 5.2 实测（用户真实浏览器 + 真实 ScriptCat）

| 用例 | 结果 |
|---|---|
| 5 道单选（`activeId=1000180349926`） | 全部答完，**逐题「意图=实际 ✓」**，DOM `li.active` 与 `vm.personAnswer` 完全一致 |
| 1 道带图简答（`activeId=1000179118910`） | 识别到图片 → 走多模态 → 自评「通过」→ 填入 360 字，DOM 与 `vm.personAnswer.content` 一致 |
| 已提交测验的回看页 | **零日志、零操作**（`detectRole` 返回 `null`） |
| 章节测验（已过期） | 正确判定为 `closed`，不填不交 |

单选那 5 题逐题人工核对**语义正确**（部分函数依赖→2NF、历史快照反范式化、1:n 外键映射、
内聚性那条是错误项、"没有物理外键就不能 JOIN"是错误项）。

### 5.3 未能实测的部分

本课程 28 个测验里**没有开放的多选题/填空题**（多选与判断题所在的测验均已结束，`status=2`，
点进去会跳回看页）。因此多选/填空/判断的**填写**逻辑是通过以下方式验证的：

- 从平台模板源码（`answerQuestion2` 的 HTML + Vue 实例的方法）确认语义：
  多选 `myoption` 是**排序后的字母串** `'AB'`，判断题是**逗号串** `'1,2'`
- 用**平台自己的方法**在一次性 Vue 实例上跑了一遍（不碰用户真实作答数据）验证上述语义
- 纯函数部分（选项取值映射、多选集合解析）有回归测试覆盖

判断题/多选/填空的**端到端**实测需要一门有开放多选题的课程，暂缺。

### 5.4 题图到底有没有发给模型（专项核查）

用户反馈"很显然刷题工具没把题图发给模型"，据此做了对照实验：
**同一个 prompt，带图 / 不带图各发一次**（`activeId=1000179118910`，题图是一张
"员工项目"数据表的截图，列：员工编号 / 员工姓名 / 部门 / 项目编号 / 项目名称 / 项目预算 / 所在城市）：

| | 纯文本作答 | 带图作答 |
|---|---|---|
| 员工编号的依赖 | `员工编号 → 员工姓名、部门编号、部门名称` ❌ 臆造 | `员工编号 → 员工姓名、部门` ✅ 与图一致 |
| 项目编号的依赖 | `项目编号 → 项目名称、项目预算、项目所在城市` ❌ 列名不对 | `项目编号 → 项目名称、项目预算、所在城市` ✅ |
| 员工项目表 | `（员工编号，项目编号[，工时]）` ❌ 臆造"工时"列 | `（员工编号，项目编号）` ✅ |

纯文本那次连"部门编号/部门名称/工时"这种**图里根本没有的列**都编出来了 ——
因为题干文字只说了"每个员工属于唯一一个部门""每个项目有唯一的项目编号、名称、预算和所在城市"，
根本没列全部字段。带图那次逐字读出了真实列名。

**结论：题图确实发出去了、模型确实用了。** 用户看到的"没发图"是 §4.6 那个 CSS bug ——
请求体（含 prompt 与所附图片）从来没显示过，看起来就像"只发了个纯文本 prompt"。

顺带把"图到底发没发"变成**可核查**的：作答记录里显示「已附题图 N 张」+ 题图缩略图 + 原图链接。

---

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `学习通助手.user.js` | `detectRole` 加 `practice`；新增 `initPracticePage()`；`buildPrompt`/`parseAnswer` 提到模块作用域并加 `subjective` 分支；新增 `startAiSession()`、`askModel()`、`buildMultimodalContent()`、`llm.visionMany()`、`optionLabelOf()`/`optionValueOf()`；新增 `SELECTORS.practice`；新增 `quiz.auto_submit_practice`；新增调试钩子 `__autocxAI.cfg()`；修 §4.4 / §4.5 / §4.6 / §4.7 四个既有 bug；Vue 3 引用提前抓住 |
| `test/practice-parse.test.js` | 新增：随堂练习纯函数回归测试（HTML 转文本、多选集合解析、平台取值映射、多模态 content 组装、显示字母/平台取值拆分） |
| `README.md` | 功能表/配置表/安全边界/已知限制补充随堂练习与题图 |
