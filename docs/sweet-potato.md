# 以薯换福活动协议与实现（2026-11）

种红薯、收蜜薯、把蜜薯卖给好友铺子换福气币，配合每日分享涨价与兑换商店。

## 来源与版本

- 协议常量与报文结构来自官方客户端 2026-11-25 抓包：活动组 `2026111707`、主活动 `2026111708`、兑换商店 `2026111709`。
- `.proto` 与常量与上游发布镜像 `Anrylin/qq-farm-bot`（`app/core/src/activity-data/sweet-potato.proto`、`dist/activity-center/sweet-potato.js`）逐字段核对一致；该仓库只发布产物，兑换商店与收购记录在其 Release notes 里标注「尚未接入」。
- 本仓库补充实现兑换商店（目录查询 + 兑换）与好友铺子比价，协议侧复用通用 `ExchangeShopRequest` / `QueryActivityRequest`，未新增 proto。
- 资源来自已合并的红薯资源包：种子 `20307`、作物 `1020307`、果实 `40307`、蜜薯 `1032`、福气币 `1033`。

## 活动划分

| ID | 用途 |
| --- | --- |
| 2026111707 | 活动组，`ActivityService.GetGroup` 的 `group_id` |
| 2026111708 | 主活动，领种子 / 出售 / 分享都挂号在这个 ID |
| 2026111709 | 兑换商店，`ExchangeShopRequest.activity_id` 用这个 ID |

三个 ID 都登记进 `core/src/services/activity-gameplay-registry.ts` 的 `GAMEPLAY_ADAPTERS`（`gameplayKey: 'sweetPotato'`、`detailTarget: 'sweetPotato'`），否则活动中心不会渲染入口，前端的 `inferGameplayKey` 也会返回 null。活动 ID 与时间窗的唯一来源是 `core/src/config/sweet-potato.ts`，前端 `web/src/constants/activity-windows.ts` 必须与之保持一致（`web/tests/sweet-potato-activity.test.mjs` 会用正则从后端常量文件取值比对）。

## 协议

主链路只有两个方法：

- `ActivityService.GetGroup`：拉组数据，回包 `SweetPotatoGroupReply` → `activity.state`（`claims` / `share_state` / `bonus_price` / 库存与收购余量）。
- `ActivityService.Operate`：写操作，请求体 `SweetPotatoOperateRequest{ id, cmd, selector }`。

| 动作 | cmd | selector 字段 |
| --- | --- | --- |
| 领取每日种子 | 91 | `claim_seed` |
| 查询铺子 | 92 | `get_shop` |
| 出售蜜薯 | 93 | `sell` |
| 分享暴击 | 98 | `share` |

selector 是 oneof，字段号与 cmd 必须成对出现：只写 cmd 不带 selector 时服务端按空操作处理，回包正常但状态不变。

兑换商店走通用协议，与本活动 ID 组无关：

- 目录：`QueryActivityRequest{ activity_id: 2026111709, operate_type: 7 }` → `ActivityOperateReply.data.catalog.goods`。
- 兑换：`ExchangeShopRequest{ activity_id: 2026111709, operate_type: 1, exchange_shop_operate: { goods_id, count } }`。

`operate_type` 的 7 / 1 与 `stellar.ts` 里的兑换商店用法一致，回包必须回带同一个 `operate_type` 才算成功。

## 写操作风控

所有写操作（领取 / 分享 / 出售 / 兑换）都走同一条链路，**不做自动重试**：

1. 先 `GetGroup` 读当前状态，已经做过的动作直接返回「无需操作」，不发请求。
2. 逐项校验：开关、活动是否开放、数量是否为正整数且不超过库存、好友是否在列表、收购价是否与用户确认的一致。
3. 单次发送，回包**逐字段**核对（出售要比对数量、单价、收入三个字段都一致）。
4. 状态确认不了就抛 `SWEET_POTATO_RESULT_UNKNOWN`，并把该动作冷却 300 秒（`retryAfter`），期间面板请求只会得到「上一次操作结果正在核对」。
5. 出售额外带 `requestId` 幂等签名：同一 `requestId` + 同一内容（铺主 / 数量 / 预期价）会复用同一个 Promise，内容变了直接拒绝；签名表 128 条上限、10 分钟过期。

价格与余量在发送前**再读一次**铺子状态：好友收购价变了抛 `SWEET_POTATO_PRICE_CHANGED`（提示新价格，本次不卖），收购余量不足抛对应错误，两者都不会落到「发出去才发现不对」。

## 分享暴击

分享是两段式，缺一段都拿不到涨价：

1. `ShareService.CheckCanShare` → `can_share` 为 false 直接放弃（不消耗当日次数）。
2. `Operate(cmd=98)` → 回包 `claims.share_claimed` 必须为 true。
3. `ShareService.ReportShare{ field_1: 28, field_4: 2017 }`（来源号 28、场景号 2017）。
4. 重读 `GetGroup` 确认 `bonus_price > 0`，否则按结果不明处理。

只有第 4 步确认后才会把「今日已分享」落成 `pendingShareDate`，避免分享失败后当天再也不试。自动分享每天只跑一次，`share_claimed` 与当天日期同时成立时直接跳过。

## 自动化与巡田

五个开关（`core/src/models/store/shared-state.ts` 默认值来自 `SWEET_POTATO_DEFAULTS`，全部默认开启）：

| 开关 | 作用 |
| --- | --- |
| `sweet_potato` | 总开关，关掉后子开关全部失效 |
| `sweet_potato_claim` | 每日自动领种子 |
| `sweet_potato_plant` | 巡田时空地自动种红薯、成熟自动收、枯死自动铲 |
| `sweet_potato_sell` | 收购价大于 0 时自动卖蜜薯 |
| `sweet_potato_share` | 每日自动分享暴击 |

- 活动自动化在 `core/src/services/activity-automation.ts` 里注册 4 个 op（claim / share / plant / sell），其中 `plant` 在 `automation.farm` 开启时直接返回 false，把地交给巡田，避免两处抢同一块空地。
- 巡田侧有两处接线：`farm/planting.ts` 的 `autoPlantEmptyLands` 在确定待种地块后先试红薯补种，**成功就返回、不回落普通策略**（种子用完才让普通作物接手）；`farm/scheduler.ts` 的 `autoHarvestLandIds` 在 `sweet_potato_plant` 关闭时把红薯地块从自动收获里排除，关掉种植就不会莫名其妙被收走。
- `runCropCycle` 是完整的「收 → 铲枯 → 补种」一轮，供活动页手动触发；`isSweetPotatoActive` 带 60 秒缓存，巡田每轮都问也不会每轮发 `GetGroup`。
- 活动未下发时 `getGroup` 写 300 秒负缓存（`unavailableUntil`），活动结束后不会每轮空打请求。

## 面板接口

挂在 `/api/activity-center/sweet-potato` 下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 活动状态（`fetchShop=false`，快照里不查商店） |
| GET | `/shop-catalog` | 兑换商店目录 |
| GET | `/shops?offset=` | 好友铺子列表，每页 5 条，30 秒价格缓存 |
| POST | `/:action` | `claim` / `share` / `sell` / `exchange` |

`/:action` 与 `offset` 已登记到 `core/tests/input-surface.test.js` 的 `INPUT_SURFACE`（`service` 类型守卫），新增路由漏登记会让全量测试红。四个方法同步注册进 `runtime/data-provider.ts`、`core/worker.ts`、`runtime/worker-manager.ts`，超时表里 `getSweetPotatoShops` 90 秒、`operateSweetPotato` 180 秒。

## 前端

- `web/src/components/activity/SweetPotatoTab.vue`：四宫格指标（收购价、福气币、蜜薯库存、剩余收购量）、三个主操作（领种子 / 分享暴击 / 一键卖自己）、好友铺子比价列表（分页继续加载）、选铺出售面板（数量 / 最多 / 全部 / 预计收入 / 二次确认）、兑换商店目录面板、规则折叠；`≤767px` 两列。
- `web/src/views/activity-center/SweetPotatoActivityPage.vue`：`ActivityShell` + 活动头，独立页承载 Tab。
- `web/src/stores/activity-center.ts`：`ActivityTabKey` / `ActivityGameplayKey` 加 `sweetPotato`，两处归一化白名单、`inferGameplayKey` 判断链、`SweetPotatoSummaryDto` 与快照字段同步补齐。
- `web/src/components/settings/AccountFeatureSettings.vue`：设置页新增 5 个开关，总开关关闭时子开关 `disabled`；活动结束后整块从设置页隐藏（`activityKeyVisible`）。
- 活动目录 `ActivityDirectoryPage.vue` 会追加一条「以薯换福」入口，与商店 / 兑换两个子活动共用同一个详情目标。

## 验证范围

- `core/tests/sweet-potato.test.js` 8 条：proto selector 与 cmd 往返、已领种子不发 Operate、收购价变化中止、余量不足中止、分享未涨价按结果不明、好友价格 30 秒缓存、开关默认值与总开关约束、活动 ID 已绑定玩法。
- `web/tests/sweet-potato-activity.test.mjs` 5 条：玩法注册、目录入口、页面挂载、设置页开关与隐藏、前后端 ID / 时间窗一致。
- 全量：core 1073 条、web 366 条全绿；`vue-tsc`、`eslint --max-warnings=0`、`pnpm build` 通过。
- **未在实服验证**的部分：兑换商店的真实兑换（目录与商品结构按 `stellar.ts` 的既有范式与协议定义核对，未实际消耗福气币）、好友铺子的真实成交（用假网关回包验证风控分支）。这两项接入前请先在界面里手动点一次核对余额。
