import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const source = readFileSync(new URL('../src/components/activity/YishuHuanfuTab.vue', import.meta.url), 'utf8')

test('兑换商店的按钮文案统一为「兑换」，禁用原因只放 title', () => {
  const start = source.indexOf('class="catalog-buy"')
  assert.ok(start > 0, '兑换按钮不存在')
  const close = source.indexOf('</button>', start)
  const button = source.slice(start, close + '</button>'.length)
  assert.match(button, />\s*兑换\s*</, '按钮文字必须固定为「兑换」')
  assert.match(button, /:title="entry\.exchangeable/, '不可兑原因应在 title 里说明')
  assert.doesNotMatch(button, /福气币不足\s*<\/|暂不可兑\s*</, '按钮上不能再出现长短不一的禁用文案')
})

test('兑换卡片用 flex column，按钮贴底且等高对齐', () => {
  const card = source.match(/\.catalog-card \{([\s\S]*?)\}/)
  assert.ok(card, '缺少 .catalog-card 样式')
  assert.match(card[1], /display: flex;/)
  assert.match(card[1], /flex-direction: column;/)

  const buy = source.match(/\.catalog-buy \{([\s\S]*?)\}/)
  assert.ok(buy, '缺少 .catalog-buy 样式')
  assert.match(buy[1], /margin-top: auto;/, '按钮要贴到卡片底部，同行对齐')
  assert.match(buy[1], /min-height:/, '固定最小高度，禁用态也保持一致')
  assert.match(buy[1], /justify-content: center;/)
  assert.match(buy[1], /white-space: nowrap;/, '文案不能换行')
})
