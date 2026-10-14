# MCP 接入说明

## 使用的 MCP Server

| 项 | 值 |
|---|---|
| Server | 麦当劳中国官方 MCP（`mcd-mcp`） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 鉴权 | `Authorization: Bearer <MCP Token>`，Token 在 [open.mcd.cn/mcp](https://open.mcd.cn/mcp) 申请 |
| 配置 | 见 `mcp-config.example.json`（仅环境变量占位符，无真实凭证） |

本项目**真实消费**该 MCP 的能力：菜单、营养、券、积分、算价、下单全部走 MCP 工具，不写死任何餐品数据。仓库里的 `samples/menu.json` 只用于离线沙盘演示与自动化测试。

## 调用流程

```
用户："帮我点个午餐，我在控卡"
        │
        ├─ 1. now-time-info ─────────────► 确定餐次（午）
        ├─ 2. query-nearby-stores ────────► 定位门店
        ├─ 3. query-meals ────────────────► 当前可售菜单 + 编码
        ├─ 4. list-nutrition-foods ───────► 热量 / 蛋白 / 钠 / 糖 / 脂肪
        ├─ 5. order-list ─────────────────► 历史订单（喂给"换换口味"规则）
        │
        ├─ 6. 规则引擎裁决 ───────────────► 七层优先级 + 冲突记录
        │      engine/order-butler.js
        │
        ├─ 7. query-store-coupons ────────► 可用券
        ├─ 8. query-my-account ───────────► 积分（可选，用于"积分换什么"）
        ├─ 9. calculate-price ────────────► 实付金额
        │
        └─ 10. create-order（需用户确认）─► 支付链接 + 订单号
```

## Tool 映射表

| 环节 | MCP Tool | 在本项目中的作用 |
|---|---|---|
| 时间/餐次 | `now-time-info` | 决定走哪一套餐次规则（早/午/晚/夜宵） |
| 门店 | `query-nearby-stores` | 外送与到店场景定位，`query-store-coupons` 依赖门店 |
| 外送地址 | `delivery-query-addresses` | 麦乐送场景选地址 |
| 可配送门店 | `delivery-query-stores` | 外送场景筛门店 |
| 菜单 | `query-meals` | 引擎的输入：餐品编码、分类、标签、价格 |
| 套餐详情 | `query-meal-detail` | 看套餐构成与可替换项，支撑"去酱/换配餐"等定制 |
| 营养 | `list-nutrition-foods` | 引擎的热量/蛋白/钠/糖/脂肪五个硬指标数据来源 |
| 优惠券 | `query-store-coupons` / `query-my-coupons` / `available-coupons` / `auto-bind-coupons` | 优惠层规则的数据来源 |
| 积分 | `query-my-account` / `mall-points-products` | 积分兑换场景 |
| 算价 | `calculate-price` | 校验"单次预算"规则，给出实付金额 |
| 下单 | `create-order` | 用户确认后真正落单 |
| 订单 | `query-order` / `order-list` / `cancel-order` | 查进度、历史订单（喂"换换口味"）、取消 |
| 活动 | `campaign-calendar` | 活动日历查询 |

## 业务价值

1. **把 MCP 的"能力"变成"决策"。** MCP 给的是原子能力（查菜单、算价、下单），本项目在其上加了一层可配置的规则引擎，让能力按每个人的真实约束自动收敛成一个决定。
2. **从"能用"到"敢用"。** 过敏、宗教戒律、控卡这类约束，靠人每次记容易漏；规则一次设定，次次生效，且冲突有确定仲裁。
3. **可解释换取信任。** 每条推荐与排除都点名是哪条规则起作用，冲突时明确"谁的优先级更高"，用户不必盲信 AI。
4. **降低点单摩擦。** 定制项（去酱/去冰）、取餐方式、用券随规则自动带上，确认即下单。

## 安全边界

- 仓库内**无真实 Token**，`mcp-config.example.json` 只有 `${MCD_MCP_TOKEN}` 占位符。
- 任何 `create-order` 前必须取得用户明确确认；不对支付做任何自动化绕过。
- 营养与价格一律以 MCP 实时返回为准，本地示例数据仅用于演示与测试。
