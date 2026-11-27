// 以薯换福活动页的滚动归属：详情态下外层内容区是 overflow:hidden，
// 纵向滚动必须由页面根容器自己承担，否则超出一屏的内容会被直接裁掉（表现为滑不动）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const read = rel => fs.readFileSync(path.join(webRoot, rel), 'utf8').replace(/\r\n/g, '\n')

function ruleBody(css, selector) {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `缺少样式规则：${selector}`)
  const end = css.indexOf('}', start)
  assert.ok(end > start, `样式规则未闭合：${selector}`)
  return css.slice(start + selector.length, end)
}

test('活动详情态的外层内容区不自管滚动', () => {
  const css = read('src/layouts/DefaultLayout.vue')
  const body = ruleBody(css, '.farm-page-content.is-activity-detail')
  assert.match(body, /overflow:\s*hidden/)
})

test('以薯换福页面根容器是滚动容器', () => {
  const css = read('src/views/activity-center/YishuHuanfuActivityPage.vue')
  const body = ruleBody(css, '.yshf-view')
  assert.match(body, /overflow-y:\s*auto/, '.yshf-view 必须自己纵向滚动')
  assert.match(body, /min-height:\s*0/, '必须允许收缩到 0，否则高度不受限、滚不出来')
  assert.match(body, /flex:\s*1/, '要占满外层 flex 剩余高度')
})

test('滚动容器内的 flex 子项不被压扁', () => {
  const css = read('src/views/activity-center/YishuHuanfuActivityPage.vue')
  const body = ruleBody(css, '.yshf-view > *')
  assert.match(body, /flex:\s*none/, '子项收缩会把内容挤扁而不是撑出滚动高度')
})
