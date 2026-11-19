// 回归测试:从 .user.js 提取随堂练习页的纯函数,验证 HTML 转文本与多选格式解析
const fs = require('fs');
const src = fs.readFileSync('E:/Projects/projects/scriptcat-workspace/autocx/学习通助手.user.js', 'utf8');

// 提取函数定义(简单定位:从声明到下一个同级声明)
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
eval(extractFn('htmlToText'));
eval(extractFn('parseMultiSet'));

// ---- htmlToText:随堂练习页的题干/选项是明文 HTML,只带一层 <p>/<span> 包裹 ----
const htmlCases = [
  ['<p>已知某关系表为 选课成绩表(学号, 课名)</p>', '已知某关系表为 选课成绩表(学号, 课名)'],
  ['<span class="html-content-box"><p>因为该表主键为复合主键</p></span>', '因为该表主键为复合主键'],
  ['<p>a</p><p>b</p>', 'a b'],
  ['<p>题目&nbsp;内容</p>', '题目 内容'],
  ['<p>5 &lt; 10 &amp;&amp; 10 &gt; 5</p>', '5 < 10 && 10 > 5'],
  ['', ''],
  [null, ''],
  ['   ', ''],
];
let pass = 0, fail = 0;
for (const [input, expect] of htmlCases) {
  const got = htmlToText(input);
  const ok = got === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'} htmlToText(${JSON.stringify(input)}) → ${JSON.stringify(got)} (期望 ${JSON.stringify(expect)})`);
  ok ? pass++ : fail++;
}

// ---- parseMultiSet:平台多选有两种存储格式,都要能解析回字母集合 ----
const multiCases = [
  ['AB', ['A', 'B']],
  ['B', ['B']],
  ['', []],
  [null, []],
  ['A,B', ['A', 'B']],
  ['AC', ['A', 'C']],
];
for (const [input, expect] of multiCases) {
  const got = Array.from(parseMultiSet(input)).sort();
  const want = expect.slice().sort();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} parseMultiSet(${JSON.stringify(input)}) → ${JSON.stringify(got)} (期望 ${JSON.stringify(want)})`);
  ok ? pass++ : fail++;
}

// ---- 平台选项取值映射:判断题的选项名是 "1"/"2",不是 A/B ----
// 提取时把展示字母改成 A/B,填的时候要映射回平台真实取值,否则点错项/校验误判。
// 这里验证映射函数本身:展示字母 -> 平台取值 -> 回读比较用的规范化集合。
function platformValuesOf(optLabels, optValues, letters) {
  return letters.map((L) => {
    const i = optLabels.indexOf(L);
    if (i < 0) return L;
    return optValues[i] || L;
  }).sort();
}
const judgeCases = [
  // 判断题:展示 A/B,平台真实取值 "1"/"2"
  { labels: ['A', 'B'], values: ['1', '2'], pick: ['A'], expect: ['1'] },
  { labels: ['A', 'B'], values: ['1', '2'], pick: ['B'], expect: ['2'] },
  // 普通单选/多选:展示与平台取值一致
  { labels: ['A', 'B', 'C'], values: ['A', 'B', 'C'], pick: ['B'], expect: ['B'] },
  { labels: ['A', 'B', 'C'], values: ['A', 'B', 'C'], pick: ['A', 'C'], expect: ['A', 'C'] },
  // 模型给了不存在的字母:原样返回(后面会因填不上而失败)
  { labels: ['A', 'B'], values: ['1', '2'], pick: ['Z'], expect: ['Z'] },
];
for (const c of judgeCases) {
  const got = platformValuesOf(c.labels, c.values, c.pick);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  console.log(`${ok ? 'PASS' : 'FAIL'} 平台取值映射 ${JSON.stringify(c.pick)} → ${JSON.stringify(got)} (期望 ${JSON.stringify(c.expect)})`);
  ok ? pass++ : fail++;
}

// ---- parseMultiSet:判断题的 myoption 可能是 "1"/"2" 这种非字母取值 ----
const valueCases = [
  ['1', ['1']],
  ['1,2', ['1', '2']],
  ['AB', ['A', 'B']],
];
for (const [input, expect] of valueCases) {
  const got = Array.from(parseMultiSet(input)).sort();
  const ok = JSON.stringify(got) === JSON.stringify(expect.slice().sort());
  console.log(`${ok ? 'PASS' : 'FAIL'} parseMultiSet(${JSON.stringify(input)}) → ${JSON.stringify(got)} (期望 ${JSON.stringify(expect)})`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);