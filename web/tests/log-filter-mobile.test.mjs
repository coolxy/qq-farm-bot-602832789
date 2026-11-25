import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const dashboard = read('../src/views/Dashboard.vue')
const panel = read('../src/components/RunLogPanel.vue')
const card = read('../src/components/RunLogCard.vue')
const overview = read('../src/views/RanchOverview.vue')
const constants = read('../src/constants/log-filters.ts')
const statusStore = read('../src/stores/status.ts')

/** 取某个样式规则块（到第一个右花括号为止）。 */
function rule(source, selector) {
  const start = source.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `样式块 ${selector} 不存在`)
  return source.slice(start, source.indexOf('}', start))
}

/** 取指定 at-rule 的完整内容，用花括号配对避免被内层规则截断。 */
function atRule(source, query) {
  const start = source.lastIndexOf(query)
  assert.notEqual(start, -1, `规则 ${query} 不存在`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{')
      depth++
    else if (source[i] === '}' && --depth === 0)
      return source.slice(open + 1, i)
  }
  assert.fail(`规则 ${query} 未闭合`)
}

// 日志视图统一到 RunLogPanel（上游 #184）：农场概览与牧场面板共用一套，
// 各自只通过 default-module 指定默认筛选，避免两处逻辑再次分叉。

test('农场概览：日志区交给统一日志组件，默认筛选农场', () => {
  assert.match(dashboard, /<RunLogCard[\s\S]{0,200}default-module="farm"/)
  assert.match(dashboard, /import RunLogCard from '@\/components\/RunLogCard\.vue'/)
  // 默认模块由外壳透传给统一日志视图
  assert.match(card, /:default-module="props\.defaultModule"/)
})

test('日志外壳：农场与牧场共用同一套桌面端定高，避免下半部分留白', () => {
  const shell = rule(card, '.dash-logs')
  assert.match(shell, /position:\s*relative/, '外壳需建立定位上下文')
  assert.match(shell, /min-height:/, '外壳需有最小高度兜底')
  const inner = rule(card, '.dash-logs__card')
  assert.match(inner, /position:\s*absolute/, '卡片绝对定位才不会被内容高度左右')
  assert.match(inner, /inset:\s*0/, '卡片铺满外壳')

  // 两侧都挂在外壳上：农场传 farm、牧场走默认 ranch
  assert.match(dashboard, /<RunLogCard/)
  assert.match(overview, /<RunLogCard \/>/)
  assert.match(card, /defaultModule: 'ranch'/)
})

test('农场概览：旧内联日志实现已彻底移除，不留半套逻辑', () => {
  for (const symbol of ['displayLogs', 'filteredLogs', 'visibleLogs', 'formatLogTimeRange', 'getEventLabel', 'const logLevels = [', 'class="log-filters"']) {
    assert.ok(!dashboard.includes(symbol), `Dashboard 仍残留旧日志实现：${symbol}`)
  }
  // 日志拉取也归组件：页面里不该再出现 fetchLogs
  assert.ok(!dashboard.includes('fetchLogs'), 'Dashboard 不应再自己拉日志')
})

test('牧场面板：RunLogCard 只是 RunLogPanel 的牧场壳', () => {
  assert.match(overview, /<RunLogCard \/>/)
  assert.match(card, /import RunLogPanel from '@\/components\/RunLogPanel\.vue'/)
  assert.match(card, /defaultModule: 'ranch'/)
  // 壳里不该再有自己的筛选/聚合实现
  assert.ok(!card.includes('computed('), 'RunLogCard 应保持为纯包装')
})

test('统一日志组件：一级/二级模块 + 事件 + 级别 + 关键词 + 搜索清空齐全', () => {
  assert.match(panel, /v-model="filter\.module"[\s\S]{0,60}:options="modules"/)
  assert.match(panel, /v-model="filter\.submodule"[\s\S]{0,60}:options="submoduleOptions"/)
  assert.match(panel, /v-model="filter\.event"[\s\S]{0,60}:options="events"/)
  assert.match(panel, /v-model="filter\.level"[\s\S]{0,60}:options="levels"/)
  assert.match(panel, /v-model="filter\.keyword"/)
  assert.match(panel, /title="搜索日志"/)
  assert.match(panel, /title="清空日志"/)
  // 当前筛选条件以胶囊形式展示，可单条移除
  assert.match(panel, /activeFilterChips/)
  assert.match(panel, /function removeFilter/)
})

test('统一日志组件：×N 可展开明细，且提供回到最新按钮', () => {
  assert.match(panel, /class="log-row__repeat"/)
  assert.match(panel, /@click="toggleGroup\(group\.uid\)"/)
  assert.match(panel, /run-log-expanded/)
  assert.match(panel, /run-log-to-latest/)
})

test('筛选区窄屏两列、宽屏五列 + 按钮列', () => {
  const filters = rule(panel, '.run-log-filters')
  assert.match(filters, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '窄屏两列')

  const wide = atRule(panel, '@media (min-width: 640px)')
  assert.match(wide, /grid-template-columns:\s*repeat\(5, minmax\(0, 8rem\)\) auto/, '宽屏五列筛选 + 按钮')
  assert.match(wide, /\.run-log-filters__buttons[\s\S]*?grid-column:\s*auto/)

  const buttons = rule(panel, '.run-log-filters__buttons')
  assert.match(buttons, /grid-column:\s*1 \/ -1/, '窄屏按钮独占一行')
})

test('日志行窄屏折成两列，正文整行铺满', () => {
  const row = rule(panel, '.log-row')
  assert.match(row, /grid-template-columns:\s*auto auto minmax\(0, 1fr\)/)

  const phone = atRule(panel, '@media (max-width: 640px)')
  assert.match(phone, /\.log-row[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\)/)
  assert.match(phone, /\.log-row__body[\s\S]*?grid-column:\s*1 \/ -1/)
})

// 手机端两个首页的日志区必须定高内滚：父级高度全是内容驱动，
// 只给 max-height 的话 overflow:visible 的内容会一路外溢（实测 300 条日志把页面撑到 12000px+），
// 而父级高度是被 max-height 夹出来的、不是 definite，子元素的 height:100% 会退化成 auto。
test('手机端日志区定高内滚，不随日志条数把页面撑高', () => {
  const phone = atRule(panel, '@media (max-width: 767px)')
  // 确定高度必须落在滚动本体上（它没有别的工具类抢高度）
  assert.match(phone, /\.run-log-scroll\s*\{\s*height:\s*var\(--run-log-mobile-height/, '确定高度要写在滚动本体上')
  assert.ok(
    !/\.run-log-list\s*\{[^}]*[{};]\s*height:\s*var\(--run-log-mobile-height/.test(phone),
    '父级高度不是 definite，写在 .run-log-list 上会让子元素的 100% 退化成 auto',
  )
  assert.match(phone, /\.run-log-list\s*\{[\s\S]*?flex:\s*0 0 auto/, '移动端不再让日志区参与 flex 分配')
  assert.match(phone, /\.run-log-list\s*\{[\s\S]*?max-height:\s*var\(--run-log-mobile-height/, '外层再兜一层上限')
  assert.match(phone, /\.run-log-list\s*\{[\s\S]*?overflow:\s*hidden/, '溢出一律裁掉，不许外溢')

  // 滚动容器仍然是内部的列表本体
  const scroll = rule(panel, '.run-log-scroll')
  assert.match(scroll, /height:\s*100%/)
  assert.match(scroll, /overflow-y:\s*auto/)
  assert.match(scroll, /overscroll-behavior:\s*contain/, '滚到底不把滚动链传给页面')

  // 外壳与页面都不该再靠 max-h 兜高度
  assert.ok(!card.includes('max-h-['), 'RunLogCard 不应再用 max-h 声明日志高度')
  assert.ok(!/list-class="[^"]*max-h-\[/.test(dashboard), 'Dashboard 不应再给日志区传 max-h')
  assert.ok(!/list-class="[^"]*max-h-\[/.test(overview), '牧场概览不应再给日志区传 max-h')
})

test('模块常量：好友/仓库降为农场子模块，一级模块不再单列', () => {
  assert.match(constants, /export const LOG_MODULES/)
  assert.ok(!/label: '好友'/.test(constants.slice(constants.indexOf('LOG_MODULES'), constants.indexOf('SUBMODULES_BY_PARENT'))), '好友应作为子模块')
  assert.match(constants, /farm:\s*\[[\s\S]*?value: 'friend'[\s\S]*?value: 'warehouse'/)
  assert.match(constants, /ranch:\s*\[[\s\S]*?value: 'friend'/)
  // 农场一级模块要一次把降级的 friend/warehouse 都拉回来，否则子模块筛选拿不到数据
  assert.match(constants, /farm:\s*'farm,friend,warehouse'/)
})

test('缓存冗余 500 行，聚合后再截断', () => {
  assert.match(constants, /export const LOG_CACHE_LIMIT = 500/)
  assert.match(statusStore, /logs\.value\.length > LOG_CACHE_LIMIT/)
  assert.match(panel, /limit: LOG_CACHE_LIMIT/)
})

test('筛选启用时不被 WS 全量快照覆盖', () => {
  const start = statusStore.indexOf('function handleRealtimeLogsSnapshot')
  assert.ok(start >= 0, '应存在快照处理函数')
  const body = statusStore.slice(start, start + 600)
  assert.match(body, /if \(!realtimeLogsEnabled\.value\)\s+return/, '筛选期间暂停实时日志，快照也必须跳过')
})

test('展示前剥掉后端「同样状态重复 N 次」后缀，避免与 ×N 双重计数', () => {
  assert.match(statusStore, /const MERGED_SUFFIX_RE = \/（同样状态重复 \\d\+ 次，已合并）\\s\*\$/)
  assert.match(statusStore, /msg: typeof entry\.msg === 'string' \? entry\.msg\.replace\(MERGED_SUFFIX_RE, ''\)/)
})
