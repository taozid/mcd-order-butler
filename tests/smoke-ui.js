/**
 * 单文件应用冒烟测试：确认 app/index.html 在真实 DOM 里能跑起来、能渲染、能响应交互
 *   NODE_PATH=<workspace>/node_modules node tests/smoke-ui.js
 */
const fs = require('fs');
const path = require('path');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) { console.log('跳过：未安装 jsdom（npm i jsdom）'); process.exit(0); }

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const errors = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
dom.window.addEventListener('error', e => errors.push(e.message));
const origErr = dom.window.console.error;
dom.window.console.error = (...a) => { errors.push(a.join(' ')); origErr.apply(null, a); };

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '  → ' + x : '')); } };
const d = dom.window.document;

setTimeout(() => {
  console.log('\n▶ 单文件应用（app/index.html）冒烟');
  ok(errors.length === 0, '加载过程无 JS 报错', errors.join(' | '));
  ok(d.querySelectorAll('.rule').length > 0, '规则列表已渲染（' + d.querySelectorAll('.rule').length + ' 条）');
  ok(d.querySelectorAll('.ladder .lv').length === 7, '七层优先级图例完整');
  const out = d.getElementById('out').textContent;
  ok(out.indexOf('个选项') >= 0, '默认已产出推荐结果');
  ok(d.querySelectorAll('.opt').length >= 2, '渲染出多个候选选项（' + d.querySelectorAll('.opt').length + ' 个）');
  ok(d.querySelectorAll('.pick').length > 0, '选项内的餐品卡片已渲染');
  ok(d.querySelectorAll('.rej').length > 0, '被排除清单已渲染（含排除理由）');

  // 交互：切到早餐 / 儿童，重新生成
  d.getElementById('slot').value = 'breakfast';
  d.getElementById('group').value = 'child';
  d.getElementById('run').click();
  const out2 = d.getElementById('out').textContent;
  ok(out2 !== out, '切换餐次/人群后结果发生变化');
  ok(/牛奶/.test(out2), '儿童场景推荐含牛奶（必备项规则生效）');
  ok(errors.length === 0, '交互后仍无 JS 报错', errors.join(' | '));

  console.log('\n────────────────────────────────────────');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}, 400);
