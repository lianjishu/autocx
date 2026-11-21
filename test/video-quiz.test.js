// 回归测试:视频弹题的选项文字拆分 + 判断题文案反查
// 从 .user.js 提取纯函数本体,直接 eval 后断言
const fs = require('fs');
const src = fs.readFileSync('E:/Projects/projects/scriptcat-workspace/autocx/学习通助手.user.js', 'utf8');

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
eval(extractFn('splitVideoQuizOption'));
eval(extractFn('matchOptionByText'));

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); ok ? pass++ : fail++; };

// ---- 视频弹题选项文字:实测形如 "A、对" / "B、错" / "A、“8”字包扎法" ----
const optCases = [
  ['A、对', 0, 'A', '对'],
  ['B、错', 1, 'B', '错'],
  ['A、“8”字包扎法', 0, 'A', '“8”字包扎法'],
  ['C、回返型包扎法', 2, 'C', '回返型包扎法'],
  ['D. 螺旋形包扎法', 3, 'D', '螺旋形包扎法'],
  ['B. 螺旋形', 1, 'B', '螺旋形'],
  ['  A  螺旋形  ', 0, 'A', '螺旋形'],
  ['没有字母前缀的选项', 2, 'C', '没有字母前缀的选项'],
];
for (const [raw, idx, expLabel, expText] of optCases) {
  const r = splitVideoQuizOption(raw, idx);
  check(r.label === expLabel && r.text === expText,
    `splitVideoQuizOption(${JSON.stringify(raw)}, ${idx}) → ${r.label}/${JSON.stringify(r.text)} (期望 ${expLabel}/${JSON.stringify(expText)})`);
}

// ---- 判断题:模型直接答"对/错/正确/错误"时按语义反查字母 ----
const judgeOpts = [{ label: 'A', text: '对' }, { label: 'B', text: '错' }];
const judgeCases = [['对', 'A'], ['错', 'B'], ['正确', 'A'], ['错误', 'B'], ['不对', 'B'], ['完全无关', '']];
for (const [raw, exp] of judgeCases) {
  const got = matchOptionByText(judgeOpts, raw);
  check(got === exp, `matchOptionByText(${JSON.stringify(raw)}) → ${JSON.stringify(got)} (期望 ${JSON.stringify(exp)})`);
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
