import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const read = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
const panel = read('components/settings/YishuHuanfuActivityPanel.vue')
const featureSettings = read('components/settings/AccountFeatureSettings.vue')
const automationForm = read('components/settings/AutomationSettingsForm.vue')

// 面板必须覆盖的键：少一个用户就没法在界面上改，后端默认值会永远生效。
const YISHU_KEYS = [
  'yishu_enabled',
  'yishu_claim_seed',
  'yishu_share',
  'yishu_claim_commission',
  'yishu_commission_interval_hours',
  'yishu_scan_enabled',
  'yishu_scan_interval_hours',
  'yishu_auto_sell',
  'yishu_sell_after_time',
  'yishu_sell_min_gain',
  'yishu_sell_keep_count',
  'yishu_scan_friend_limit',
  'yishu_sell_min_count',
  'yishu_sell_fallback_own',
]

test('以薯换福自动化只在活动卡片的弹窗里出现，自动化设置页不再重复一份', () => {
  assert.doesNotMatch(automationForm, /yishu_/, '自动化设置页不应再出现以薯换福开关，避免同一份配置两处编辑')

  const eventsStart = featureSettings.indexOf(`<div v-else-if="activeModule === 'events'"`)
  assert.ok(eventsStart > 0, '活动模块分支不存在')
  const events = featureSettings.slice(eventsStart)
  assert.ok(events.includes('<YishuHuanfuActivityPanel'), '活动面板缺少以薯换福卡片')
})

test('活动卡片里的以薯换福面板覆盖全部配置键', () => {
  for (const key of YISHU_KEYS)
    assert.ok(panel.includes(key), `以薯换福面板缺少 ${key}`)
})

test('总开关计入活动项统计，模块状态与卡片标签保持一致', () => {
  const keysStart = featureSettings.indexOf('const activityKeys = computed')
  assert.ok(keysStart > 0)
  const keysBlock = featureSettings.slice(keysStart, featureSettings.indexOf('function activityKeyVisible'))
  assert.ok(keysBlock.includes('yishu_enabled'), 'activityKeys 缺少 yishu_enabled，总开关开了模块仍显示未开启')
  assert.ok(featureSettings.includes(`yishu_enabled !== false && '以薯换福'`), '活动卡片摘要缺少以薯换福标签')
})

test('面板自带开关行样式（父组件是 scoped，样式不会穿透）', () => {
  assert.match(panel, /<style scoped>/)
  assert.ok(panel.includes('.automation-setting-item'), '缺少 automation-setting-item 样式，开关行会失去边框')
})
