# 考试页（exam-ans）适配方案

> 2026-11-20 · 针对 AutoCX v1.0.11（`学习通助手.user.js`）
> 现场核查：大学生防艾健康教育 · 课程 269158654 / 班级 159668179 · 考试 `examId=10963866`
> 起因：用户要求适配 `https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examnotes?courseId=269158654&classId=159668179&examId=10963866&cpi=429582785`

---

## 0. 结论先行

1. **考试页原本被当成章节测验处理**。`detectRole()` 里有一条 `/(mooc2?-ans\/)?(work|exam)\//`，
   `/exam-ans/exam/...` 直接命中 `'quiz'`。但两者的选项 DOM、选项点击函数、提交流程完全不同，
   所以"能打开但答不了"。现在考试单独识别为 `'exam'`。
2. **考试有三个页面**，脚本只自动处理后两个：

   | 页面 | URL | 脚本做什么 |
   |---|---|---|
   | 开始页 | `/exam-ans/exam/test/examcode/examnotes` | **什么都不做**，只提示人工点"同意"并过安全验证 |
   | 答题页 | `/exam-ans/exam/test/reVersionTestStartNew` | 点顶部 **Preview** 切到整卷预览；没有 Preview 就按单题模式答 |
   | 整卷预览页 | `/exam-ans/mooc2/exam/preview` | **主战场**：85 道题全在 DOM 里，逐题答 → 回读校验 → （按开关）交卷 |

3. **整卷预览是唯一值得用的入口**。答题页一次只渲染一道题（85 道要翻 85 次页面），
   预览页一次给全部题目。
4. **选项的"显示字母"与"平台取值"是错位的**，这是本页面最容易出错的地方：
   `<span data="B" class="... num_option ...">A</span>` —— 屏幕上是 A，存进 `answer<qid>` 的是 B。
5. 实测：**85/85 题全部答完并逐题回读校验通过**（40 单选 + 15 多选 + 30 判断）。

---

## 1. 现场证据

### 1.1 三个页面的关系

```
开始页  /exam-ans/exam/test/examcode/examnotes
   └─ 人工:勾" I have read and agree " → 点 Start
        └─ showCXCaptcha()  安全验证(点选验证码,captchavalidate)
             └─ preCheckAction → checkAction → GET /exam/test/examcheck?view=json
                  └─ 成功 → location.href = /exam-ans/exam/test/reVersionTestStartNew?...&enc=xxx
                       └─ 答题页(一题一题) → 顶部 Preview → topreview()
                            └─ submitForm(true,...) 临时保存 + 取新 enc
                                 └─ location.href = /exam-ans/mooc2/exam/preview?...   ← 整卷
```

**`enc` 是一次性的**：直接手拼 URL 访问 `reVersionTestStartNew` 或 `mooc2/exam/preview` 会得到
「无权限访问！」。必须走平台自己的流程（先临时保存拿到新 enc）。所以脚本**不能自己拼 URL 跳转**，
只能点平台自己的按钮。

### 1.2 整卷预览页的结构

| 项 | 实测 |
|---|---|
| 题目容器 | `.questionLi`（`id="sigleQuestionDiv_<qid>"`），85 个 |
| 题号/题型 | `input[name=questionId]`（qid）、`input[name=type<qid>]`（题型） |
| 题干 | `.mark_name` 里**最后一个直接子 div**（前面那个 `div.qnoRow` 是题号+题型标记+Mark 按钮） |
| 选项 | `.answerBg` → `span.num_option`（单选/判断）或 `span.num_option_dx`（多选）+ `.answer_p` |
| 选项点击 | `onclick="saveSingleSelect(this,'<qid>')"` / `clickSaveMultiSelect(this,'<qid>')` |
| 答案字段 | 单选/判断 `input[name=answer<qid>]`；**多选是 `answers<qid>`（多个 s）** |
| 提交 | `div.sub-button.fr > a.completeBtn` 文案 **Submit** → `finalSubmit()` |
| 预览 | 同一个 `a.completeBtn`，但在答题页文案是 **Preview** → `topreview()` |
| 交卷确认 | `#submitConfirmPop a.confirm`（文案 Confirm） |
| 计时 | `#timer`（`59' 49''` 这种格式） |

### 1.3 题型分布（本场考试 85 题）

| type | 题型 | 题数 | 选项数 | 选项名 | 答案字段 |
|---|---|---|---|---|---|
| 0 | 单选 | 40 | 4 | A/B/C/D（`data` 里是**打乱的字母**） | `answer<qid>` |
| 1 | 多选 | 15 | 4 | 同上 | `answers<qid>` |
| 3 | 判断 | 30 | 2 | `data` 是 **`true`/`false`** | `answer<qid>` |

### 1.4 判分空间：平台按 `data` 判分

平台自己的点击处理：

```js
function addChoice(obj) {
    var qid = $(obj).attr("qid");
    if ($(obj).hasClass("check_answer")) { $(obj).removeClass("check_answer"); }
    else { $(".choice" + qid).removeClass("check_answer"); $(obj).addClass("check_answer"); }
    var choiceContent = "";
    $(".choice" + qid).each(function () {
        if ($(this).hasClass("check_answer")) { choiceContent = choiceContent + $(this).attr("data"); }
    });
    $("#answer" + qid).val(choiceContent);   // ← 存的是 data,不是显示字母
}
```

即：**屏幕显示的字母与平台存的字母不是一回事**。

> 实测第 1 题：显示 `A.25%—36% B.15%—27% C.65%—80% D.37%—54%`，
> 四个选项的 `data` 依次是 `B A D C`。模型答"显示 D"（37%—54%，正确），
> 平台最终存的是 `C`（因为显示 D 的 `data` 是 C）。

**结论：字母命名空间纯属脚本内部的事**。只要"按显示字母找到对应选项并点它"，
平台存的就是正确的那个 `data` 值，判分自然对。
所以脚本内部用**显示字母**跟模型对话，**平台取值**只用于回读校验。

### 1.5 多选是"切换"语义，而且顺序不固定

```js
function addMultipleChoice(obj) {
    ... $(".choice" + qid).each(function () {
        if ($(this).hasClass("check_answer_dx")) { choiceContent = choiceContent + $(this).attr("data"); }
    });
    $("#answer" + qid).val(choiceContent);
}
```

- **切换**：已选的再点一次会**取消**。
- **顺序**：按选项在页面上的顺序拼接，**不是排序后的**。
  模型选 ACD、页面存的是 `"ADC"` 这样的情况很常见（内容对，顺序不同）。

### 1.6 考试页的其它安全项（本场实测）

| 项 | 值 | 含义 |
|---|---|---|
| `snapshotMonitor` / `webSnapshotMonitor` / `electronSnapshotMonitor` | 0 | 无截屏监控 |
| `switchScreenControl` / `pcclientSwitchout` | 0 | 无切屏监控 |
| `needFaceRecognition` / `webNeedFaceRecognition` | 0 | 无人脸识别 |
| `captchaCheck` | 1 | **进入考试要过点选验证码**（脚本不碰） |
| `forbidMultiterminal` | 1 | **禁止多终端**（不要开第二个标签页） |
| `limitTime` | 60 | 60 分钟 |
| `expiredAutoSubmit` | 1 | 到点自动交卷 |
| `selftestMode` | 0 | 非自测模式 |

> `forbidMultiterminal=1` 是踩过的坑：调试时多开了一个标签页，
> 平台立刻弹出"您的账号于…在一台谷歌内核浏览器设备登入章节页面"的告警并把页面踢走。

---

## 2. 设计

### 2.1 角色识别

```js
// 必须放在原来那条 '/exam/' → 'quiz' 之前,否则考试会被当章节测验
if (/exam-ans/.test(path) || /\/(exam|mooc2\/exam)\//i.test(path)) return 'exam';
```

同时把原来那条规则里的 `exam` 去掉：

```js
// 改前:(mooc2?-ans\/)?(work|exam)\/
// 改后:(mooc2?-ans\/)?work\/
```

### 2.2 等待题目渲染

考试页是**服务端渲染 + jQuery 拼 DOM**，题目异步出来。
第一版实现直接在 `init` 里提取，结果是**页面还没渲染完就提取到 0 道题**：

```
[AutoCX][exam] 考试整卷预览页启动
[AutoCX][exam] 未提取到题目          ← 相隔 8ms
```

改成和章节测验一样先等 DOM：

```js
elmGetter.get(SELECTORS.exam.question, 20000).then(() => setTimeout(onExamReady, 500));
```

### 2.3 答题页 → 整卷预览

答题页只有一道题，85 道要翻 85 次。点平台自己的 Preview 按钮即可切到整卷：

```js
const previewBtn = findExamButton(/preview|预览/i);
if (previewBtn) { previewBtn.click(); return; }   // 切到整卷后脚本在新页面重新启动
runSingleQuestionExam();                            // 退路:没有 Preview 就一题一题答
```

**注意按钮复用**：`a.completeBtn` 在答题页是 **Preview**、在预览页是 **Submit**。
所以 `findExamButton()` 必须**按文案**匹配，不能只按选择器：

```js
function findExamButton(re) {
  const sel = [SELECTORS.exam.submit, SELECTORS.exam.next, 'a.completeBtn', 'a.jb_btn'].join(',');
  return [...document.querySelectorAll(sel)].find((el) => {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;   // 隐藏的弹窗按钮不算
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t && re.test(t);
  }) || null;
}
```

### 2.4 提取

```js
type = input[name=type<qid>]  →  0=单选 1=多选 3=判断
label = span.num_option 的文字      ← 显示字母（给模型）
value = span.num_option[data]       ← 平台取值（给校验）
```

题干取 `.mark_name` 的**最后一个直接子 div**（`div.qnoRow` 是题号行，不是题干）。

### 2.5 填写：点 DOM，不改数据

和随堂练习同理，一律走平台自己的 `onclick`：

- 单选/判断：`saveSingleSelect(this,'<qid>')`
- 多选：`clickSaveMultiSelect(this,'<qid>')`（**切换**语义，且有 500ms 防抖后才发保存请求）

### 2.6 校验：拆成取值集合再比

平台按 DOM 顺序拼接取值，所以：

```js
// 期望:模型选的显示字母 → 平台取值,排序
const expectVals = letters.map((L) => examValueOf(q, L)).sort();
// 实际:把平台拼的串拆回单个取值,排序
const actualVals = splitExamValues(actual, q.optValues);
```

`splitExamValues` 用该题已知的取值集合做**贪心前缀匹配**拆分——
不能按字符拆（判断题的取值是 `true`/`false` 这种多字符）。

### 2.7 交卷

```js
const btn = findExamButton(/submit|交卷/i);   // 必须是 Submit,不能是 Preview
btn.click();
// 等 #submitConfirmPop a.confirm,文案是 Confirm/确定 才点
```

**自动交卷默认关**（`quiz.auto_submit_exam`），因为考试交卷后成绩就定了。
交卷前会把 85 个答案字段全部读回来核对，有任何一题没写进去就不交。

---

## 3. 踩过的坑

### 3.1 多选"内容对却判成没填上"

第一版把期望值排序后去比没排序的实际值：

```
题目47 填写校验: 意图=ACD 实际=ADC ✗
题目46 填写校验: 意图=ABCD 实际=BDCA ✗
```

内容完全一样，只是顺序不同（平台按 DOM 顺序拼接）。
15 道多选**全部**被误判成失败 → 整卷永远不会交卷。

**修法**：两边都拆成取值集合再比较（§2.6）。

### 3.2 单选"再点一下就清空了"

平台的选择是**切换**语义。刷新页面后平台会把已存的答案渲染成选中态，
脚本再点一次目标选项 → **把答案取消了**：

```
题目28 填写校验: 模型选=A(平台值 D) 实际= ✗     ← 实际是空
```

**修法**：点之前先看目标选项是不是已经选中了：

```js
function isExamOptionSelected(el) {
  const sp = el.querySelector(SELECTORS.exam.optionLetter);
  if (!sp) return false;
  // 按 class 名单个匹配,别用 indexOf —— check_answer_dx 里也含 check_answer
  return String(sp.className || '').split(/\s+/).indexOf('check_answer') >= 0;
}
```

多选那边本来就是按"当前值 vs 目标值"的差集点，天然幂等，不用改。

### 3.3 判断题的选项名是 `true`/`false`

判断题（type 3）的 `data` 是 `true`/`false`，不是字母。
如果把 `data` 当显示字母，模型就会看到"A、True"以外的怪东西。

脚本内部仍以**显示字母**（A/B）跟模型对话，另外加一道保险：
模型没按字母答（直接答"正确"/"错误"/"True"）时，用 `matchOptionByText()`
按语义反查字母。

### 3.4 `a.completeBtn` 既是 Preview 又是 Submit

见 §2.3。参考实现里 `div.sub-button.fr a.completeBtn` 被当成交卷按钮，
在这套页面上会**点成 Preview**（切到整卷），根本交不了卷。

### 3.5 平台每次点击都会发一次临时保存

`saveSingleSelect` → `submitForm(true, div, callBack)` → 发 AJAX。
连点太快会被平台自己的 `submitOnce` 保存锁挡掉，部分题目没存上。
所以脚本在每题之间留 120ms 间隔。

---

## 4. 验证结果

### 4.1 静态检查与回归测试

```
node ..\.agents\skills\scriptcat-userscript\scripts\check.mjs 学习通助手.user.js
  → 3 个 connect-missing 告警（github/gitee/deepseek），与既有版本一致

node test\sse-parse.test.js       → 9/9
node test\parse-answer.test.js    → 14/14
node test\practice-parse.test.js  → 55/55   （新增考试相关用例）
```

### 4.2 实测（用户真实浏览器 + 真实 ScriptCat）

| 项 | 结果 |
|---|---|
| 角色识别 | `角色识别: exam @ mooc1.chaoxing.com/exam-ans/mooc2/exam/preview` ✓ |
| 题目提取 | 85 题（单选 40 / 多选 15 / 判断 30）✓ |
| 答题 | **85/85 题已作答**，逐题"填写校验 ✓" |
| 平台状态回读 | 85/85 题的 `answer<qid>` / `answers<qid>` 都有值，0 空 ✓ |
| 自动交卷 | **未交卷**（`quiz.auto_submit_exam` 默认关，行为正确）✓ |
| 交卷按钮识别 | `a.completeBtn` 文案 Submit → `finalSubmit()` ✓（不是 Preview） |
| 人工核对抽样 | 第 1 题模型答显示 D（37%—54%，正确）、平台存 C（显示 D 的取值）；第 41 题 ABCD（ABCD 法四要素全选）；第 56 题判 True（肛交传播风险是阴道性交 18 倍）✓ |

### 4.3 未实测的部分

- **交卷动作本身没有自动触发过**（默认关，且交卷不可逆，需要人来决定）。
  按钮识别与确认弹窗的选择器已按 DOM 核对过，但端到端的"点交卷 → 弹窗 → 交卷成功"没有实际跑过。
- **单题模式（无整卷预览）**是退路路径，本场考试有整卷预览，所以没跑过。
- **填空/简答/论述题**未实现（考试页只支持单选/多选/判断）。

---

## 5. 涉及文件

| 文件 | 改动 |
|---|---|
| `学习通助手.user.js` | `detectRole` 加 `exam` 并把 `exam` 从 quiz 规则里摘掉；新增 `initExamPage()` / `runExamPaper()` / `runSingleQuestionExam()` / `extractExamQuestions()` / `fillExamAnswer()` / `readExamAnswer()` / `splitExamValues()` / `examValueOf()` / `isExamOptionSelected()` / `findExamButton()` / `registerExamMenu()`；新增 `SELECTORS.exam`；新增 `quiz.auto_submit_exam`；`buildPrompt` 判断题分支改为按真实选项列出并给出映射说明；`parseAnswer` 增加 `matchOptionByText()` 兜底 |
| `test/practice-parse.test.js` | 新增：判断题文案反查、显示字母/平台取值、多选取值集合比较与多字符取值拆分 |
| `README.md` | 功能表/配置表/安全边界/已知限制补充考试 |
