import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const settings = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')

/** 取某个样式规则块（到第一个右花括号为止），允许媒体查询内的缩进。 */
function rule(source, selector) {
  const pattern = new RegExp(`\\n[ \\t]*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\{`)
  const match = pattern.exec(source)
  assert.ok(match, `样式块 ${selector} 不存在`)
  const open = match.index + match[0].length
  return source.slice(match.index, source.indexOf('}', open) + 1)
}

/** 取指定媒体查询的完整内容，用花括号配对避免被内层规则截断。 */
function media(source, query) {
  const start = source.indexOf(query)
  assert.notEqual(start, -1, `媒体查询 ${query} 不存在`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{')
      depth++
    else if (source[i] === '}' && --depth === 0)
      return source.slice(open + 1, i)
  }
  assert.fail(`媒体查询 ${query} 未闭合`)
}

// 手机端设置页顶部的入口网格：9 个入口必须是等宽三列，
// 一旦退回「flex + 内容宽度」，每格宽度就跟标签字数走，三行立刻对不齐。
const phone = media(settings, '@media (max-width: 767px)')

test('手机端设置入口是等宽三列网格，不再由标签字数决定宽度', () => {
  const nav = rule(phone, '.settings-categories')
  assert.match(nav, /display:\s*grid/, '必须用 grid 固定列宽')
  assert.match(nav, /grid-template-columns:\s*repeat\(\s*3\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/, '9 个入口 → 三行三列等宽')
  assert.ok(!/flex-direction|flex-wrap/.test(nav), 'grid 容器上不该残留 flex 换行声明')

  const item = rule(phone, '.settings-category')
  assert.match(item, /flex:\s*none/, '单元格不允许按内容伸缩')
  assert.match(item, /min-width:\s*0/, '没有 min-width:0 时长标签会把列撑开')
  assert.ok(!/justify-content:\s*center/.test(item), '左对齐才和定宽图标配合成一条竖线')
})

test('图标盒定宽，不同粗细的图标文字起点一致', () => {
  const icon = rule(settings, '.settings-category-icon')
  assert.match(icon, /width:\s*18px/)
  assert.match(icon, /height:\s*18px/)
  assert.match(icon, /justify-content:\s*center/, '图标在盒子里居中，视觉重量才均衡')

  const label = rule(settings, '.settings-category-label')
  assert.match(label, /text-overflow:\s*ellipsis/, '窄屏兜底：宁可省略号也不要撑破网格')
})

test('模板给标签套了单独的 span，图标盒与文案分离', () => {
  assert.match(settings, /class="settings-category-icon"\s+:class="tab\.icon"/)
  assert.match(settings, /<span class="settings-category-label">\{\{ tab\.label \}\}<\/span>/)
})

test('320px 窄屏收内边距与图标，五个字的标签不被裁成省略号', () => {
  const narrow = media(settings, '@media (max-width: 359px)')
  const item = rule(narrow, '.settings-category')
  assert.match(item, /padding:\s*8px 4px/, '列宽只有 92px 时必须把横向内边距让出来')
  assert.match(item, /font-size:\s*12px/)

  const icon = rule(narrow, '.settings-category-icon')
  assert.match(icon, /flex-basis:\s*16px/, '图标跟着缩，否则文字区拿不到 60px')
})
