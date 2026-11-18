// 回归测试:从 .user.js 提取 normalizeLetters/parseAnswer 本体,验证多选答案解析
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
eval(extractFn('normalizeLetters'));
eval(extractFn('parseAnswer'));

const multi = { type: 'multi' }, single = { type: 'single' }, judge = { type: 'judge' }, blank = { type: 'blank' };
const cases = [
  // [题型, 模型输出, 期望 letters/display]
  ['multi', 'BCD', 'BCD'],
  ['multi', 'B,C,D', 'BCD'],
  ['multi', 'B、C、D', 'BCD'],
  ['multi', 'B C D', 'BCD'],
  ['multi', '经过分析,艺术系统的三个阶段是艺术创作、艺术作品和艺术鉴赏。\n答案:BCD', 'BCD'],
  ['multi', 'The answer is BCD', 'BCD'],
  ['multi', '答案：BCD。', 'BCD'],
  ['multi', 'ＢＣＤ', 'BCD'],           // 全角
  ['multi', 'b c d', 'BCD'],           // 小写
  ['multi', 'D、B、C', 'BCD'],         // 乱序->normalize 保序(不排序,保持模型输出顺序)
  ['single', 'BCD', 'B'],              // 单选只取第一个(题型误判的最后防线)
  ['single', '选 B', 'B'],
  ['judge', 'A', 'A'],
  ['blank', '李白 | 杜甫', '李白 | 杜甫'],
];

let pass = 0, fail = 0;
for (const [type, input, expect] of cases) {
  const q = { type };
  const r = parseAnswer(q, input);
  const got = q.type === 'blank' ? r.display : (r.letters || []).join('');
  const ok = got === expect && r.ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${q.type}] "${input.slice(0, 40).replace(/\n/g, '\\n')}" → "${got}" (期望 "${expect}")`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
