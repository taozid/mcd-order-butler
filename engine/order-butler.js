/* ==== ORDER-BUTLER:BEGIN ==== */
/**
 * 麦麦专属点单管家 · 规则引擎
 *
 * 设计契约（新增规则类型时不需要修改本文件）：
 *   1. 引擎只理解三种 kind：item（对单品裁决）/ bundle（对整餐裁决）/ config（生成订单配置项）
 *   2. 规则类型是一份"数据描述符"，声明 tier、when（怎么判定）、effect（裁决什么）
 *   3. 冲突仲裁由 tier 决定，高 tier 覆盖低 tier，冲突被显式记录进 trace
 *
 * UMD：浏览器挂到 window.McdButler，Node 走 module.exports
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.McdButler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. 分层优先级（tier ladder）
   *    rank 越大越优先。同 tier 内按 rule.order（用户可覆盖）降序。
   * ------------------------------------------------------------------ */
  const TIERS = [
    { id: 'safety',     rank: 100, label: '安全 · 禁忌',   desc: '过敏、宗教戒律、硬禁忌 —— 一票否决，不可被低层规则推翻' },
    { id: 'health',     rank: 80,  label: '健康目标',       desc: '热量预算、控盐控糖、增肌高蛋白 —— 强约束' },
    { id: 'person',     rank: 60,  label: '人群差异',       desc: '儿童 / 老人 / 成人 / 孕期 —— 人群专属约束与营养加权' },
    { id: 'meal-slot',  rank: 45,  label: '餐次菜单',       desc: '早餐 / 午餐 / 晚餐 / 夜宵各自的可售品类与份量逻辑' },
    { id: 'preference', rank: 30,  label: '口味偏好',       desc: '喜欢 / 不喜欢 / 收藏 / 换口味 —— 只影响排序，不否决' },
    { id: 'custom',     rank: 15,  label: '定制指令',       desc: '去酱去冰、不要小食、取餐方式 —— 改配置项，不改选品结果' },
    { id: 'value',      rank: 5,   label: '优惠 · 性价比',  desc: '预算上限、优先用券、性价比 —— 最后一道加权' }
  ];

  const TIER_RANK = TIERS.reduce((m, t) => (m[t.id] = t.rank, m), {});

  /* ------------------------------------------------------------------ *
   * 2. 规则类型目录（纯数据 —— 新增类型 = 往这里加一条，引擎不改）
   * ------------------------------------------------------------------ */
  const RULE_TYPES = [
    /* ---------------- safety ---------------- */
    {
      typeId: 'diet.avoid-ingredient', label: '饮食禁忌 · 禁用食材/品类', tier: 'safety',
      kind: 'item', effect: 'veto', icon: '禁',
      hint: '命中关键词的单品直接排除，优先级最高，任何"喜欢"都救不回来。',
      when: { field: 'searchText', op: 'containsAny', valueKey: 'keywords' },
      reason: '含禁用项「{hit}」',
      paramsSchema: [
        { key: 'keywords', label: '禁用关键词', type: 'tags', placeholder: '牛肉 / 香菜 / 花生 …' }
      ]
    },
    {
      typeId: 'diet.allergen', label: '过敏原', tier: 'safety',
      kind: 'item', effect: 'veto', icon: '敏',
      hint: '比普通禁忌更严格：同时匹配过敏原字段与配料表。',
      when: { field: 'allergenText', op: 'containsAny', valueKey: 'allergens' },
      reason: '含过敏原「{hit}」',
      paramsSchema: [
        { key: 'allergens', label: '过敏原', type: 'tags', placeholder: '花生 / 芒果 / 小麦 …' }
      ]
    },
    {
      typeId: 'diet.spice-cap', label: '辣度上限', tier: 'safety',
      kind: 'item', effect: 'veto', icon: '辣',
      hint: '0=不辣 1=微辣 2=中辣 3=特辣。超过设定值的单品排除。',
      when: { metric: 'spiceLevel', op: 'gt', valueKey: 'maxLevel' },
      reason: '辣度 {itemValue} 超过上限 {target}',
      paramsSchema: [
        { key: 'maxLevel', label: '最高辣度', type: 'select', default: 1,
          options: [{ value: 0, label: '不辣' }, { value: 1, label: '微辣' }, { value: 2, label: '中辣' }, { value: 3, label: '特辣' }] }
      ]
    },
    {
      typeId: 'diet.religious', label: '宗教 / 戒律', tier: 'safety',
      kind: 'item', effect: 'veto', icon: '戒',
      hint: '内置清真、素食、无猪、无牛四套关键词，选择即生效。',
      when: { field: 'searchText', op: 'containsAny', valueKey: 'mode' },
      presets: {
        halal:      ['猪肉', '猪', '火腿', '培根', '香肠', '猪油', '酒精', '酒'],
        vegetarian: ['牛肉', '猪肉', '鸡肉', '鸡', '鱼', '虾', '海鲜', '肉'],
        'no-pork':    ['猪肉', '猪', '火腿', '培根', '猪油'],
        'no-beef':    ['牛肉', '牛']
      },
      reason: '{modeLabel}忌「{hit}」',
      paramsSchema: [
        { key: 'mode', label: '戒律', type: 'select', default: 'halal',
          options: [{ value: 'halal', label: '清真' }, { value: 'vegetarian', label: '素食' }, { value: 'no-pork', label: '不吃猪肉' }, { value: 'no-beef', label: '不吃牛肉' }] }
      ]
    },
    {
      typeId: 'diet.sodium-item-cap', label: '单品钠上限', tier: 'safety',
      kind: 'item', effect: 'veto', icon: '钠',
      hint: '单个餐品的钠含量硬上限（mg）。整餐控钠请用「健康目标 · 控盐」。',
      when: { metric: 'sodium', op: 'gt', valueKey: 'maxMg' },
      reason: '单品钠 {itemValue}mg 超过 {target}mg',
      paramsSchema: [{ key: 'maxMg', label: '上限 (mg)', type: 'number', default: 800, unit: 'mg' }]
    },

    /* ---------------- health ---------------- */
    {
      typeId: 'health.calorie-budget', label: '健康目标 · 热量预算', tier: 'health',
      kind: 'bundle', effect: 'veto', icon: '卡',
      hint: '整餐总热量上限。超预算的组合会被整体否决，引擎自动换更低卡的搭配。',
      when: { metric: 'calories', op: 'gt', valueKey: 'budget' },
      reason: '整餐 {itemValue}kcal 超出预算 {target}kcal',
      paramsSchema: [{ key: 'budget', label: '每餐热量预算', type: 'number', default: 600, unit: 'kcal' }]
    },
    {
      typeId: 'health.protein-target', label: '健康目标 · 增肌高蛋白', tier: 'health',
      kind: 'bundle', effect: 'veto', icon: '蛋',
      hint: '整餐蛋白质下限（g），达不到则换搭配，用于增肌人群。',
      when: { metric: 'protein', op: 'lt', valueKey: 'minGram' },
      reason: '整餐蛋白 {itemValue}g 未达 {target}g',
      paramsSchema: [{ key: 'minGram', label: '最低蛋白', type: 'number', default: 30, unit: 'g' }]
    },
    {
      typeId: 'health.sodium-cap', label: '健康目标 · 控盐', tier: 'health',
      kind: 'bundle', effect: 'veto', icon: '盐',
      hint: '整餐钠总量上限（mg）。',
      when: { metric: 'sodium', op: 'gt', valueKey: 'maxMg' },
      reason: '整餐钠 {itemValue}mg 超出 {target}mg',
      paramsSchema: [{ key: 'maxMg', label: '整餐钠上限', type: 'number', default: 1500, unit: 'mg' }]
    },
    {
      typeId: 'health.sugar-cap', label: '健康目标 · 控糖', tier: 'health',
      kind: 'bundle', effect: 'veto', icon: '糖',
      hint: '整餐糖分上限（g）。含糖饮料是最常见的超标来源。',
      when: { metric: 'sugar', op: 'gt', valueKey: 'maxGram' },
      reason: '整餐糖 {itemValue}g 超出 {target}g',
      paramsSchema: [{ key: 'maxGram', label: '整餐糖上限', type: 'number', default: 30, unit: 'g' }]
    },
    {
      typeId: 'health.fat-cap', label: '健康目标 · 控脂', tier: 'health',
      kind: 'bundle', effect: 'veto', icon: '脂',
      hint: '整餐脂肪上限（g）。',
      when: { metric: 'fat', op: 'gt', valueKey: 'maxGram' },
      reason: '整餐脂肪 {itemValue}g 超出 {target}g',
      paramsSchema: [{ key: 'maxGram', label: '整餐脂肪上限', type: 'number', default: 35, unit: 'g' }]
    },

    /* ---------------- person ---------------- */
    {
      typeId: 'person.group-veto', label: '人群差异 · 人群禁忌', tier: 'person',
      kind: 'item', effect: 'veto', icon: '群',
      hint: '按人群套用内置禁忌清单：儿童避开酒精/咖啡因/整骨/刺激性；老人避开硬/冰/高钠。',
      when: { field: 'searchText', op: 'containsAny', valueKey: 'group' },
      presets: {
        child:  ['酒精', '酒', '咖啡', '咖啡因', '可乐', '整骨', '骨', '特辣', '超辣', '芥末'],
        elder:  ['冰', '冰块', '整骨', '骨', '硬', '坚果', '特辣', '酒'],
        adult:  [],
        pregnant: ['酒精', '酒', '咖啡因', '生', '半熟', '溏心']
      },
      reason: '{groupLabel}不宜「{hit}」',
      paramsSchema: [
        { key: 'group', label: '人群', type: 'select', default: 'child',
          options: [{ value: 'child', label: '儿童' }, { value: 'elder', label: '老人' }, { value: 'adult', label: '成人' }, { value: 'pregnant', label: '孕期' }] }
      ]
    },
    {
      typeId: 'person.nutrition-bonus', label: '人群差异 · 营养加权', tier: 'person',
      kind: 'item', effect: 'bonus', weight: 14, icon: '养',
      hint: '命中关键词的单品加分。儿童可填「钙、牛奶、蛋白、鸡蛋」；老人可填「软、粥、汤、蒸」。',
      when: { field: 'searchText', op: 'containsAny', valueKey: 'keywords' },
      reason: '{groupLabel}营养加分：命中「{hit}」',
      paramsSchema: [
        { key: 'keywords', label: '加分关键词', type: 'tags', placeholder: '钙 / 牛奶 / 蛋白 …' },
        { key: 'group', label: '适用人群', type: 'select', default: 'child',
          options: [{ value: 'child', label: '儿童' }, { value: 'elder', label: '老人' }, { value: 'adult', label: '成人' }, { value: 'pregnant', label: '孕期' }] }
      ]
    },
    {
      typeId: 'person.required-category', label: '人群差异 · 必备项', tier: 'person',
      kind: 'bundle', effect: 'require', icon: '必',
      hint: '整餐必须含指定关键词（匹配名称 / 标签 / 品类），否则换搭配。儿童常填「牛奶 + 蔬果」保证均衡。',
      when: { requireKeywords: true, valueKey: 'keywords' },
      reason: '缺必需项「{missing}」',
      paramsSchema: [
        { key: 'keywords', label: '必备关键词', type: 'tags', placeholder: '牛奶 / 蔬果 / 玉米 …' }
      ]
    },

    /* ---------------- meal-slot ---------------- */
    {
      typeId: 'slot.allowed-categories', label: '餐次菜单 · 可售品类', tier: 'meal-slot',
      kind: 'item', effect: 'veto', icon: '餐',
      hint: '不在允许清单内的品类排除。例如早餐只允许「早餐/饮料/小食」。',
      when: { field: 'category', op: 'notIn', valueKey: 'allow' },
      reason: '{mealSlotLabel}不售「{itemValue}」',
      paramsSchema: [
        { key: 'allow', label: '允许品类', type: 'tags', placeholder: '早餐 / 饮料 / 小食 …' }
      ]
    },
    {
      typeId: 'slot.portion-range', label: '餐次菜单 · 份量区间', tier: 'meal-slot',
      kind: 'item', effect: 'bonus', weight: 8, icon: '量',
      hint: '单品热量落在区间内加分。早餐轻食、午餐饱腹、晚餐控卡各设一套。',
      when: { metric: 'calories', op: 'between', valueKey: 'min', valueKey2: 'max' },
      reason: '符合{mealSlotLabel}份量（{itemValue}kcal）',
      paramsSchema: [
        { key: 'min', label: '下限 kcal', type: 'number', default: 0 },
        { key: 'max', label: '上限 kcal', type: 'number', default: 500 }
      ]
    },
    {
      typeId: 'slot.skip-category', label: '餐次菜单 · 跳过品类', tier: 'meal-slot',
      kind: 'item', effect: 'veto', icon: '跳',
      hint: '该餐次直接跳过的品类。例如晚餐不要甜品、早餐不要炸物。',
      when: { field: 'category', op: 'in', valueKey: 'skip' },
      reason: '{mealSlotLabel}跳过「{itemValue}」',
      paramsSchema: [{ key: 'skip', label: '跳过品类', type: 'tags', placeholder: '甜品 / 炸物 …' }]
    },

    /* ---------------- preference ---------------- */
    {
      typeId: 'taste.like', label: '口味偏好 · 喜欢', tier: 'preference',
      kind: 'item', effect: 'bonus', weight: 12, icon: '喜',
      hint: '命中关键词加分。可以填品类（堡/鱼类），也可以填具体单品名。',
      when: { field: 'searchText', op: 'containsAny', valueKey: 'keywords' },
      reason: '偏好加分：命中「{hit}」',
      paramsSchema: [{ key: 'keywords', label: '喜欢', type: 'tags', placeholder: '麦香鱼 / 玉米 / 咖啡 …' }]
    },
    {
      typeId: 'taste.dislike', label: '口味偏好 · 不喜欢', tier: 'preference',
      kind: 'item', effect: 'penalty', weight: 12, icon: '厌',
      hint: '减分但不排除。若想彻底不出现，请用「饮食禁忌」。',
      when: { field: 'searchText', op: 'containsAny', valueKey: 'keywords' },
      reason: '偏好减分：命中「{hit}」',
      paramsSchema: [{ key: 'keywords', label: '不喜欢', type: 'tags', placeholder: '洋葱 / 酸黄瓜 …' }]
    },
    {
      typeId: 'taste.favorite-combo', label: '口味偏好 · 收藏套餐', tier: 'preference',
      kind: 'item', effect: 'bonus', weight: 25, icon: '藏',
      hint: '常点单品大幅加分，实现"一键复购上次那套"。',
      when: { field: 'code', op: 'in', valueKey: 'codes' },
      reason: '收藏单品，优先复购',
      paramsSchema: [{ key: 'codes', label: '餐品编码', type: 'tags', placeholder: 'M001 / M012 …' }]
    },
    {
      typeId: 'taste.variety', label: '口味偏好 · 换换口味', tier: 'preference',
      kind: 'item', effect: 'penalty', weight: 18, icon: '换',
      hint: '近期点过的单品降权，避免连吃同一款。需要接入历史订单编码。',
      when: { field: 'code', op: 'in', valueKey: 'codes' },
      reason: '近期已点过，换换口味',
      paramsSchema: [{ key: 'codes', label: '近期已点编码', type: 'tags', placeholder: 'M001 / M003 …' }]
    },

    /* ---------------- custom ---------------- */
    {
      typeId: 'custom.item-option', label: '定制指令 · 单品定制', tier: 'custom',
      kind: 'config', effect: 'config', icon: '制',
      hint: '对某类单品自动施加定制项，如"所有堡去酱""所有饮料去冰"。',
      when: { field: 'searchText', op: 'containsAny', valueKey: 'keywords' },
      configTarget: 'itemOptions',
      reason: '命中「{hit}」→ {optionLabel}',
      paramsSchema: [
        { key: 'keywords', label: '作用于', type: 'tags', placeholder: '堡 / 饮料 / 咖啡 …' },
        { key: 'optionKey', label: '定制项', type: 'text', default: '去酱', placeholder: '去酱 / 去冰 / 不要吸管' },
        { key: 'optionValue', label: '取值', type: 'text', default: 'true' }
      ]
    },
    {
      typeId: 'custom.order-option', label: '定制指令 · 订单级偏好', tier: 'custom',
      kind: 'config', effect: 'config', icon: '单',
      hint: '取餐方式、是否需要餐具、固定备注等，随每单自动带上。',
      configTarget: 'orderOptions',
      reason: '订单固定设置：{optionLabel}',
      paramsSchema: [
        { key: 'optionKey', label: '配置项', type: 'select', default: 'diningType',
          options: [
            { value: 'diningType', label: '取餐方式' },
            { value: 'needTableware', label: '需要餐具' },
            { value: 'remark', label: '订单备注' }
          ] },
        { key: 'optionValue', label: '取值', type: 'text', default: '堂食', placeholder: '堂食 / 外带 / 麦乐送，或 true/false，或备注内容' }
      ]
    },
    {
      typeId: 'custom.no-category', label: '定制指令 · 不要某品类', tier: 'custom',
      kind: 'config', effect: 'config', icon: '略',
      hint: '整餐跳过该品类，如"不要小食""不要甜品"。比口味减分更干脆。',
      configTarget: 'excludeCategories',
      reason: '整餐不要「{value}」',
      paramsSchema: [{ key: 'categories', label: '不要的品类', type: 'tags', placeholder: '小食 / 甜品 …' }]
    },

    /* ---------------- value ---------------- */
    {
      typeId: 'value.price-cap', label: '优惠 · 单次预算', tier: 'value',
      kind: 'bundle', effect: 'veto', icon: '¥',
      hint: '整餐总价上限（元）。',
      when: { metric: 'price', op: 'gt', valueKey: 'maxYuan' },
      reason: '整餐 ¥{itemValue} 超出预算 ¥{target}',
      paramsSchema: [{ key: 'maxYuan', label: '预算上限', type: 'number', default: 40, unit: '元' }]
    },
    {
      typeId: 'value.coupon-first', label: '优惠 · 优先用券', tier: 'value',
      kind: 'bundle', effect: 'bonus', weight: 10, icon: '券',
      hint: '能用券的组合加分，券的面额越大加分越多。',
      when: { metric: 'couponValue', op: 'gt', valueKey: 'minValue' },
      reason: '可用券省 ¥{itemValue}',
      paramsSchema: [{ key: 'minValue', label: '券面额门槛', type: 'number', default: 0, unit: '元' }]
    },
    {
      typeId: 'value.value-for-money', label: '优惠 · 性价比', tier: 'value',
      kind: 'item', effect: 'bonus', weight: 6, icon: '值',
      hint: '按"每元热量"或"每元蛋白"加分，吃得划算。',
      when: { metric: 'valueDensity', op: 'gt', valueKey: 'minDensity' },
      reason: '性价比高（{itemValue} {unit}/元）',
      paramsSchema: [
        { key: 'basis', label: '衡量口径', type: 'select', default: 'protein',
          options: [{ value: 'protein', label: '每元蛋白质' }, { value: 'calories', label: '每元热量' }] },
        { key: 'minDensity', label: '达标线', type: 'number', default: 1.2 }
      ]
    }
  ];

  const RULE_TYPE_MAP = RULE_TYPES.reduce((m, t) => (m[t.typeId] = t, m), {});

  /* ------------------------------------------------------------------ *
   * 3. 工具
   * ------------------------------------------------------------------ */
  const MEAL_SLOT_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', latenight: '夜宵' };
  const GROUP_LABEL = { child: '儿童', elder: '老人', adult: '成人', pregnant: '孕期' };
  // 品类 → 组合角色。可被 ctx.roles 覆盖，因此新增"汤品""儿童餐"等品类无需改引擎
  const DEFAULT_ROLES = { primary: ['主食', '早餐'], side: ['小食'], drink: ['饮料'], dessert: ['甜品'] };
  const UNIT_BY_METRIC = { calories: 'kcal', protein: 'g', sodium: 'mg', sugar: 'g', fat: 'g', price: '元', couponValue: '元' };
  // 各角色的"标准份"参考热量。没有任何规则命中时用它排序，避免默认堆成最大份
  const REF_CALORIES = { primary: 450, side: 250, drink: 120, dessert: 200 };
  function refCalories(item, roles) {
    for (const k in roles) if (roles[k].indexOf(item.category) >= 0) return REF_CALORIES[k] || 300;
    return 300;
  }

  function normalizeItem(raw) {
    const tags = raw.tags || [];
    const ingredients = raw.ingredients || [];
    const allergens = raw.allergens || [];
    return Object.assign({}, raw, {
      calories: num(raw.calories), protein: num(raw.protein), sodium: num(raw.sodium),
      sugar: num(raw.sugar), fat: num(raw.fat), price: num(raw.price),
      spiceLevel: num(raw.spiceLevel),
      valueDensity: raw.price > 0 ? num(raw.protein) / raw.price : 0,
      searchText: [raw.name, raw.category, tags.join(' '), ingredients.join(' ')].join(' ').toLowerCase(),
      allergenText: [allergens.join(' '), ingredients.join(' ')].join(' ').toLowerCase()
    });
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  /** 规则的作用域是否覆盖当前上下文 */
  function inScope(rule, ctx) {
    const s = rule.scope || {};
    const hit = (arr, v) => !arr || !arr.length || arr.indexOf('*') >= 0 || arr.indexOf(v) >= 0;
    return hit(s.mealSlots, ctx.mealSlot) && hit(s.personGroups, ctx.personGroup);
  }

  /** 取出 when 要比较的实际值数组 */
  function resolveValues(type, when, params) {
    const key = when.valueKey;
    if (type.presets && params[key] && type.presets[params[key]]) return type.presets[params[key]];
    const v = params[key];
    return Array.isArray(v) ? v : (v == null ? [] : [v]);
  }

  function itemFieldValue(item, field) {
    if (field === 'searchText') return item.searchText;
    if (field === 'allergenText') return item.allergenText;
    if (field === 'code') return String(item.code || '');
    return String(item[field] == null ? '' : item[field]).toLowerCase();
  }

  function fillTemplate(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));
  }

  /* ------------------------------------------------------------------ *
   * 4. 单品裁决
   * ------------------------------------------------------------------ */
  function evaluateItemRule(type, rule, item, ctx) {
    const when = type.when;
    const params = rule.params || {};

    // bundle / config 类型不参与单品裁决
    if (type.kind !== 'item') return null;

    // 品类排除类：由调用方用 excludeCategories 处理，这里跳过
    if (when.metric) {
      const iv = item[when.metric] || 0;
      const a = num(params[when.valueKey]);
      const b = num(params[when.valueKey2]);
      let ok = false;
      switch (when.op) {
        case 'gt': ok = iv > a; break;
        case 'lt': ok = iv < a; break;
        case 'gte': ok = iv >= a; break;
        case 'lte': ok = iv <= a; break;
        case 'between': ok = iv >= a && iv <= b; break;
      }
      if (type.effect === 'bonus' || type.effect === 'penalty') { if (!ok) return null; }
      else if (!ok) return null; // veto 未命中即放行
      const isVeto = type.effect === 'veto';
      return {
        ruleId: rule.id, typeId: type.typeId, label: type.label, tier: type.tier,
        effect: isVeto ? 'veto' : type.effect,
        weight: type.effect === 'veto' ? 0 : signedWeight(type),
        reason: fillTemplate(type.reason, {
          itemValue: Math.round(iv * 10) / 10, target: a,
          unit: params.basis === 'calories' ? 'kcal' : 'g'
        })
      };
    }

    if (when.requireKeywords) return null;

    const values = resolveValues(type, when, params).map(v => String(v).toLowerCase());
    if (!values.length) return null;
    const fieldVal = itemFieldValue(item, when.field);
    const hit = values.find(v => fieldVal.indexOf(v) >= 0);

    if (when.op === 'notIn') {
      // 允许清单：命中即放行，未命中则否决
      const inList = values.indexOf(itemFieldValue(item, when.field)) >= 0;
      if (inList) return null;
      return {
        ruleId: rule.id, typeId: type.typeId, label: type.label, tier: type.tier, effect: 'veto', weight: 0,
        reason: fillTemplate(type.reason, {
          itemValue: item.category, mealSlotLabel: MEAL_SLOT_LABEL[ctx.mealSlot] || ctx.mealSlot
        })
      };
    }

    if (!hit) return null;
    if (type.effect === 'veto') {
      return {
        ruleId: rule.id, typeId: type.typeId, label: type.label, tier: type.tier, effect: 'veto', weight: 0,
        reason: fillTemplate(type.reason, {
          hit: hit, itemValue: item[when.field] || hit,
          modeLabel: (type.presets && modeLabel(type, params)) || '',
          groupLabel: GROUP_LABEL[params.group] || '',
          mealSlotLabel: MEAL_SLOT_LABEL[ctx.mealSlot] || ctx.mealSlot
        })
      };
    }
    return {
      ruleId: rule.id, typeId: type.typeId, label: type.label, tier: type.tier,
      effect: type.effect, weight: signedWeight(type),
      reason: fillTemplate(type.reason, {
        hit: hit, itemValue: item[when.field] || hit,
        groupLabel: GROUP_LABEL[params.group] || '',
        mealSlotLabel: MEAL_SLOT_LABEL[ctx.mealSlot] || ctx.mealSlot
      })
    };
  }

  function modeLabel(type, params) {
    const key = type.when.valueKey;
    const opt = (type.paramsSchema.find(p => p.key === key) || {}).options || [];
    const found = opt.find(o => String(o.value) === String(params[key]));
    return found ? found.label : params[key];
  }
  function signedWeight(type) {
    const w = type.weight == null ? 10 : type.weight;
    return type.effect === 'penalty' ? -w : w;
  }

  /* ------------------------------------------------------------------ *
   * 5. 主流程
   * ------------------------------------------------------------------ */
  function recommend(input) {
    const profile = input.profile || {};
    const ctx = Object.assign({ mealSlot: 'lunch', personGroup: 'adult', history: [], coupons: [] }, input.ctx || {});
    const menu = (input.menu || []).map(normalizeItem);
    const rules = (profile.rules || []).filter(r => r && r.enabled !== false && inScope(r, ctx));

    // 规则排序：tier 降序 → 用户 order 降序 → 声明顺序
    const ordered = rules.slice().map((r, i) => ({ r, i })).sort((a, b) => {
      const ta = TIER_RANK[(RULE_TYPE_MAP[a.r.type] || {}).tier] || 0;
      const tb = TIER_RANK[(RULE_TYPE_MAP[b.r.type] || {}).tier] || 0;
      if (ta !== tb) return tb - ta;
      const oa = a.r.order || 0, ob = b.r.order || 0;
      if (oa !== ob) return ob - oa;
      return a.i - b.i;
    }).map(x => x.r);

    const excludeCategories = collectExcludeCategories(ordered, ctx);

    /* --- 5.1 单品裁决 --- */
    const candidates = [];
    const rejected = [];
    for (const item of menu) {
      if (ctx.mealSlot && item.slots && item.slots.length && item.slots.indexOf(ctx.mealSlot) < 0) continue;
      if (excludeCategories.indexOf(item.category) >= 0) {
        rejected.push({ item, tier: 'custom', reason: '整餐不要「' + item.category + '」', ruleId: null });
        continue;
      }

      const trace = [];
      const suppressed = [];
      let vetoed = null;
      let score = 0;
      for (const rule of ordered) {
        const type = RULE_TYPE_MAP[rule.type];
        if (!type || type.kind !== 'item') continue;
        const d = evaluateItemRule(type, rule, item, ctx);
        if (!d) continue;
        if (d.effect === 'veto') {
          // ordered 已按 tier 降序，第一个否决即最高层裁决，后面更低的否决不再覆盖
          if (!vetoed) vetoed = d;
          continue;
        }
        // 已被否决：继续收集低层意见，用于输出"这条偏好被哪条硬规则压掉了"
        // 只记正向加分 —— 压掉一条"不喜欢"（减分）不构成冲突，写出来反而误导
        if (vetoed) {
          if (d.effect === 'bonus' && TIER_RANK[d.tier] < TIER_RANK[vetoed.tier]) suppressed.push(d);
          continue;
        }
        trace.push(d);
        score += d.weight;
      }

      if (vetoed) { rejected.push({ item, tier: vetoed.tier, reason: vetoed.reason, ruleId: vetoed.ruleId, suppressed: suppressed }); continue; }
      candidates.push({ item, score, trace });
    }

    /* --- 5.2 组合裁决（枚举有界搜索） --- */
    // 品类角色由 ctx.roles 覆盖，不在引擎里写死具体品类名
    const roles = Object.assign({}, DEFAULT_ROLES, ctx.roles || {});

    // 平局时按"离标准份多近"排序：没有偏好时给一份中规中矩的，而不是蛋白最大化堆成大份
    candidates.sort((a, b) => b.score - a.score
      || Math.abs(a.item.calories - refCalories(a.item, roles)) - Math.abs(b.item.calories - refCalories(b.item, roles))
      || a.item.price - b.item.price);

    const topOf = (list, n) => candidates.filter(c => list.indexOf(c.item.category) >= 0).slice(0, n);
    const mains = topOf(roles.primary, 6);
    const sides = topOf(roles.side, 4).concat([null]);
    const drinks = topOf(roles.drink, 4).concat([null]);
    // 甜品不默认塞进组合：只有规则明确给它加分、或调用方显式允许时才出现
    const dessertCands = topOf(roles.dessert, 3);
    const dessertWanted = ctx.allowDessert === true || dessertCands.some(c => c.score > 0);
    const desserts = dessertWanted ? dessertCands.concat([null]) : [null];

    const bundleRules = ordered.filter(r => (RULE_TYPE_MAP[r.type] || {}).kind === 'bundle');
    const passing = [];
    for (const m of mains) for (const s of sides) for (const d of drinks) for (const t of desserts) {
      const picks = [m, s, d, t].filter(Boolean);
      const metrics = sumMetrics(picks, ctx);
      const check = checkBundle(bundleRules, metrics, picks, ctx);
      if (!check.ok) continue;
      const total = picks.reduce((acc, p) => acc + p.score, 0) + check.bonus;
      passing.push({ picks, metrics, bonus: check.bonus, total, bundleTrace: check.trace });
    }
    passing.sort((a, b) => b.total - a.total);

    // 给用户"几个选项"而不是唯一答案：同一主食只出一次，凑不够再用其余组合补齐
    const topN = Math.max(1, input.topN || 1);
    const options = [];
    const seenMain = Object.create(null);
    const mainOf = ps => {
      const p = ps.find(x => roles.primary.indexOf(x.item.category) >= 0);
      return p ? p.item : null;
    };
    for (const c of passing) {
      const mi = mainOf(c.picks);
      const k = mi ? (mi.code || mi.name) : '';
      if (k && seenMain[k]) continue;
      if (k) seenMain[k] = 1;
      options.push(c);
      if (options.length >= topN) break;
    }
    if (options.length < topN) {
      for (const c of passing) {
        if (options.indexOf(c) < 0) options.push(c);
        if (options.length >= topN) break;
      }
    }
    const best = options[0] || null;

    /* --- 5.3 配置项 --- */
    const config = collectConfig(ordered, ctx);

    /* --- 5.4 结果 --- */
    if (!best) {
      // 没有任何组合通过硬约束：退化为"最接近"的单品，并说明卡在哪
      const why = mains.length
        ? explainFailure(bundleRules, sumMetrics([mains[0]], ctx), [mains[0]], ctx)
        : '当前餐次没有可选的' + roles.primary.join('、') + '（可能被餐次菜单规则或禁忌全部排除了）';
      return {
        ok: false, reason: why, ctx,
        picks: [], rejected: rejected.slice(0, 40), candidates: candidates.slice(0, 20),
        config, trace: [], metrics: null
      };
    }

    // 把 itemOptions 落到具体单品
    const finalize = o => {
      const picks = o.picks.map(p => ({
        item: p.item, score: p.score, trace: p.trace,
        options: resolveItemOptions(config.itemOptions, p.item)
      }));
      return {
        picks, metrics: o.metrics, score: o.total, bundleTrace: o.bundleTrace,
        summary: summarize(picks, o.metrics, config, ctx)
      };
    };
    const optionsOut = options.map(finalize);

    return {
      ok: true, ctx,
      options: optionsOut,              // 供用户挑的几个候选（主食互不重复）
      picks: optionsOut[0].picks,       // 兼容旧调用方：默认取最优
      metrics: optionsOut[0].metrics,
      bundleBonus: best.bonus,
      bundleTrace: best.bundleTrace,
      config: { orderOptions: config.orderOptions, excludeCategories },
      rejected: rejected.slice(0, 40),
      candidates: candidates.slice(0, 20),
      summary: optionsOut[0].summary
    };
  }

  function sumMetrics(picks, ctx) {
    const m = { calories: 0, protein: 0, sodium: 0, sugar: 0, fat: 0, price: 0, couponValue: 0, categories: {}, text: '' };
    const texts = [];
    for (const p of picks) {
      const it = p.item;
      m.calories += it.calories; m.protein += it.protein; m.sodium += it.sodium;
      m.sugar += it.sugar; m.fat += it.fat; m.price += it.price;
      m.categories[it.category] = (m.categories[it.category] || 0) + 1;
      texts.push(it.name + ' ' + (it.tags || []).join(' ') + ' ' + it.category);
    }
    m.text = texts.join(' ').toLowerCase();
    m.price = Math.round(m.price * 100) / 100;
    // 券：取该组合能吃到的最大面额（真实场景由 MCP query-store-coupons + calculate-price 决定）
    for (const c of (ctx.coupons || [])) {
      if (!c.minSpend || m.price >= c.minSpend) m.couponValue = Math.max(m.couponValue, num(c.value));
    }
    return m;
  }

  function checkBundle(bundleRules, metrics, picks, ctx) {
    const trace = [];
    let bonus = 0;
    let ok = true;
    for (const rule of bundleRules) {
      const type = RULE_TYPE_MAP[rule.type];
      if (!type) continue;
      const params = rule.params || {};
      if (type.effect === 'require' && type.when.requireKeywords) {
        const need = (params[type.when.valueKey] || []);
        const missing = need.filter(n => metrics.text.indexOf(String(n).toLowerCase()) < 0);
        if (missing.length) { ok = false; trace.push({ ruleId: rule.id, label: type.label, tier: type.tier, effect: 'require', reason: fillTemplate(type.reason, { missing: missing.join('、') }) }); break; }
        trace.push({ ruleId: rule.id, label: type.label, tier: type.tier, effect: 'pass', reason: '已包含 ' + need.join('、') });
        continue;
      }
      const iv = metrics[type.when.metric] || 0;
      const a = num(params[type.when.valueKey]);
      const fail = (type.when.op === 'gt' && iv > a) || (type.when.op === 'lt' && iv < a);
      if (type.effect === 'veto' && fail) {
        ok = false;
        trace.push({ ruleId: rule.id, label: type.label, tier: type.tier, effect: 'veto', reason: fillTemplate(type.reason, { itemValue: Math.round(iv * 10) / 10, target: a }) });
        break;
      }
      if (type.effect === 'bonus' && !fail) { bonus += type.weight || 10; }
      // 通过项不能复用失败措辞（会出现"380kcal 超出预算 480kcal"却标着[通过]），单独生成
      const u = UNIT_BY_METRIC[type.when.metric] || type.unit || '';
      const word = type.when.op === 'gt' ? '上限' : '下限';
      const sign = type.when.op === 'gt' ? '≤' : '≥';
      trace.push({ ruleId: rule.id, label: type.label, tier: type.tier, effect: 'pass',
        reason: `实际 ${Math.round(iv * 10) / 10}${u} ${sign} ${word} ${a}${u}` });
    }
    return { ok, bonus, trace };
  }

  function explainFailure(bundleRules, metrics, picks, ctx) {
    const c = checkBundle(bundleRules, metrics, picks, ctx);
    const v = c.trace.find(t => t.effect === 'veto' || t.effect === 'require');
    return v ? '没有组合能同时满足你的硬约束：' + v.reason : '没有满足全部硬约束的组合';
  }

  function collectExcludeCategories(rules, ctx) {
    const out = [];
    for (const r of rules) {
      const t = RULE_TYPE_MAP[r.type];
      if (t && t.configTarget === 'excludeCategories') out.push.apply(out, (r.params || {}).categories || []);
    }
    return out;
  }

  function collectConfig(rules, ctx) {
    const itemOptions = [], orderOptions = {};
    for (const r of rules) {
      const t = RULE_TYPE_MAP[r.type];
      if (!t || t.kind !== 'config') continue;
      const p = r.params || {};
      if (t.configTarget === 'itemOptions') {
        itemOptions.push({ keywords: (p.keywords || []).map(String), key: p.optionKey, value: p.optionValue });
      } else if (t.configTarget === 'orderOptions') {
        orderOptions[p.optionKey] = coerce(p.optionValue);
      }
    }
    return { itemOptions, orderOptions };
  }
  function coerce(v) {
    if (v === 'true') return true; if (v === 'false') return false;
    const n = Number(v); return v !== '' && !isNaN(n) && String(v).trim() !== '' && /^[0-9.]+$/.test(String(v)) ? n : v;
  }

  function resolveItemOptions(itemOptions, item) {
    const out = {};
    for (const o of itemOptions) {
      if (!o.key) continue;
      if (!o.keywords.length || o.keywords.some(k => item.searchText.indexOf(String(k).toLowerCase()) >= 0)) {
        out[o.key] = coerce(o.value);
      }
    }
    return out;
  }

  function summarize(picks, metrics, config, ctx) {
    const names = picks.map(p => p.item.name + (Object.keys(p.options).length ? '(' + Object.keys(p.options).join('/') + ')' : ''));
    const lines = [];
    lines.push('餐次：' + (MEAL_SLOT_LABEL[ctx.mealSlot] || ctx.mealSlot) + '　人群：' + (GROUP_LABEL[ctx.personGroup] || ctx.personGroup));
    lines.push('推荐：' + names.join(' + '));
    lines.push('合计：' + Math.round(metrics.calories) + 'kcal　蛋白 ' + Math.round(metrics.protein) + 'g　钠 ' + Math.round(metrics.sodium) + 'mg　糖 ' + Math.round(metrics.sugar) + 'g　¥' + metrics.price);
    if (metrics.couponValue > 0) lines.push('可用券：省 ¥' + metrics.couponValue + '，实付约 ¥' + Math.round((metrics.price - metrics.couponValue) * 100) / 100);
    const oo = config.orderOptions || {};
    if (Object.keys(oo).length) lines.push('订单设置：' + Object.keys(oo).map(k => k + '=' + oo[k]).join('　'));
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 6. 导出
   * ------------------------------------------------------------------ */
  /** 注册一个新的规则类型 —— 引擎本体无需改动，这是"可扩展"的兑现方式 */
  function registerRuleType(type) {
    if (!type || !type.typeId || !type.tier || !type.kind) throw new Error('规则类型缺少 typeId / tier / kind');
    if (TIER_RANK[type.tier] == null) throw new Error('未知 tier: ' + type.tier);
    const i = RULE_TYPES.findIndex(t => t.typeId === type.typeId);
    if (i >= 0) RULE_TYPES[i] = type; else RULE_TYPES.push(type);
    RULE_TYPE_MAP[type.typeId] = type;
    return type;
  }

  return {
    TIERS, TIER_RANK, RULE_TYPES, RULE_TYPE_MAP,
    MEAL_SLOT_LABEL, GROUP_LABEL,
    recommend, normalizeItem, evaluateItemRule, inScope, registerRuleType,
    version: '1.0.0'
  };
});
/* ==== ORDER-BUTLER:END ==== */
