# 以薯换福活动协议与实现（2026-11）

种红薯、收蜜薯、把蜜薯卖给好友铺子换福气币，配合每日分享涨价与兑换商店。

## 来源与版本

- 协议常量与报文结构来自官方客户端 2026-11-25 抓包：活动组 `2026111707`、主活动 `2026111708`、副模块 `2026111709`。
- `.proto` 与常量与上游发布镜像 `Anrylin/qq-farm-bot`（`app/core/src/activity-data/sweet-potato.proto`、`dist/activity-center/sweet-potato.js`）逐字段核对一致；该仓库只发布产物，兑换商店与收购记录在其 Release notes 里标注「尚未接入」。
- **2026-11-25 二次修正**：按 `muyuewang/qq-farm-bot-li`（同上游下游分支）的实机抓包补齐 cmd 95/96/97/99，并改正三处字段语义——兑换商店在主活动上（副模块 `2026111709` 的 field 117 恒空）、`SweetPotatoShopReply.field_2` 是 bool `can_sell`、出售回包 field 4 是每日上限而非剩余额度。
- 资源来自已合并的红薯资源包：种子 `20307`、作物 `1020307`、果实 `40307`、蜜薯 `1032`、福气币 `1033`。

## 活动划分

| ID | 用途 |
| --- | --- |
| 2026111707 | 活动组，`ActivityService.GetGroup` 的 `group_id` |
| 2026111708 | 主活动，领种子 / 出售 / 分享 / 兑换 / 提成全部挂这个 ID |
| 2026111709 | 副模块，抓包里不承载数据；仅在活动目录里作为同组 ID 出现 |

三个 ID 都登记进 `core/src/services/activity-gameplay-registry.ts` 的 `GAMEPLAY_ADAPTERS`（`gameplayKey: 'sweetPotato'`、`detailTarget: 'sweetPotato'`），否则活动中心不会渲染入口，前端的 `inferGameplayKey` 也会返回 null。活动 ID 与时间窗的唯一来源是 `core/src/config/sweet-potato.ts`，前端 `web/src/constants/activity-windows.ts` 必须与之保持一致（`web/tests/sweet-potato-activity.test.mjs` 会用正则从后端常量文件取值比对）。

## 协议

主链路只有两个方法：

- `ActivityService.GetGroup`：拉组数据，回包 `SweetPotatoGroupReply` → `activity.state`（状态槽 field 130）。
- `ActivityService.Operate`：读写操作，请求体 `SweetPotatoOperateRequest{ id, cmd, selector }`，selector 字段号固定是 `190 + cmd`。

| 动作 | cmd | selector | 回包字段 |
| --- | --- | --- | --- |
| 领取每日种子 | 91 | `claim_seed` | `grant` |
| 查询铺子 | 92 | `get_shop` | `quote{base,bonus,quota,shop}` + `can_sell` |
| 出售蜜薯 | 93 | `sell` | `{count, price, total, quota, balance}` |
| 收购记录 | 95 | `records` | `records[]`（timestamp/gid/count/total/name/avatar/level/commission） |
| 兑换下单 | 96 | `exchange{index,count}` | `{price, grant, balance}` |
| 兑换目录 | 97 | `catalog` | `catalog.goods[]` + 余额 |
| 分享暴击 | 98 | `share` | `{price, grant, shop.share_key}` |
| 领取收购提成 | 99 | `claim_commission` | `{amount, balance}` |

selector 是 oneof，字段号与 cmd 必须成对出现：只写 cmd 不带 selector 时服务端按空操作处理，回包正常但状态不变。

### 状态槽 130

| 槽 | 含义 |
| --- | --- |
| 1 | `claims`：`seed_claimed` / `share_claimed`，服务端今日领取标记 |
| 2 | `share`：`bonus` / `timestamp`，本次分享的暴击加成与时间戳 |
| 3 | 福气币余额（首次出售前缺失，之后出现；兑换会扣减） |
| 4 | `actions`：动作标记，实机只保留最近一次动作（卖出 / 分享 / 领种子互相覆盖），**不能**用来判断今天是否已领 |
| 5 / 6 | 本人铺子今日基础收购价 / 分享暴击加成，**成交价 = 5 + 6** |
| 7 | 本人铺子今日接收总量 |
| 11 / 13 | 待领收购提成 / 提成标志（没提成时字段缺失，不是 0） |

### 兑换商店

兑换挂在主活动上，**不走通用 `ExchangeShopRequest`，也不用 2026111709**：

- 目录：cmd 97，回包 `catalog.goods[]`，每档只有 `index / price / status / limit`；`item_id` 与名称由客户端静态表映射（`SWEET_POTATO_CATALOG_TEMPLATE`，10 档），价格对不上时一律不显示名字，避免展示错商品。
- 下单：cmd 96，参数 `{index, count}`，回包给出真实 `item_id`、单价与兑换后余额。

本地先拦三件事：限购次数、福气币余额（`limit`、`coins` 都来自 cmd 97 与状态槽）、回包单价必须与目录一致。

## 运行时：余额非阻塞快照

活动快照会被面板反复轮询，而网关的 `Bag` 请求排在活动请求之后，并发一满就被挤掉。早期版本在快照里同步 `await` 背包，一次抖动既拖慢快照又只能拿到 0；页面挂载与轮询还会并发打两个快照，后一个失败就覆盖前一个的成功结果，表现是「刚刷新有数字、几秒后整排变 0」。

现在分成两条通道（v3.39.0 按 li 版移植）：

- **`refreshBalances()`**：唯一打网关的通道，同一时刻只允许一个在途请求（单飞合并），最坏重试 250/700ms 两次。
- **`currentBalances()`**：快照专用，同步读内存，绝不 `await`。内存值超过 10 秒就在后台补一次，不阻塞本次返回。

两级兜底：`BALANCE_CACHE_TTL_MS`（10 秒）内直接复用；读失败但手里有 `BALANCE_STALE_MAX_MS`（10 分钟）内的成功值时继续用旧值并标 `balanceStale`；连一次成功值都没有才下发 `balancesKnown=false`（前端显示 `--`，不是 0）。

- 进程启动 1.2 秒后预热一次（`unref` 定时器），把首个快照的兜底填上。
- 写操作（领种子 / 分享 / 出售 / 兑换 / 提成 / 收菜补种）成功后立刻 `invalidateBalanceCache()`，后台重读真值；这些接口回填的快照用 `freshBalances: true` 等一次真值。
- 余额未知时 `actions.sell.enabled` 保持 true——「没读到」不等于「没有蜜薯」，最终由服务端判断。

## 写操作风控

所有写操作（领取 / 分享 / 出售 / 兑换 / 提成）都走同一条链路，**不做自动重试**：

1. 先 `GetGroup` 读当前状态，已经做过的动作直接返回「无需操作」，不发请求。
2. 逐项校验：开关、活动是否开放、数量是否为正整数且不超过库存、好友是否在列表、铺子是否收薯（`can_sell`）、收购价是否与用户确认的一致。
3. 单次发送，回包**逐字段**核对（出售要比对数量、单价、收入三个字段都一致）。
4. 状态确认不了就抛 `SWEET_POTATO_RESULT_UNKNOWN`，并把该动作冷却 300 秒（`retryAfter`），期间面板请求只会得到「上一次操作结果正在核对」。
5. 出售额外带 `requestId` 幂等签名：同一 `requestId` + 同一内容（铺主 / 数量 / 预期价）会复用同一个 Promise，内容变了直接拒绝；签名表 128 条上限、10 分钟过期。

价格与余量在发送前**再读一次**铺子状态：好友收购价变了抛 `SWEET_POTATO_PRICE_CHANGED`（提示新价格，本次不卖），`can_sell=false` 抛 `SWEET_POTATO_SHOP_CLOSED`（换一家），好友铺子额度不足抛 `SWEET_POTATO_CAPACITY_EXCEEDED`。三者都不会落到「发出去才发现不对」。

两个容易写错的点：

- **`can_sell` 是三态**：true 可收 / false 明确拒收 / 回包没带字段（按可卖处理）。protobufjs 的 decode 不给缺失字段补默认值，所以用 `hasOwnProperty` 判断「明确 false」，不能直接读布尔值。
- **自家铺子不占好友额度**：`remaining` 对它是「不限」，本地校验必须跳过额度，否则 `remaining=0` 时「一键卖自己」会永远被自己拦住。出售回包的 field 4 是**每日上限**（实机 8000），不是剩余量，剩余量只能按成交数自己递减。

## 分享暴击

顺序与官方客户端一致，**先分享、后上报**（v3.39.0 按 li 版改正，之前把 `CheckCanShare` 当门闸放在最前面，会在上报入口临时不可用时白白放弃当天的分享）：

1. `Operate(cmd=98)` → 回包 `claims.share_claimed` 必须为 true。
2. `ShareService.CheckCanShare` → `can_share` 为 true 才继续。
3. `ShareService.ReportShare{ field_1: 28, field_4: 2017 }`（来源号 28、场景号 2017）——**暴击加成到这一步才真正落地**。
4. 重读 `GetGroup` 确认 `claims.share_claimed`。

第 2/3 步整段是「尽力而为」：抛异常或 `can_share=false` 都只记 `shareReportError`，不阻断主流程，接口把 `shareReported` / `shareReportError` 一起透给前端，面板用警示样式提示「铺子已分享，但暴击上报未确认」。只有第 4 步确认不了才按 `SWEET_POTATO_RESULT_UNKNOWN` 处理。

cmd 98 回包（`SweetPotatoShareReply`）字段号按 li 版对齐：`grant{1:item_id,2:count}` / `price=2` / `field_3` / `shop=4{share_key=2}` / `field_5` / `field_6`。旧版本把 2/3 写成了 `bonus_price`/`price`、4 号当 `bytes` 分享凭证，因为从没读过所以一直没暴露。

## 收购提成

好友把蜜薯卖进你的铺子后，你按比例拿提成：状态槽 `130.11` 是待领金额，cmd 99 领取后该字段消失、`coins` 增加。面板「待领提成」与自动化开关 `sweet_potato_commission` 都读这一项，没有提成时不发写请求。

### 收购记录（cmd 95）

好友把蜜薯卖进你的铺子会生成一条记录，cmd 95 请求不带参数、回包 `records[]`：字段 1 时间戳、2 卖家 gid、3 数量、4 付给卖家的总额（实机 `4320 = 30 × 144`）、6 昵称、7 头像、8 等级、9 你拿到的提成（实机 86）。界面只展示最近 30 条，按时间倒序，并汇总 `totalCommission` / `totalIncome`。

没有记录时服务端可能只回一个空包，所以这一条只读接口不套 `rpc()` 的「必须带 `activity.state`」校验——空包，或回包 ID / cmd 至少一项匹配，都按「暂无收购记录」处理。

## 自动化与巡田

六个开关（`core/src/models/store/shared-state.ts` 默认值来自 `SWEET_POTATO_DEFAULTS`，全部默认开启）：

| 开关 | 作用 |
| --- | --- |
| `sweet_potato` | 总开关，关掉后子开关全部失效 |
| `sweet_potato_claim` | 每日自动领种子 |
| `sweet_potato_plant` | 巡田时空地自动种红薯、成熟自动收、枯死自动铲 |
| `sweet_potato_sell` | 自动比价卖蜜薯（策略见下） |
| `sweet_potato_share` | 每日自动分享暴击 |
| `sweet_potato_commission` | 提成到账后自动领取 |

另有四个数值/布尔参数，同样在 `SWEET_POTATO_DEFAULTS` 里，设置页「自动出售」展开后可调：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `sweet_potato_scan_friend_limit` | 20 | 单次比价扫描的铺子数上限（含自家），硬上限 100 |
| `sweet_potato_scan_interval_minutes` | 30 | 两次全量比价的最小间隔，间隔内复用上一轮排序 |
| `sweet_potato_sell_min_count` | 1 | 背包蜜薯达到这个数量才自动出售 |
| `sweet_potato_sell_fallback_own` | true | 好友都不收时是否兜底卖给自己 |

### 自动卖薯比价

不再是「有暴击就卖给自己」，而是按成交价贪心吃额度：

1. 背包蜜薯低于 `min_count` 直接跳过，不白扫好友；
2. `scanShops()` 用 cmd 92 逐个读铺子（并发 4），自家铺子也在候选里但永远排最后，按「成交价降序 → 剩余额度降序」排序；
3. 从最高价开始卖，一家额度吃满再换下一家，**单轮最多切 3 家**，相邻两笔间隔 1200ms，剩下的留到下一轮；
4. 好友铺子要求 `expectedPrice` 与 `can_sell` 双确认；额度不足 / 停收 / 价格变了只换下一家，回包对不上就整轮停手，绝不重试；
5. 好友都收满时按 `fallbackOwn` 决定是否卖给自己，自家铺子不受额度限制。

比价结果按「上限 + 间隔」缓存，自动卖薯在间隔内直接复用排序；一旦本轮有成交就清空缓存，下一轮重新比价。

- 活动自动化在 `core/src/services/activity-automation.ts` 里注册 5 个 op（claim / share / plant / sell / commission），其中 `plant` 在 `automation.farm` 开启时直接返回 false，把地交给巡田，避免两处抢同一块空地。
- 巡田侧有两处接线：`farm/planting.ts` 的 `autoPlantEmptyLands` 在确定待种地块后先试红薯补种，**成功就返回、不回落普通策略**（种子用完才让普通作物接手）；`farm/scheduler.ts` 的 `autoHarvestLandIds` 在 `sweet_potato_plant` 关闭时把红薯地块从自动收获里排除，关掉种植就不会莫名其妙被收走。
- `runCropCycle` 是完整的「收 → 铲枯 → 补种」一轮，供活动页手动触发；`isSweetPotatoActive` 带 60 秒缓存，巡田每轮都问也不会每轮发 `GetGroup`。
- 活动未下发时 `getGroup` 写 300 秒负缓存（`unavailableUntil`），活动结束后不会每轮空打请求。

## 面板接口

挂在 `/api/activity-center/sweet-potato` 下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 活动状态（快照里不查目录，`fetchShop=false`） |
| GET | `/shop-catalog` | 兑换目录（cmd 97） |
| GET | `/shops?offset=` | 好友铺子列表，每页 5 条，30 秒价格缓存 |
| GET | `/scan?limit=&force=` | 一键比价：一次扫完（含自家），按成交价降序，上限 100；结果缓存 3 分钟，`force=1` 强制重扫 |
| GET | `/records` | 收购记录（cmd 95），最近 30 条与提成汇总 |
| POST | `/quote/refresh` | 刷新本人铺子今日行情（cmd 92 只查自己），拿剩余接收额度 |
| POST | `/:action` | `claim` / `share` / `sell` / `exchange` / `commission` |

`/:action`、`offset`、`limit`、`force` 已登记到 `core/tests/input-surface.test.js` 的 `INPUT_SURFACE`（`service` 类型守卫），新增路由漏登记会让全量测试红。新方法同步注册进 `runtime/data-provider.ts`、`core/worker.ts`、`runtime/worker-manager.ts`，超时表里 `getSweetPotatoShops` 90 秒、`scanSweetPotatoShops` 240 秒（100 家 × 并发 4 × 8 秒）、`refreshSweetPotatoQuote` 30 秒、`getSweetPotatoRecords` 30 秒、`operateSweetPotato` 180 秒。提成领取走同一个 `operateSweetPotato`，不额外加 provider 方法。

## 前端

- `web/src/components/activity/SweetPotatoTab.vue`：五格指标（收购价、福气币、蜜薯库存、剩余收购量、待领提成）、四个主操作（领种子 / 分享暴击 / 一键卖自己 / 领取提成）、好友铺子双模式（「分页查询」每页 5 家 +「一键比价」按成交价排序，自家铺子显示服务端下发的「还可收 N（自家不限出售）」，停收的置灰并标原因，命中 3 分钟缓存时文案会说明）、选铺出售面板（数量 / 最多 / 全部 / 预计收入 / 二次确认）、兑换目录（序号 + 单价 + 限购 + 数量输入 + 兑换按钮）、收购记录列表（分红明细与时间）、规则折叠；`≤1180px` 三列、`≤767px` 两列。
- v3.39.0 前端新增：面板工具条的「刷新我的行情」（`POST /quote/refresh`，只读，把剩余接收额度写进「剩余收购量」的提示位并同步比价表里自己那一行）；背包没读到时三处数量显示 `--` 且不禁用出售；分享上报失败用 `.sp-message.warn` 警示样式，不和成功提示混在一起。
- `web/src/views/activity-center/SweetPotatoActivityPage.vue`：`ActivityShell` + 活动头，独立页承载 Tab。
- `web/src/stores/activity-center.ts`：`ActivityTabKey` / `ActivityGameplayKey` 加 `sweetPotato`，两处归一化白名单、`inferGameplayKey` 判断链、`SweetPotatoSummaryDto` 与快照字段同步补齐。
- `web/src/components/settings/AccountFeatureSettings.vue`：设置页 6 个开关，总开关关闭时子开关 `disabled`；开启「自动出售」后展开 3 个数值输入 + 兜底开关；活动结束后整块从设置页隐藏（`activityKeyVisible`）。
- 活动目录 `ActivityDirectoryPage.vue` 会追加一条「以薯换福」入口，与三个同组 ID 共用同一个详情目标。

## 验证范围

- `core/tests/sweet-potato.test.js` 32 条：八个 cmd 的 selector 往返（含 cmd 95 落在 195）、状态槽 11/13、`can_sell` 三态（含「回包没带字段」）、自家铺子 `remaining=0` 也能卖、出售后剩余额度按成交数递减、提成领取与无提成不发请求、目录归一化与价格不匹配时不留名字、兑换限购与余额拦截、已领种子不发写请求、价格变化中止、分享未涨价按结果不明、好友价格缓存、开关默认值、活动 ID 绑定玩法；新增比价降序 + 单轮 3 家、兜底卖自己与关兜底、最低出售数量、回包价格对不上停手、收购记录倒序与汇总、空回包；v3.39.0 又补了状态槽 4 号子槽与分享回包字段号、分享先发后报（含上报不可用 / 抛异常 / 服务端没记上三条分支）、快照不 await 背包与 stale 回退、余额未知不禁用出售、比价 3 分钟缓存与 `force` 强制重扫、刷新行情查自己、目录 `itemIdMatched`、四个可调参数的显式夹取。
- `web/tests/sweet-potato-activity.test.mjs` 8 条：玩法注册、目录入口、页面挂载、设置页 6 个开关与隐藏、提成/自家不限/序号兑换的静态断言、前后端 ID 与时间窗一致、4 个卖薯参数前后端默认值一致 + 比价/记录入口；v3.39.0 补一条运行时能力断言（刷新行情入口、`--` 显示、比价缓存标记、分享上报警示样式）。
- 全量：core 1097 条、web 374 条全绿；`vue-tsc`、`eslint --max-warnings=0`、`pnpm build` 通过。
- **未在实服验证**的部分：兑换下单（cmd 96）、提成领取（cmd 99）、收购记录（cmd 95）与好友铺子的真实成交都只有假网关验证；自动卖薯的多家切换用的是夹具报价。首次使用请在界面里手动点一次核对余额。
