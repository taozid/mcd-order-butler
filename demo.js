#!/usr/bin/env node
/**
 * 零 Token 一键演示：node demo.js
 * 不需要 MCP Token，不需要联网，不需要装任何依赖。
 * 用内置示例菜单把规则引擎跑一遍，看完就知道这套东西在做什么。
 */
const path = require('path');
const M = require(path.join(__dirname, 'engine', 'order-butler.js'));
const menu = require(path.join(__dirname, 'samples', 'menu.json')).items;

const line = '─'.repeat(64);
const scenes = [
  {
    name: '① 新用户，从没设过规则，只说「给我点一个套餐」',
    profile: { rules: [] },
    ctx: { mealSlot: 'lunch', personGroup: 'adult' }
  },
  {
    name: '② 「我在减肥，今天中午 400k」（长期控卡 + 本次临时预算）',
    profile: { rules: [
      { id: 'a', type: 'health.calorie-budget', enabled: true, params: { budget: 400 },
        scope: { mealSlots: ['lunch'], personGroups: ['*'] } },
      { id: 'b', type: 'taste.like', enabled: true, params: { keywords: ['鱼', '鸡肉', '玉米'] },
        scope: { mealSlots: ['*'], personGroups: ['*'] } },
      { id: 'c', type: 'health.sugar-cap', enabled: true, params: { maxGram: 25 },
        scope: { mealSlots: ['*'], personGroups: ['*'] } }
    ] },
    ctx: { mealSlot: 'lunch', personGroup: 'adult' }
  },
  {
    name: '③ 「带娃去麦麦，娃那份要均衡」（人群规则生效）',
    profile: { rules: [
      { id: 'd', type: 'person.group-veto', enabled: true, params: { group: 'child' },
        scope: { mealSlots: ['*'], personGroups: ['child'] } },
      { id: 'e', type: 'person.required-category', enabled: true, params: { keywords: ['牛奶'] },
        scope: { mealSlots: ['*'], personGroups: ['child'] } },
      { id: 'f', type: 'person.nutrition-bonus', enabled: true,
        params: { keywords: ['钙', '牛奶', '蛋', '玉米'], group: 'child' },
        scope: { mealSlots: ['*'], personGroups: ['child'] } }
    ] },
    ctx: { mealSlot: 'breakfast', personGroup: 'child' }
  },
  {
    name: '④ 冲突演示：明明「喜欢牛肉」，却被「不吃牛肉」一票否决',
    profile: { rules: [
      { id: 'g', type: 'diet.religious', enabled: true, params: { mode: 'no-beef' },
        scope: { mealSlots: ['*'], personGroups: ['*'] } },
      { id: 'h', type: 'taste.like', enabled: true, params: { keywords: ['牛肉'] },
        scope: { mealSlots: ['*'], personGroups: ['*'] } }
    ] },
    ctx: { mealSlot: 'lunch', personGroup: 'adult' }
  }
];

console.log('\n麦麦专属点单管家 —— 零 Token 演示（离线，无需 MCP）\n' + line);
for (const s of scenes) {
  const r = M.recommend({ profile: s.profile, menu, ctx: s.ctx, topN: 3 });
  console.log('\n' + s.name + '\n');
  if (!r.ok) { console.log('  ⚠️ ' + r.reason + '\n'); continue; }
  r.options.forEach((o, i) => {
    console.log(`  【${i + 1}】` + o.summary.split('\n')[1].replace(/^推荐：/, ''));
    console.log('      ' + o.summary.split('\n')[2]);
  });
  if (s.name.indexOf('冲突演示') >= 0 && r.rejected.length) {
    const x = r.rejected.find(v => v.suppressed && v.suppressed.length);
    if (x) console.log('\n  冲突解释：' + x.item.name + ' —— ' + x.reason +
      '\n              ⚔ 这条否决压掉了「' + x.suppressed.map(v => v.label).join('、') + '」' +
      '（分层优先级 ' + M.TIER_RANK[x.tier] + ' > ' + M.TIER_RANK[x.suppressed[0].tier] + '）');
  }
}
console.log('\n' + line);
console.log('以上全部离线运行，未调用任何麦当劳接口，未使用任何 Token。');
console.log('接上自己的 MCP Token 后，菜单/营养/券/价格换成实时数据，流程完全一致。\n');
