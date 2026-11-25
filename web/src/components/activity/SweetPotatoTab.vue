<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'

interface SweetPotatoShop {
  hostGid: string
  name: string
  avatarUrl: string
  price: number | null
  remaining: number | null
  unlimited?: boolean
  canSell?: boolean | null
  basePrice?: number
  bonusPrice?: number
  checkedAt: number
  available: boolean
  error: string
}

interface SweetPotatoGoods {
  index: number
  itemId: string
  name: string
  nameKnown: boolean
  price: string
  status: number
  limit: number
  exchangedToday: number
  image: string
  exchangeable: boolean
}

interface SweetPotatoRecord {
  timestamp: number
  gid: string
  name: string
  avatarUrl: string
  level: number
  count: number
  total: number
  commission: number
}

interface SweetPotatoActivity {
  title: string
  active: boolean
  seedClaimed: boolean
  shareClaimed: boolean
  basePrice: number
  bonusPrice: number
  price: number
  coins: number
  capacity: number
  pendingCommission: number
  commissionClaimable: boolean
  seeds: number
  honey: number
  coinsInBag: number
  startTime: number
  endTime: number
  rules: string[]
  actions: Record<string, { enabled: boolean, available: boolean }>
}

const props = defineProps<{ accountId: string }>()

const activity = ref<SweetPotatoActivity | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')

const shops = ref<SweetPotatoShop[]>([])
const shopsLoading = ref(false)
const shopsTotal = ref(0)
const shopsOffset = ref(0)
const shopsHasMore = ref(false)
const shopsOpen = ref(false)
/** page = 按好友顺序分页查询；scan = 一次扫完并按收购价排序。 */
const shopsMode = ref<'page' | 'scan'>('page')
const scanMessage = ref('')

const records = ref<SweetPotatoRecord[]>([])
const recordsLoading = ref(false)
const recordsOpen = ref(false)
const recordsMessage = ref('')
const recordsTotal = ref(0)

const catalog = ref<SweetPotatoGoods[]>([])
const catalogLoading = ref(false)
const catalogMessage = ref('')
const catalogOpen = ref(false)
const catalogCounts = ref<Record<number, number>>({})

const sellTarget = ref<SweetPotatoShop | null>(null)
const sellCount = ref(1)

const honey = computed(() => Number(activity.value?.honey || 0))
const canSell = computed(() => !!activity.value?.active && honey.value > 0)
const pendingCommission = computed(() => Number(activity.value?.pendingCommission || 0))
const maxSellForTarget = computed(() => {
  if (!sellTarget.value)
    return honey.value
  // 自家铺子不占好友额度，上限只看背包。
  if (sellTarget.value.unlimited)
    return honey.value
  const remaining = Number(sellTarget.value.remaining || 0)
  return Math.max(0, Math.min(honey.value, remaining))
})
const estimatedIncome = computed(() => {
  const target = sellTarget.value
  if (!target?.price)
    return 0
  return Math.max(0, Math.min(Number(sellCount.value) || 0, maxSellForTarget.value)) * target.price
})

function accountHeaders() {
  return { 'x-account-id': props.accountId, 'skipErrorToast': true } as any
}

function messageOf(err: any) {
  return String(err?.response?.data?.error || err?.message || '操作失败，请稍后重试')
}

function requestId() {
  const random = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}-${random}`
}

async function load() {
  if (!props.accountId)
    return
  loading.value = true
  error.value = ''
  try {
    const response = await api.get('/api/activity-center/sweet-potato', accountHeaders())
    activity.value = response.data?.data || null
    if (sellTarget.value)
      sellCount.value = Math.max(1, Math.min(sellCount.value, maxSellForTarget.value || 1))
  }
  catch (err: any) {
    error.value = messageOf(err)
  }
  finally {
    loading.value = false
  }
}

async function act(action: string, payload: Record<string, unknown> = {}) {
  if (!props.accountId || busy.value)
    return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const response = await api.post(`/api/activity-center/sweet-potato/${action}`, payload, accountHeaders())
    const data = response.data?.data || {}
    notice.value = String(data.message || '操作完成')
    if (data.activity)
      activity.value = data.activity
    else
      await load()
    if (action === 'sell') {
      sellTarget.value = null
      if (shopsMode.value === 'scan')
        await scanShops()
      else
        await loadShops(true)
    }
    if (action === 'exchange')
      await loadCatalog()
    if (action === 'commission')
      await load()
  }
  catch (err: any) {
    error.value = messageOf(err)
  }
  finally {
    busy.value = false
  }
}

async function loadShops(reset = false) {
  if (!props.accountId || shopsLoading.value)
    return
  shopsLoading.value = true
  error.value = ''
  try {
    const offset = reset ? 0 : shopsOffset.value
    const response = await api.get(`/api/activity-center/sweet-potato/shops?offset=${offset}`, accountHeaders())
    const data = response.data?.data || {}
    const page = Array.isArray(data.shops) ? data.shops : []
    shops.value = reset ? page : [...shops.value, ...page]
    shopsTotal.value = Number(data.total) || 0
    shopsOffset.value = Number(data.nextOffset) || shops.value.length
    shopsHasMore.value = !!data.hasMore
    shopsOpen.value = true
    shopsMode.value = 'page'
    scanMessage.value = ''
  }
  catch (err: any) {
    error.value = messageOf(err)
  }
  finally {
    shopsLoading.value = false
  }
}

/** 一键比价：一次扫完全部好友铺子（含自家），按成交价从高到低给出排序。 */
async function scanShops() {
  if (!props.accountId || shopsLoading.value)
    return
  shopsLoading.value = true
  error.value = ''
  try {
    const response = await api.get('/api/activity-center/sweet-potato/scan', accountHeaders())
    const data = response.data?.data || {}
    shops.value = Array.isArray(data.shops) ? data.shops : []
    shopsTotal.value = shops.value.length
    shopsHasMore.value = false
    shopsOffset.value = shops.value.length
    shopsOpen.value = true
    shopsMode.value = 'scan'
    scanMessage.value = String(data.message || '')
  }
  catch (err: any) {
    error.value = messageOf(err)
  }
  finally {
    shopsLoading.value = false
  }
}

/** 收购记录（cmd 95）：好友把蜜薯卖进自己铺子产生的分红明细。 */
async function loadRecords() {
  if (!props.accountId || recordsLoading.value)
    return
  recordsLoading.value = true
  try {
    const response = await api.get('/api/activity-center/sweet-potato/records', accountHeaders())
    const data = response.data?.data || {}
    records.value = Array.isArray(data.records) ? data.records : []
    recordsTotal.value = Number(data.count) || records.value.length
    recordsMessage.value = String(data.message || '')
    recordsOpen.value = true
  }
  catch (err: any) {
    recordsMessage.value = messageOf(err)
  }
  finally {
    recordsLoading.value = false
  }
}

async function loadCatalog() {
  if (!props.accountId || catalogLoading.value)
    return
  catalogLoading.value = true
  try {
    const response = await api.get('/api/activity-center/sweet-potato/shop-catalog', accountHeaders())
    const data = response.data?.data || {}
    catalog.value = Array.isArray(data.goods) ? data.goods : []
    catalogMessage.value = String(data.message || '')
    catalogOpen.value = true
    const next: Record<number, number> = {}
    for (const goods of catalog.value)
      next[goods.index] = catalogCounts.value[goods.index] || 1
    catalogCounts.value = next
  }
  catch (err: any) {
    catalogMessage.value = messageOf(err)
  }
  finally {
    catalogLoading.value = false
  }
}

function catalogCount(index: number) {
  return Math.max(1, Number(catalogCounts.value[index]) || 1)
}

function catalogCost(goods: SweetPotatoGoods) {
  return Number(goods.price || 0) * catalogCount(goods.index)
}

async function exchangeGoods(goods: SweetPotatoGoods) {
  await act('exchange', { index: goods.index, count: catalogCount(goods.index) })
}

function openSell(shop: SweetPotatoShop) {
  if (!shop.available || !shop.price)
    return
  sellTarget.value = shop
  const limit = shop.unlimited ? honey.value : Number(shop.remaining) || 1
  sellCount.value = Math.max(1, Math.min(honey.value, limit))
}

async function confirmSell() {
  const target = sellTarget.value
  if (!target)
    return
  const count = Math.max(1, Math.min(Number(sellCount.value) || 1, maxSellForTarget.value || 1))
  await act('sell', { hostGid: target.hostGid, count, expectedPrice: target.price, requestId: requestId() })
}

function sellToSelf() {
  sellTarget.value = null
  return act('sell', {})
}

function formatTime(value: number) {
  if (!value)
    return '--'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

watch(() => props.accountId, () => {
  activity.value = null
  shops.value = []
  shopsMode.value = 'page'
  scanMessage.value = ''
  records.value = []
  recordsOpen.value = false
  recordsMessage.value = ''
  catalog.value = []
  catalogCounts.value = {}
  sellTarget.value = null
  load()
}, { immediate: false })

defineExpose({ reload: load })

onMounted(load)
</script>

<template>
  <section class="sweet-potato">
    <div v-if="!accountId" class="sp-state">
      <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
    </div>
    <div v-else-if="loading && !activity" class="sp-state">
      <strong>正在加载以薯换福</strong><span>读取活动状态与背包</span>
    </div>

    <template v-else>
      <div v-if="error || notice" class="sp-message" :class="{ success: notice && !error }" role="status">
        <span>{{ error || notice }}</span>
        <button v-if="error" type="button" :disabled="loading" @click="load">
          重试
        </button>
      </div>

      <div v-if="activity && !activity.active" class="sp-state">
        <strong>活动未开放</strong>
        <span>{{ formatTime(activity.startTime) }} 至 {{ formatTime(activity.endTime) }}</span>
      </div>

      <template v-else-if="activity">
        <div class="sp-overview">
          <div class="sp-metric">
            <span class="sp-metric-label">当前收购价</span>
            <strong class="sp-metric-value">{{ activity.price }}</strong>
            <span class="sp-metric-hint">基础 {{ activity.basePrice }}<template v-if="activity.bonusPrice"> + 暴击 {{ activity.bonusPrice }}</template></span>
          </div>
          <div class="sp-metric">
            <span class="sp-metric-label">福气币</span>
            <strong class="sp-metric-value">{{ activity.coins }}</strong>
            <span class="sp-metric-hint">背包 {{ activity.coinsInBag }}</span>
          </div>
          <div class="sp-metric">
            <span class="sp-metric-label">蜜薯库存</span>
            <strong class="sp-metric-value">{{ activity.honey }}</strong>
            <span class="sp-metric-hint">红薯种子 {{ activity.seeds }}</span>
          </div>
          <div class="sp-metric">
            <span class="sp-metric-label">剩余收购量</span>
            <strong class="sp-metric-value">{{ activity.capacity }}</strong>
            <span class="sp-metric-hint">截至 {{ formatTime(activity.endTime) }}</span>
          </div>
          <div class="sp-metric" :class="{ highlight: pendingCommission > 0 }">
            <span class="sp-metric-label">待领提成</span>
            <strong class="sp-metric-value">{{ pendingCommission }}</strong>
            <span class="sp-metric-hint">{{ pendingCommission > 0 ? '好友收购分红' : '暂无可领' }}</span>
          </div>
        </div>

        <div class="sp-actions">
          <button type="button" class="sp-btn" :disabled="busy || !activity.actions?.claim?.available" @click="act('claim')">
            {{ activity.seedClaimed ? '今日种子已领' : '领取每日种子' }}
          </button>
          <button type="button" class="sp-btn" :disabled="busy || !activity.actions?.share?.available" @click="act('share')">
            {{ activity.shareClaimed ? '今日暴击已触发' : '分享暴击涨价' }}
          </button>
          <button type="button" class="sp-btn primary" :disabled="busy || !canSell" @click="sellToSelf">
            一键卖给自己铺子
          </button>
          <button type="button" class="sp-btn" :disabled="busy || !pendingCommission" @click="act('commission')">
            {{ pendingCommission ? `领取提成 ${pendingCommission}` : '暂无提成' }}
          </button>
        </div>

        <div class="sp-panel">
          <header class="sp-panel-head">
            <div>
              <strong>好友铺子收购价</strong>
              <span v-if="shopsMode === 'scan' && shops.length">已按收购价排序（{{ shops.length }} 个铺子）</span>
              <span v-else-if="shopsTotal">已查询 {{ shops.length }} / {{ shopsTotal }}</span>
            </div>
            <div class="sp-panel-tools">
              <button type="button" class="sp-link" :disabled="shopsLoading" @click="scanShops">
                {{ shopsMode === 'scan' ? '重新比价' : '一键比价' }}
              </button>
              <button type="button" class="sp-link" :disabled="shopsLoading" @click="loadShops(true)">
                {{ shopsMode === 'page' && shopsOpen ? '刷新价格' : '分页查询' }}
              </button>
              <button v-if="shopsHasMore && shopsMode === 'page'" type="button" class="sp-link" :disabled="shopsLoading" @click="loadShops(false)">
                {{ shopsLoading ? '查询中…' : '继续加载' }}
              </button>
            </div>
          </header>

          <p v-if="shopsMode === 'scan' && scanMessage" class="sp-empty">
            {{ scanMessage }}
          </p>
          <p v-else-if="!shopsOpen" class="sp-empty">
            「一键比价」会扫一遍好友铺子并按成交价排序（受设置页「比价好友数上限」限制）；「分页查询」每页 5 家、价格缓存 30 秒，适合好友很多时慢慢看。出售前都会再复核一次价格与余量。
          </p>
          <p v-else-if="!shops.length" class="sp-empty">
            没有可查询的好友铺子。
          </p>

          <ul v-else class="sp-shops">
            <li v-for="shop in shops" :key="shop.hostGid" class="sp-shop" :class="{ disabled: !shop.available }">
              <div class="sp-shop-main">
                <strong>{{ shop.name }}</strong>
                <span v-if="shop.available">收购价 {{ shop.price }}（基础 {{ shop.basePrice }} + 暴击 {{ shop.bonusPrice }}）</span>
                <span v-else class="sp-shop-error">{{ shop.error || '暂不可用' }}</span>
              </div>
              <div class="sp-shop-side">
                <span v-if="shop.available">{{ shop.unlimited ? '还可收 不限' : `余量 ${shop.remaining}` }}</span>
                <button type="button" class="sp-link" :disabled="busy || !shop.available || !honey" @click="openSell(shop)">
                  出售
                </button>
              </div>
            </li>
          </ul>

          <div v-if="sellTarget" class="sp-sell">
            <div class="sp-sell-head">
              <strong>向「{{ sellTarget.name }}」出售蜜薯</strong>
              <button type="button" class="sp-link" @click="sellTarget = null">
                取消
              </button>
            </div>
            <div class="sp-sell-row">
              <label>
                数量
                <input v-model.number="sellCount" type="number" min="1" :max="maxSellForTarget" inputmode="numeric">
              </label>
              <span class="sp-sell-max">最多 {{ maxSellForTarget }}</span>
              <button type="button" class="sp-link" @click="sellCount = maxSellForTarget">
                全部
              </button>
            </div>
            <div class="sp-sell-row">
              <span>预计收入 <strong>{{ estimatedIncome }}</strong> 福气币</span>
              <button type="button" class="sp-btn primary" :disabled="busy || !estimatedIncome" @click="confirmSell">
                确认出售
              </button>
            </div>
            <p class="sp-sell-hint">
              提交前会重新读取库存、铺子身份、当前价格与收购余量；价格或额度变化会中止本次出售。
            </p>
          </div>
        </div>

        <div class="sp-panel">
          <header class="sp-panel-head">
            <div>
              <strong>兑换商店</strong>
              <span>福气币兑换活动商品</span>
            </div>
            <button type="button" class="sp-link" :disabled="catalogLoading" @click="loadCatalog">
              {{ catalogOpen ? '刷新目录' : '查看目录' }}
            </button>
          </header>
          <p v-if="catalogLoading" class="sp-empty">
            正在读取兑换商店…
          </p>
          <p v-else-if="catalogOpen && !catalog.length" class="sp-empty">
            {{ catalogMessage || '商店目录为空' }}
          </p>
          <ul v-else-if="catalog.length" class="sp-shops">
            <li v-for="goods in catalog" :key="goods.index" class="sp-shop">
              <div class="sp-shop-main">
                <strong>{{ goods.name }}</strong>
                <span>
                  {{ goods.price }} 福气币 / 个 · 限购 {{ goods.limit || '不限' }}
                  <template v-if="goods.exchangedToday"> · 已兑 {{ goods.exchangedToday }}</template>
                </span>
                <span v-if="!goods.nameKnown" class="sp-shop-error">该档价格与本地配置不一致，请以实际到手道具为准</span>
              </div>
              <div class="sp-shop-side">
                <input
                  v-model.number="catalogCounts[goods.index]"
                  class="sp-shop-count"
                  type="number"
                  min="1"
                  :max="goods.limit || undefined"
                  inputmode="numeric"
                >
                <button
                  type="button"
                  class="sp-link"
                  :disabled="busy || !activity.actions?.exchange?.available || !goods.exchangeable"
                  @click="exchangeGoods(goods)"
                >
                  兑换 {{ catalogCost(goods) }}
                </button>
              </div>
            </li>
          </ul>
        </div>

        <div class="sp-panel">
          <header class="sp-panel-head">
            <div>
              <strong>收购记录</strong>
              <span v-if="recordsOpen && recordsTotal">最近 {{ records.length }} 条</span>
              <span v-else>好友把蜜薯卖进你铺子的分红明细</span>
            </div>
            <button type="button" class="sp-link" :disabled="recordsLoading" @click="loadRecords">
              {{ recordsLoading ? '读取中…' : (recordsOpen ? '刷新记录' : '查看记录') }}
            </button>
          </header>
          <p v-if="recordsOpen && !records.length" class="sp-empty">
            {{ recordsMessage || '暂无收购记录' }}
          </p>
          <ul v-else-if="records.length" class="sp-records">
            <li v-for="record in records" :key="`${record.gid}-${record.timestamp}-${record.count}`" class="sp-record">
              <div class="sp-record-main">
                <strong>{{ record.name || record.gid }}</strong>
                <span>收购 {{ record.count }} 个 · 支付 {{ record.total }} 福气币</span>
              </div>
              <div class="sp-record-side">
                <span class="sp-record-commission">+{{ record.commission }}</span>
                <span>{{ formatTime(record.timestamp) }}</span>
              </div>
            </li>
          </ul>
        </div>

        <details v-if="activity.rules?.length" class="sp-rules">
          <summary>活动规则</summary>
          <p v-for="line in activity.rules" :key="line">
            {{ line }}
          </p>
        </details>
      </template>
    </template>
  </section>
</template>

<style scoped>
.sweet-potato {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--ui-ink, #2b2b2b);
}

.sp-state {
  display: grid;
  gap: 6px;
  padding: 28px 20px;
  text-align: center;
  border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.08));
  border-radius: 16px;
  background: var(--ui-surface, rgba(255, 255, 255, 0.7));
}

.sp-state strong {
  font-size: 15px;
}

.sp-state span {
  font-size: 13px;
  opacity: 0.7;
}

.sp-message {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 13px;
  border-radius: 12px;
  color: #8a3b2e;
  background: rgba(214, 106, 84, 0.12);
}

.sp-message.success {
  color: #2f6b4f;
  background: rgba(84, 168, 122, 0.14);
}

.sp-message button {
  flex: none;
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.sp-overview {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.sp-metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.08));
  border-radius: 14px;
  background: var(--ui-surface, rgba(255, 255, 255, 0.72));
}

.sp-metric.highlight {
  border-color: rgba(198, 122, 43, 0.45);
  background: rgba(198, 122, 43, 0.1);
}

.sp-metric-label {
  font-size: 12px;
  opacity: 0.65;
}

.sp-metric-value {
  font-size: 22px;
  line-height: 1.1;
}

.sp-metric-hint {
  font-size: 11px;
  opacity: 0.6;
}

.sp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.sp-btn {
  min-height: 38px;
  padding: 0 16px;
  font-size: 13px;
  border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.12));
  border-radius: 999px;
  background: var(--ui-surface, rgba(255, 255, 255, 0.8));
  color: inherit;
  cursor: pointer;
}

.sp-btn.primary {
  border-color: transparent;
  background: #d97746;
  color: #fff;
}

.sp-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sp-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.08));
  border-radius: 16px;
  background: var(--ui-surface, rgba(255, 255, 255, 0.7));
}

.sp-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.sp-panel-head > div {
  display: grid;
  gap: 3px;
}

.sp-panel-head span {
  font-size: 12px;
  opacity: 0.65;
}

.sp-panel-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.sp-link {
  padding: 0;
  font-size: 12px;
  border: 0;
  background: none;
  color: #b4632f;
  cursor: pointer;
}

.sp-link:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sp-empty {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.7;
}

.sp-shops {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sp-shop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.03);
}

.sp-shop.disabled {
  opacity: 0.6;
}

.sp-shop-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.sp-shop-main strong {
  font-size: 13px;
}

.sp-shop-main span {
  font-size: 11px;
  opacity: 0.7;
}

.sp-shop-error {
  color: #a4523f;
}

.sp-shop-side {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  font-size: 11px;
  opacity: 0.85;
}

.sp-records {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sp-record {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.03);
}

.sp-record-main,
.sp-record-side {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.sp-record-main strong {
  font-size: 12px;
}

.sp-record-main span,
.sp-record-side span {
  font-size: 11px;
  opacity: 0.7;
}

.sp-record-side {
  justify-items: end;
  flex: none;
}

.sp-record-commission {
  color: #2f6b4f;
  font-weight: 600;
  opacity: 1 !important;
}

.sp-shop-count {
  width: 64px;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  background: var(--ui-surface, rgba(255, 255, 255, 0.9));
  color: inherit;
}

.sp-sell {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px dashed rgba(180, 99, 47, 0.45);
  border-radius: 12px;
}

.sp-sell-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.sp-sell-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}

.sp-sell-row label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sp-sell-row input {
  width: 84px;
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.16));
  border-radius: 8px;
  background: var(--ui-surface, #fff);
  color: inherit;
}

.sp-sell-max {
  opacity: 0.6;
}

.sp-sell-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  opacity: 0.6;
}

.sp-rules {
  padding: 12px 14px;
  font-size: 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.03);
}

.sp-rules summary {
  cursor: pointer;
  font-weight: 600;
}

.sp-rules p {
  margin: 8px 0 0;
  line-height: 1.7;
  opacity: 0.75;
}

@media (max-width: 1180px) {
  .sp-overview {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 767px) {
  .sp-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .sp-actions .sp-btn {
    flex: 1 1 45%;
  }

  .sp-shop {
    align-items: flex-start;
    flex-direction: column;
  }

  .sp-shop-side {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
