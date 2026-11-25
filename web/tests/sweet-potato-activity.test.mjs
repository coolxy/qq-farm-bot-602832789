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
  for (const key of ['sweet_potato', 'sweet_potato_claim', 'sweet_potato_plant', 'sweet_potato_sell', 'sweet_potato_share']) {
    assert.ok(windows.includes(key), `activity-windows.ts 缺少 ${key}`)
  }
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
