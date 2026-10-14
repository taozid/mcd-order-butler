#!/usr/bin/env node
/**
 * 命令行入口：不改引擎、不依赖 UI，直接对一份菜单跑规则
 *   node engine/cli.js --profile config/profile.example.json --menu samples/menu.json --slot lunch --group adult
 * 加 --json 输出结构化结果，便于被 Agent / 脚本消费
 */
const fs = require('fs');
const path = require('path');
const M = require(path.join(__dirname, 'order-butler.js'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = n => process.argv.indexOf('--' + n) >= 0;

const read = p => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), p), 'utf8'));
const profileFile = arg('profile', path.join(__dirname, '..', 'config', 'profile.example.json'));
const menuFile = arg('menu', path.join(__dirname, '..', 'samples', 'menu.json'));
const menu = read(menuFile).items || read(menuFile);
const profile = read(profileFile);

const coupons = (arg('coupons', '') || '').split(',').filter(Boolean).map(s => {
  const [value, minSpend] = s.split(':').map(Number);
  return { value: value || 0, minSpend: minSpend || 0 };
});

const result = M.recommend({
  profile, menu, topN: Number(arg('top', 3)) || 3,
  ctx: { mealSlot: arg('slot', 'lunch'), personGroup: arg('group', 'adult'), coupons }
});

if (has('json')) { console.log(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 2); }

if (!result.ok) {
  console.log('⚠️  ' + result.reason);
  process.exit(2);
}

console.log('\n符合你规则的 ' + result.options.length + ' 个选项：\n');
result.options.forEach((o, i) => {
  console.log(`【${i + 1}】` + o.summary.split('\n').slice(1).join('　'));
  for (const p of o.picks) {
    const reasons = p.trace.length ? p.trace.map(t => `${t.label}（${t.reason}）`).join('；') : '无规则命中，按标准份量与价格推荐';
    const opt = Object.keys(p.options).length ? '　定制：' + Object.keys(p.options).join('、') : '';
    console.log(`      · ${p.item.name}${opt} —— ${reasons}`);
  }
  console.log('');
});
if (result.bundleTrace && result.bundleTrace.length) {
  console.log('整餐约束核对：');
  for (const t of result.bundleTrace) console.log(`  · [${t.effect === 'pass' ? '通过' : t.effect}] ${t.label} —— ${t.reason}`);
}
if (result.rejected.length) {
  console.log('\n被排除了（前 8 条）：');
  for (const x of result.rejected.slice(0, 8)) {
    const sup = x.suppressed && x.suppressed.length ? `　⚔ 压制了「${x.suppressed.map(s => s.label).join('、')}」` : '';
    console.log(`  · ${x.item.name} —— ${x.reason}${sup}`);
  }
}
console.log('');
