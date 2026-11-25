import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 以薯换福（2026-11）：前端入口、玩法注册、设置开关与前后端时间窗必须一致。
// 只读源码做静态断言，不依赖浏览器与当前时间。

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const gameplays = read('../src/components/activity/gameplays/index.ts')
const store = read('../src/stores/activity-center.ts')
const activityCenter = read('../src/views/ActivityCenter.vue')
const directory = read('../src/views/activity-center/ActivityDirectoryPage.vue')
const settings = read('../src/components/settings/AccountFeatureSettings.vue')
const windows = read('../src/constants/activity-windows.ts')
const tab = read('../src/components/activity/SweetPotatoTab.vue')
const coreConfig = read('../../core/src/config/sweet-potato.ts')

test('活动目录能把 2026111708 解析成以薯换福玩法', () => {
  assert.match(gameplays, /sweetPotato: sweetPotatoGameplay/)
  assert.match(gameplays, /if \(activity\.detailTarget === 'sweetPotato'\)/)
  assert.match(gameplays, /\['2026111707', '2026111708', '2026111709'\]/)
})

test('活动目录页会补一条以薯换福入口，且不会被归一化成观星', () => {
  assert.match(directory, /if \(sweetPotato\.value\)/)
  assert.match(directory, /gameplayKey: 'sweetPotato'/)
  // store 的白名单与 if-else 链都必须认识 sweetPotato，否则会落到 stellar 兜底。
  assert.match(store, /'sweetPotato'/)
  assert.match(store, /gameplayKey === 'sweetPotato' \|\| normalizedDetailTarget === 'sweetPotato'/)
})

test('活动中心挂上了以薯换福页面', () => {
  assert.match(activityCenter, /SweetPotatoActivityPage/)
  assert.match(activityCenter, /selectedActivity === 'sweetPotato'/)
})

test('设置页有以薯换福开关，且活动结束后隐藏', () => {
  assert.match(settings, /SWEET_POTATO_ACTIVITY_WINDOW/)
  assert.match(settings, /const sweetPotatoEnded = computed\(\(\) => Date\.now\(\) > SWEET_POTATO_ACTIVITY_WINDOW\.endMs\)/)
  assert.match(settings, /v-for="item in sweetPotatoSettings"/)
  assert.match(settings, /v-if="!sweetPotatoEnded"/)
  for (const key of ['sweet_potato', 'sweet_potato_claim', 'sweet_potato_plant', 'sweet_potato_sell', 'sweet_potato_share', 'sweet_potato_commission']) {
    assert.ok(windows.includes(key), `activity-windows.ts 缺少 ${key}`)
  }
})

test('活动页覆盖提成领取、自家铺子不限与序号制兑换目录', () => {
  // 提成卡片：显示待领数量，按钮直接把意图交给页面（数据层在 store）。
  assert.match(tab, /activity\?\.commission\.pending \?\? '0'/)
  assert.match(tab, /emit\('claimCommission'\)/)
  // 自家铺子不占好友额度：上限只看背包，不能拿剩余额度当上限。
  assert.match(tab, /if \(!targetShop\.value \|\| targetShop\.value\.unlimited\)/)
  // 自家铺子改显示服务端下发的剩余接收额度（quota），并对出售标注「不限」。
  assert.match(tab, /还可收 \{\{ formatNumber\(shop\.quota\)/)
  assert.match(tab, /<span v-if="shop\.unlimited">还可收 不限<\/span>/)
  // 兑换目录按序号下单，限购与价格都来自 cmd 97。
  assert.match(tab, /emit\('exchange', entry\.index, qty\)/)
  assert.match(tab, /限购 \{\{ entry\.limit \}\}/)
})

test('前后端活动 ID、时间窗与物品 ID 完全一致', () => {
  const pick = (source, name) => {
    const match = source.match(new RegExp(`${name}:\\s*'?(\\d+)'?`))
    assert.ok(match, `缺少常量 ${name}`)
    return match[1]
  }
  assert.equal(pick(coreConfig, 'groupId'), '2026111707')
  assert.equal(pick(coreConfig, 'activityId'), '2026111708')
  assert.equal(pick(coreConfig, 'shopActivityId'), '2026111709')
  assert.equal(pick(coreConfig, 'seedId'), '20307')
  assert.equal(pick(coreConfig, 'plantId'), '1020307')
  assert.equal(pick(coreConfig, 'honeyId'), '1032')
  // 前端只复制了时间窗；两边不一致会导致设置页在活动还在进行时就把开关藏掉。
  assert.equal(pick(coreConfig, 'fallbackStartTime'), '1795572000')
  assert.equal(pick(coreConfig, 'fallbackEndTime'), '1796831999')
  assert.match(windows, /startMs: 1795572000 \* 1000/)
  assert.match(windows, /endMs: 1796831999 \* 1000/)
})

test('自动卖薯的可调参数前后端一致，活动页有比价与收购记录入口', () => {
  const numeric = [
    ['sweet_potato_scan_friend_limit', '20'],
    ['sweet_potato_scan_interval_minutes', '30'],
    ['sweet_potato_sell_min_count', '1'],
  ]
  for (const [key, fallback] of numeric) {
    assert.ok(coreConfig.includes(key), `后端缺少 ${key}`)
    assert.ok(windows.includes(`key: '${key}'`), `前端缺少 ${key}`)
    assert.ok(coreConfig.includes(`${key}: ${fallback}`), `${key} 默认值与前端不一致`)
    assert.ok(windows.includes(`fallback: ${fallback}`), `${key} 前端兜底值与后端不一致`)
  }
  assert.ok(coreConfig.includes('sweet_potato_sell_fallback_own: true'))
  assert.match(settings, /v-for="field in sweetPotatoSellFields"/)
  assert.match(settings, /v-model="automation\.automation\.sweet_potato_sell_fallback_own"/)
  // 面板要能主动比价，也要能查看 cmd 95 的分红明细。
  // 端点调用落在 store（数据层），Tab 只发意图 —— 这是 li 版的三层结构，别再塞回组件里。
  assert.match(store, /\/api\/activity-center\/sweet-potato\/scan/)
  assert.match(store, /\/api\/activity-center\/sweet-potato\/records/)
  assert.match(tab, /emit\('scanFriends', true\)/)
  assert.match(tab, /\+{{ formatNumber\(entry\.commission\) }}/)
})

test('活动页接上 li 版的运行时能力：刷新行情、余额未知、比价缓存与分享上报', () => {
  // 刷新本人行情（cmd 92 只读），按钮不能和「一键比价」混成一个。
  assert.match(store, /\/api\/activity-center\/sweet-potato\/quote\/refresh/)
  assert.match(tab, /emit\('refreshQuote'\)/)
  // 背包没读到时显示 -- 而不是 0，且不能因此禁用出售。
  assert.match(tab, /activity\.luckCoinBalanceKnown \? formatNumber\(activity\.luckCoinBalance \?\? '0'\) : '--'/)
  assert.match(tab, /activity\?\.sweetPotatoBalanceKnown \? formatNumber\(sweetPotatoCount\) : '--'/)
  assert.match(tab, /if \(activity\.value\?\.luckCoinBalance === null \|\| activity\.value\?\.luckCoinBalance === undefined\)/)
  // 比价结果带 3 分钟缓存标记，重新比价要强制重扫。
  assert.match(store, /scan\?force=\$\{force \? 1 : 0\}/)
  assert.match(store, /3 分钟内的缓存结果，点「重新比价」强制重扫/)
  // 分享上报失败要降级成提示，不能混在「已涨」的成功文案里。
  assert.match(store, /result\.shareReported === false/)
  assert.match(store, /分享上报未确认/)
})

test('以薯换福面板沿用 li 版设计：三段式切换 + 兑换数量弹窗 + 规则说明', () => {
  // 顶部三段：红薯小铺 / 兑换商店 / 好友比价。
  assert.match(tab, /type TabKey = 'shop' \| 'store' \| 'compare'/)
  assert.match(tab, /红薯小铺/)
  assert.match(tab, /兑换商店/)
  assert.match(tab, /好友比价/)
  // 兑换不再在卡片上内联加减，改为弹窗填数量，避免误触一换就是多份。
  assert.match(tab, /class="exchange-dialog"/)
  assert.match(tab, /function stepExchange\(delta: number\)/)
  assert.match(tab, /最多可兑 \{\{ exchangeMax \}\} 个/)
  // 活动规则只在有段落时渲染，不占空白区块。
  assert.match(tab, /v-if="activity\?\.rules\?\.paragraphs\?\.length"/)
})

test('以薯换福的 DTO 适配：后端扁平结构映射成面板嵌套结构', () => {
  // 后端给的是 basePrice / bonusPrice / honey / pendingCommission，
  // 面板要的是 shop / sweetPotatoBalance / commission，映射必须显式写出来。
  assert.match(store, /export function normalizeSweetPotatoActivity/)
  assert.match(store, /price: basePrice/)
  assert.match(store, /bonus: bonusPrice/)
  assert.match(store, /pending: pendingCommission/)
  assert.match(store, /luckCoinBalance: balancesKnown \? coins : null/)
  // 剩余接收额度与兑换目录都不在快照里，初值必须是 null / 未加载，不能拿 0 冒充。
  assert.match(store, /quota: null/)
  assert.match(store, /catalogLoaded: false/)
})

test('活动说明是字符串数组时也要能显示，不能被归一化吞成空块', () => {
  // 后端 rulesOf() 直接回 ["【活动时间】", ...]，与其它活动的 { paragraphs } 不同；
  // 直接丢给 normalizeRules 会被 record() 判成空对象，整块说明在界面上消失。
  assert.match(store, /function normalizeSweetPotatoRules\(value: unknown\): ActivityRulesDto \{/)
  assert.match(store, /if \(Array\.isArray\(value\)\) \{/)
  assert.match(store, /rules: normalizeSweetPotatoRules\(raw\.rules\)/)
})
