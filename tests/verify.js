/**
 * 引擎自测：node tests/verify.js
 * 验证四件事：硬约束守得住、人群/餐次作用域生效、冲突可解释、规则类型可扩展（不改引擎）
 */
const path = require('path');
const M = require(path.join(__dirname, '..', 'engine', 'order-butler.js'));
const menu = require(path.join(__dirname, '..', 'samples', 'menu.json')).items;
const profile = require(path.join(__dirname, '..', 'config', 'profile.example.json'));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')); }
};
const head = t => console.log('\n▶ ' + t);

/* ---------------- A. 午餐 · 成人 · 减脂 ---------------- */
head('A. 午餐 / 成人 —— 硬约束是否守得住');
{
  const r = M.recommend({ profile, menu, ctx: { mealSlot: 'lunch', personGroup: 'adult' } });
  ok(r.ok, '能给出推荐组合', r.reason);
  ok(r.picks.length > 0, '有选中餐品');
  ok(r.metrics.calories <= 600, `整餐热量 ${Math.round(r.metrics.calories)} ≤ 预算 600`);
  ok(r.metrics.sodium <= 1500, `整餐钠 ${Math.round(r.metrics.sodium)} ≤ 1500mg`);
  ok(r.metrics.sugar <= 25, `整餐糖 ${Math.round(r.metrics.sugar)} ≤ 25g`);
  ok(r.metrics.price <= 45, `整餐 ¥${r.metrics.price} ≤ 预算 ¥45`);
  ok(r.picks.every(p => p.item.category !== '甜品'), '甜品已被「不要某品类」剔除');
  ok(r.picks.every(p => p.item.spiceLevel <= 1), '辣度未超过上限 1');
  ok(r.picks.every(p => !/洋葱|香菜/.test((p.item.ingredients || []).join(''))), '禁用食材（洋葱/香菜）未出现');
  const burger = r.picks.find(p => p.item.name.indexOf('堡') >= 0);
  ok(!burger || burger.options['去酱'] === true, '堡类自动带上「去酱」定制项');
  console.log('    推荐：' + r.picks.map(p => p.item.name).join(' + '));
}

/* ---------------- B. 早餐 · 儿童 ---------------- */
head('B. 早餐 / 儿童 —— 人群与餐次作用域是否生效');
{
  const r = M.recommend({ profile, menu, ctx: { mealSlot: 'breakfast', personGroup: 'child' } });
  ok(r.ok, '能给出推荐组合', r.reason);
  const names = r.picks.map(p => p.item.name).join(' ');
  ok(/牛奶/.test(names), '儿童的「必备项：牛奶」被满足 → ' + names);
  ok(!/咖啡/.test(names), '儿童禁忌生效：无咖啡');
  ok(!/可乐/.test(names), '儿童禁忌生效：无可乐');
  ok(r.picks.every(p => p.item.slots.includes('breakfast')), '只出现早餐时段可售餐品');
  console.log('    推荐：' + names);
}

/* ---------------- C. 冲突可解释性 ---------------- */
head('C. 健康目标 vs 口味偏好 —— 冲突是否被显式记录');
{
  const p = {
    rules: [
      { id: 'v-beef', type: 'diet.avoid-ingredient', enabled: true, params: { keywords: ['牛肉'] } },
      { id: 'l-beef', type: 'taste.like', enabled: true, params: { keywords: ['牛肉'] } }
    ]
  };
  const r = M.recommend({ profile: p, menu, ctx: { mealSlot: 'lunch', personGroup: 'adult' } });
  const bigMac = r.rejected.find(x => x.item.code === 'M002');
  ok(!!bigMac, '巨无霸被排除');
  ok(bigMac && bigMac.tier === 'safety', '否决来自 safety 层');
  ok(bigMac && bigMac.suppressed.length > 0, '被压制的低层偏好被记录（可解释）');
  ok(bigMac && bigMac.suppressed.some(s => s.typeId === 'taste.like'),
    '明确指出「喜欢牛肉」这条偏好被安全规则压掉',
    bigMac ? JSON.stringify(bigMac.suppressed) : '');
  if (bigMac) console.log('    排除理由：' + bigMac.reason + '（压制了：' + bigMac.suppressed.map(s => s.label).join('、') + '）');
}

/* ---------------- D. 可扩展性 ---------------- */
head('D. 新增规则类型 —— 是否需要改引擎');
{
  const before = M.RULE_TYPES.length;
  M.registerRuleType({
    typeId: 'ext.no-fried', label: '自定义 · 拒绝油炸', tier: 'health',
    kind: 'item', effect: 'veto', icon: '新',
    hint: '演示：运行时新增一种规则类型，引擎本体一行未改。',
    when: { field: 'searchText', op: 'containsAny', valueKey: 'keywords' },
    reason: '自定义规则拒绝「{hit}」',
    paramsSchema: [{ key: 'keywords', label: '关键词', type: 'tags' }]
  });
  ok(M.RULE_TYPES.length === before + 1, '规则类型表 +1（引擎源码未改动）');

  const p = { rules: [{ id: 'x1', type: 'ext.no-fried', enabled: true, params: { keywords: ['炸物'] } }] };
  const r = M.recommend({ profile: p, menu, ctx: { mealSlot: 'lunch', personGroup: 'adult' } });
  ok(r.ok && r.picks.every(p => !(p.item.tags || []).includes('炸物')), '新规则类型立即生效：组合中无油炸品');
  console.log('    推荐：' + r.picks.map(p => p.item.name).join(' + '));
}

/* ---------------- E. 约束不可满足时的降级 ---------------- */
head('E. 约束互相打架 —— 是否给出可诊断的失败原因');
{
  const p = { rules: [
    { id: 'cal', type: 'health.calorie-budget', enabled: true, params: { budget: 200 } },
    { id: 'pro', type: 'health.protein-target', enabled: true, params: { minGram: 40 } }
  ] };
  const r = M.recommend({ profile: p, menu, ctx: { mealSlot: 'lunch', personGroup: 'adult' } });
  ok(!r.ok, '无解时明确返回失败，而不是硬塞一个违规组合');
  ok(typeof r.reason === 'string' && r.reason.length > 0, '给出卡在哪条规则上 → ' + r.reason);
}

/* ---------------- F. 给选项而不是唯一答案 ---------------- */
head('F. 多选项输出 —— 主食是否互不重复');
{
  const r = M.recommend({ profile, menu, topN: 3, ctx: { mealSlot: 'lunch', personGroup: 'adult' } });
  ok(r.ok && r.options.length >= 2, '返回多个候选（' + (r.options ? r.options.length : 0) + ' 个）');
  const mains = r.options.map(o => {
    const p = o.picks.find(x => ['主食', '早餐'].includes(x.item.category));
    return p ? p.item.code : null;
  });
  ok(new Set(mains).size === mains.length, '各选项的主食互不重复 → ' + mains.join(' / '));
  ok(r.options.every(o => o.metrics.calories <= 600), '每个选项都守住热量预算');
  ok(r.picks === r.options[0].picks, 'picks 仍指向最优项，兼容旧调用方');
  r.options.forEach((o, i) => console.log(`    【${i + 1}】` + o.summary.split('\n')[1] + '　得分 ' + o.score));
}

console.log('\n' + '─'.repeat(52));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
