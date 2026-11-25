import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const dashboard = readFileSync(new URL('../src/views/Dashboard.vue', import.meta.url), 'utf8')
const ranch = readFileSync(new URL('../src/views/RanchOverview.vue', import.meta.url), 'utf8')

test('农场库存：作物图鉴 / 超变图鉴显示「已解锁 / 总条目」', () => {
  assert.match(dashboard, /作物图鉴<\/span>/)
  assert.match(dashboard, /超变图鉴<\/span>/)
  assert.doesNotMatch(dashboard, /普通收藏点|典藏收藏点/, '旧标签不能再出现')
  assert.match(dashboard, /\{\{ cropIllustratedFraction \}\}/)
  assert.match(dashboard, /\{\{ mutantIllustratedFraction \}\}/)
})

test('农场图鉴分数按 items.unlocked 统计，数据来自 /api/illustrated', () => {
  assert.match(dashboard, /useIllustratedStore/)
  assert.match(dashboard, /illustratedFraction\(book: any\): string/)
  assert.match(dashboard, /item\.unlocked === true\)\.length\}\/\$\{items\.length\}/, '格式为 已解锁/总数')
  assert.match(dashboard, /illustratedData\.value\?\.crop/)
  assert.match(dashboard, /illustratedData\.value\?\.mutant/)
  assert.match(dashboard, /await illustratedStore\.fetch\(String\(id\)\)/, '首页要主动拉一次图鉴')
  assert.match(dashboard, /now - lastIllustratedFetchAt < 60000/, '60 秒节流，避免每 10 秒打重接口')
})

test('牧场库存：普通图鉴 / 巨大化图鉴显示「已解锁 / 总条目」', () => {
  assert.match(ranch, /label: '普通图鉴'/)
  assert.match(ranch, /label: '巨大化图鉴'/)
  assert.doesNotMatch(ranch, /label: '巨大图鉴'/, '旧标签「巨大图鉴」不能再出现')
  const stock = ranch.slice(ranch.indexOf('const stockTiles'), ranch.indexOf('/* ── 下次检查倒计时'))
  assert.match(stock, /entry\.unlocked === true/, '普通图鉴按已解锁条目计数')
  assert.match(stock, /entry\.giant\?\.unlocked === true/, '巨大化图鉴按已解锁巨大条目计数')
  assert.match(stock, /\$\{unlocked\}\/\$\{animals\.length\}/, '格式为 已解锁/总数')
})
