// 回归测试:从 .user.js 提取 makeSseParser 本体,验证 SSE 增量解析(思考/回答/usage/兜底)
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
eval(extractFn('makeSseParser'));

/** 用一组 chunk 驱动解析,返回 {thinking, answer, usage, finished} */
function run(chunks) {
  const out = { thinking: '', answer: '', usage: null, finished: false, finish: '' };
  const p = makeSseParser({
    thinking: (t) => { out.thinking += t; },
    answer: (t) => { out.answer += t; },
    usage: (u) => { out.usage = u; },
    finish: (f) => { out.finish = f; },
    done: () => { out.finished = true; },
  });
  chunks.forEach((c) => p.feed(c));
  p.end();
  return out;
}

const sse = (delta) => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';

const cases = [];

// 1) 推理模型:思考在前,回答在后(整段一次喂)
cases.push(['reasoner 整段', [
  sse({ reasoning_content: '先看题干,' }),
  sse({ reasoning_content: '戏曲舞台是虚拟的。' }),
  sse({ content: 'B' }),
  'data: [DONE]\n\n',
], { thinking: '先看题干,戏曲舞台是虚拟的。', answer: 'B', finished: true }]);

// 2) 同一份数据被任意切碎(模拟网络分包,允许切在行中间)
const whole = sse({ reasoning_content: '第一步' }) + sse({ content: 'A' })
  + sse({ reasoning_content: '第二步' }) + sse({ content: 'C' }) + 'data: [DONE]\n\n';
const pieces = [];
for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7));
cases.push(['任意切包', pieces, { thinking: '第一步第二步', answer: 'AC', finished: true }]);

// 3) 心跳/空行/CRLF 混入
cases.push(['心跳与 CRLF', [
  ': keep-alive\r\n\r\n',
  'data: \r\n\r\n',
  sse({ content: 'B' }).replace(/\n/g, '\r\n'),
  'event: ping\r\n\r\n',
  'data: [DONE]\r\n\r\n',
], { thinking: '', answer: 'B', finished: true }]);

// 4) 非 JSON 心跳行与半行 JSON 不能炸
cases.push(['坏数据耐受', [
  'data: {not json}\n\n',
  sse({ content: 'B' }),
  'data: {"choices":[{"delta":{"content":"C"\n\n',
  'data: [DONE]\n\n',
], { thinking: '', answer: 'B', finished: true }]);

// 5) delta.reasoning(部分网关用这个字段)
cases.push(['reasoning 字段别名', [
  sse({ reasoning: '想一想' }),
  sse({ content: 'A' }),
], { thinking: '想一想', answer: 'A' }]);

// 6) usage 透传
cases.push(['usage', [
  sse({ content: 'B' }),
  'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 2, total_tokens: 302 } }) + '\n\n',
  'data: [DONE]\n\n',
], { thinking: '', answer: 'B', usage: { prompt_tokens: 300, completion_tokens: 2, total_tokens: 302 } }]);

// 7) 网关把整条消息塞进 choices[0].message
cases.push(['message 兜底', [
  'data: ' + JSON.stringify({ choices: [{ message: { reasoning_content: '推理', content: '答案 B' } }] }) + '\n\n',
], { thinking: '推理', answer: '答案 B' }]);

// 8) 全角/换行/emoji 不被破坏
cases.push(['unicode 完整性', [
  sse({ content: 'Ｂ、正确\n第二行 🎬' }),
], { thinking: '', answer: 'Ｂ、正确\n第二行 🎬' }]);

// 9) 纯 JSON(网关忽略 stream):SSE 解析器不应产出任何内容,交由上层 JSON 兜底
cases.push(['非 SSE 不误判', [
  '{"choices":[{"message":{"content":"B"}}]}',
], { thinking: '', answer: '', finished: false }]);

let pass = 0, fail = 0;
for (const [name, chunks, expect] of cases) {
  const got = run(chunks);
  const keys = Object.keys(expect);
  const bad = keys.filter((k) => JSON.stringify(got[k]) !== JSON.stringify(expect[k]));
  const ok = bad.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}` + (ok ? '' : ` → ${bad.map((k) => `${k}=${JSON.stringify(got[k])} (期望 ${JSON.stringify(expect[k])})`).join('; ')}`));
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);