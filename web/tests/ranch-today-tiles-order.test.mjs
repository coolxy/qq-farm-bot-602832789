import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

/**
 * 牧场首页「今日统计」瓦片：固定 15 项（4 项资源 + 11 项动作），顺序由产品指定。
 *
 * 之前靠 todayTiles 的拼接顺序隐式表达，改一处容易连带打乱别处，所以收敛成
 * TODAY_TILE_ORDER 一张表。这里锁住表内容、覆盖关系与「确实按表排」这件事。
 */

const source = readFileSync(new URL('../src/views/RanchOverview.vue', import.meta.url), 'utf8')

function tileOrder() {
  const block = source.match(/const TODAY_TILE_ORDER = \[([\s\S]*?)\]/)
  assert.ok(block, 'RanchOverview.vue 里要有 TODAY_TILE_ORDER 顺序表')
  return [...block[1].matchAll(/'([^']+)'/g)].map(match => match[1])
}

test('今日统计固定 14 项：金券 → 经验 → 松果 → 便便 → 出售 → 偷取 → 蚊子 → 喂养 → 催产 → 收产物 → 出栏 → 清理 → 帮清理 → 帮催产', () => {
  assert.deepEqual(tileOrder(), [
    'currency-1007',
    'today-exp',
    'currency-1008',
    'currency-7002',
    'action-sell',
    'action-steal',
    'action-putMosquito',
    'action-feed',
    'action-produce',
    'action-harvest',
    'action-release',
    'action-clean',
    'action-cleanFriend',
    'action-produceFriend',
  ])
})

test('蚊子瓦片标签去掉「放」字，与其它动作保持两字口径', () => {
  assert.match(source, /\{ key: 'putMosquito', label: '蚊子' \}/)
  assert.ok(!source.includes('放蚊子'), '概览页不应再出现「放蚊子」标签')
})

test('todayTiles 按顺序表排序，只展示固定 15 项', () => {
  assert.match(source, /const todayTiles = computed\(\(\) => \{/, 'todayTiles 必须是带排序的实现，不能退回直接拼接')
  assert.match(source, /TODAY_TILE_ORDER\.indexOf\(key\)/, '要用顺序表取 rank')
  assert.match(source, /index < 0 \? TODAY_TILE_ORDER\.length : index/, '不在表里的 key 排到最后')
  assert.match(source, /sort\(\(a, b\) => rankOf\(a\.key\) - rankOf\(b\.key\)\)/, '按 rank 排序')
  assert.doesNotMatch(source, /otherActionTiles/, '不再展示表外动作，固定 15 项始终可见')
})

test('顺序表里的 key 都能被固定瓦片生成出来', () => {
  // currency-<id> 来自 RANCH_TODAY_CURRENCIES，action-<key> 来自 RANCH_TODAY_ACTIONS，
  // today-exp 是单独的 expTile。表里写错 key 会让该瓦片静默掉到末尾。
  const currencyIds = [...source.matchAll(/\{ id: (\d+), label:/g)].map(match => `currency-${match[1]}`)
  const actionKeys = [...source.matchAll(/\{ key: '([a-zA-Z]+)', label:/g)].map(match => `action-${match[1]}`)
  const known = new Set([...currencyIds, ...actionKeys, 'today-exp'])

  for (const key of tileOrder()) assert.ok(known.has(key), `${key} 要能对应到实际瓦片`)
  assert.ok(currencyIds.length >= 3, '金券/松果/便便三个货币瓦片都要还在')
  assert.ok(actionKeys.length >= 10, '10 项动作瓦片都要在固定表里')
})

test('动作 key 与后端 recordAction 的命名一致', () => {
  const actionsSource = readFileSync(new URL('../../core/src/services/ranch/actions.ts', import.meta.url), 'utf8')
  const statsSource = readFileSync(new URL('../../core/src/services/ranch/stats.ts', import.meta.url), 'utf8')
  assert.match(actionsSource, /recordAction\(action\)/, '统一入口要按动作名记账')
  assert.match(statsSource, /function recordAction\(action: string\)/, '统计模块要按动作名累加')
  for (const key of ['feed', 'produce', 'harvest', 'release', 'cleanFriend', 'produceFriend'])
    assert.match(source, new RegExp(`key: '${key}', label:`), `缺少动作 ${key}`)
})

test('今日统计不再展示「任务」瓦片', () => {
  assert.ok(!tileOrder().includes('action-claimTasks'), '顺序表里不应再有任务')
  assert.doesNotMatch(source, /key: 'claimTasks', label:/, '固定动作表里不应再有任务')
})
