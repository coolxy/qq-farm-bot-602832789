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
  assert.match(tab, /pendingCommission/)
  assert.match(tab, /act\('commission'\)/)
  // 自家铺子不占好友额度：上限只看背包，不能拿 remaining 当上限。
  assert.match(tab, /if \(sellTarget\.value\.unlimited\)/)
  assert.match(tab, /shop\.unlimited \? '还可收 不限'/)
  // 兑换目录按序号下单，价格与限购都来自 cmd 97。
  assert.match(tab, /exchangeGoods\(goods\)/)
  assert.match(tab, /index: goods\.index, count: catalogCount\(goods\.index\)/)
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
  assert.match(tab, /\/api\/activity-center\/sweet-potato\/scan/)
  assert.match(tab, /\/api\/activity-center\/sweet-potato\/records/)
  assert.match(tab, /shopsMode\.value = 'scan'/)
  assert.match(tab, /sp-record-commission/)
})
