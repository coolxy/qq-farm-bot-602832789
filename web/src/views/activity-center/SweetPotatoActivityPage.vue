<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import { SweetPotatoTab } from '@/components/activity/gameplays/sweetPotato'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore } from '@/stores/activity-center'
import { useActivityClock } from './useActivityClock'

const emit = defineEmits<{ back: [] }>()
const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const { currentAccountId } = storeToRefs(accountStore)
const {
  sweetPotatoDetail,
  sweetPotatoDetailLoading,
  error,
  actionError,
  notice,
  pendingActions,
  sweetPotatoFriendShops,
  sweetPotatoFriendShopsLoading,
  sweetPotatoFriendScanAt,
  sweetPotatoFriendScanNote,
  sweetPotatoRecords,
  sweetPotatoRecordsLoading,
  sweetPotatoRecordsNote,
} = storeToRefs(activityStore)
const { remaining } = useActivityClock()
const remainingText = remaining(computed(() => sweetPotatoDetail.value?.endTime))

const numberFormatter = new Intl.NumberFormat('zh-CN')
function formatNumber(value: string | number | null | undefined) {
  const num = Number(value ?? 0)
  return Number.isFinite(num) ? numberFormatter.format(num) : String(value ?? '0')
}

// 「剩余：14天10小时」→「14 天 10 小时」，与牧歌初启页头同一写法。
const headMeta = computed(() => {
  const raw = String(remainingText.value || '').trim()
  if (!raw || raw === '活动已结束')
    return raw
  return raw.replace(/^剩余[：:]\s*/, '').replace(/(\d+)\s*(天|小时|分钟)/g, '$1 $2 ').trim()
})

function accountId() {
  return String(currentAccountId.value || '')
}
async function refreshActivity() {
  const ok = await activityStore.loadSweetPotatoDetail(accountId())
  // 兑换档位的价格与剩余次数会随当日行情变，刷新时一并重拉 cmd 97，
  // 否则「已加载过」的旧目录会一直挂在界面上。
  activityStore.loadSweetPotatoCatalog(accountId())
  // 收购记录同样不进快照，页头刷新要一起更新，不能只刷余额和行情。
  loadRecords(true)
  return ok
}

// 兑换目录（cmd 97）和本人铺子额度（cmd 92）都不在快照里，进页面各拉一次。
function loadCatalog() {
  const id = accountId()
  if (!id || !sweetPotatoDetail.value || sweetPotatoDetail.value.catalogLoaded)
    return
  activityStore.loadSweetPotatoCatalog(id)
}

function loadShopQuota() {
  const id = accountId()
  if (!id || !sweetPotatoDetail.value || sweetPotatoDetail.value.shop.quota !== null)
    return
  // 静默查额度：进页面自动补齐不该闪刷新按钮的 loading，也不该覆盖已有提示。
  activityStore.loadSweetPotatoShop(id)
}

// 账号切换、或详情首次到位时补一次；已有值时不重复请求。
watch(
  () => [currentAccountId.value, sweetPotatoDetail.value?.activityId, sweetPotatoDetail.value?.catalogLoaded, sweetPotatoDetail.value?.shop.quota],
  () => {
    loadCatalog()
    loadShopQuota()
  },
  { immediate: true },
)

// 活动详情到位后再拉收购记录，避免账号还没切好就发请求。
// 换账号或重新进入页面都必须真拉一次：记录按账号隔离，store 在换号时已清空，
// 这里再用 force 跳过「已加载」守卫，否则会沿用上一个账号的列表。
let recordsAccountId = ''
watch(
  () => [currentAccountId.value, sweetPotatoDetail.value?.activityId],
  () => {
    const id = accountId()
    if (!id)
      return
    const switched = id !== recordsAccountId
    recordsAccountId = id
    loadRecords(switched)
  },
  { immediate: true },
)

async function onSell(payload: { friendGid: string, count: number | null, expectedPrice: number | null }) {
  const id = accountId()
  if (!id)
    return
  // 本地后端卖好友铺子要拿 expectedPrice 与现查价格比对（价变了直接拒绝），
  // 卖给自己没有「对方报价」，传 null 让后端跳过这项校验。
  await activityStore.sellSweetPotato(id, payload.friendGid, payload.count, payload.expectedPrice)
}

// 收购记录（cmd 95）不进快照，进页面拉一次；领完提成、卖完薯都重新拉，保持列表最新。
// 「是否已加载过」的判断交给 store（按账号记账），这里不再用列表长度当守卫——
// 那会把上一个账号残留的记录当成「已加载」，切号后一直显示别人的数据。
function loadRecords(force = false) {
  const id = accountId()
  if (!id)
    return
  activityStore.loadSweetPotatoRecords(id, force)
}

async function onClaimCommission() {
  const id = accountId()
  if (!id)
    return
  const ok = await activityStore.claimSweetPotatoCommission(id)
  if (ok)
    loadRecords(true)
}
</script>

<template>
  <section class="yshf-view">
    <!-- 页头与牧歌初启一致：直接铺在内容区上，不套活动外框。 -->
    <header class="yshf-view__head">
      <div class="yshf-view__lead">
        <NButton quaternary circle title="返回活动列表" aria-label="返回活动列表" @click="emit('back')">
          <template #icon>
            <span class="i-carbon-arrow-left" />
          </template>
        </NButton>
        <!-- 与活动列表卡片共用同一张图标，避免两处图形不一样。 -->
        <img
          src="/activity-assets/yishuhuanfu/icon.png"
          alt=""
          width="32"
          height="32"
          class="yshf-view__icon"
        >
        <div class="yshf-view__text">
          <h1>{{ sweetPotatoDetail?.name || '以薯换福' }}</h1>
          <p v-if="headMeta">
            <span class="i-carbon-time" aria-hidden="true" />{{ headMeta }}
          </p>
        </div>
      </div>
      <div class="yshf-view__actions">
        <div class="yshf-view__balance" title="福气币">
          <img v-if="sweetPotatoDetail?.luckCoin.image" :src="sweetPotatoDetail.luckCoin.image" alt="">
          <b>{{ sweetPotatoDetail?.luckCoinBalanceKnown ? formatNumber(sweetPotatoDetail.luckCoinBalance || '0') : '--' }}</b>
        </div>
        <NButton quaternary circle :loading="sweetPotatoDetailLoading" title="刷新活动数据" aria-label="刷新活动数据" @click="refreshActivity">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </header>

    <div v-if="!currentAccountId" class="yshf-view__state">
      <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
    </div>
    <div v-else-if="sweetPotatoDetailLoading && !sweetPotatoDetail" class="yshf-view__state">
      <span class="yshf-view__spinner" /><strong>正在加载以薯换福</strong>
    </div>
    <template v-else>
      <div
        v-if="error || actionError || notice"
        class="yshf-view__message"
        :class="{ success: notice && !error && !actionError }"
        role="status"
      >
        <span>{{ actionError || error || notice }}</span>
        <button v-if="error" type="button" :disabled="sweetPotatoDetailLoading" @click="refreshActivity">
          重试
        </button>
      </div>
      <SweetPotatoTab
        :activity="sweetPotatoDetail"
        :pending-seed="pendingActions.claimSweetPotatoSeed"
        :pending-sell="pendingActions.sellSweetPotato"
        :pending-share="pendingActions.shareSweetPotatoShop"
        :pending-exchange="pendingActions.exchangeSweetPotatoGoods"
        :pending-quote="pendingActions.refreshSweetPotatoQuote"
        :pending-commission="pendingActions.claimSweetPotatoCommission"
        :friend-shops="sweetPotatoFriendShops"
        :friend-shops-loading="sweetPotatoFriendShopsLoading"
        :friend-scan-at="sweetPotatoFriendScanAt"
        :friend-scan-note="sweetPotatoFriendScanNote"
        :records="sweetPotatoRecords"
        :records-loading="sweetPotatoRecordsLoading"
        :records-note="sweetPotatoRecordsNote"
        @claim-seed="activityStore.claimSweetPotatoSeeds(accountId())"
        @sell="onSell"
        @share="activityStore.shareSweetPotatoShop(accountId())"
        @exchange="(index, count) => activityStore.exchangeSweetPotatoGoods(accountId(), index, count)"
        @scan-friends="(force) => activityStore.scanSweetPotatoFriendShops(accountId(), force)"
        @refresh-shop="loadShopQuota"
        @refresh-quote="activityStore.refreshSweetPotatoQuote(accountId())"
        @claim-commission="onClaimCommission"
        @load-records="activityStore.loadSweetPotatoRecords(accountId(), true)"
      />
    </template>
  </section>
</template>

<style scoped>
/* 页面直接铺在内容区上，与牧歌初启、游戏商城同一种结构：无外框、无阴影。 */
.yshf-view {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 24px;
  /*
   * 本地与 li 版的布局差异只有滚动归属：li 版页面挂在可滚动区里，本地活动详情态
   * 由父级 overflow: hidden 交给页面自管。这里自己开滚动，视觉不变。
   */
  min-height: 0;
  overflow-y: auto;
}

.yshf-view__head {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
}

.yshf-view__lead {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.yshf-view__icon {
  flex: none;
  object-fit: contain;
}

.yshf-view__text {
  min-width: 0;
}

.yshf-view h1 {
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 22px;
  font-weight: var(--fw-700);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.yshf-view__text p {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 2px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
}

.yshf-view__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.yshf-view__balance {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px 0 5px;
  border-radius: 999px;
  color: var(--ui-warning, #b07a32);
  background: var(--ui-warning-soft, #fbf2e3);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.yshf-view__balance img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.yshf-view__state {
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ui-muted);
}

.yshf-view__state strong {
  color: var(--ui-ink);
  font-size: 16px;
}

.yshf-view__spinner {
  width: 36px;
  height: 36px;
  border: 3px solid rgba(67, 141, 99, 0.18);
  border-top-color: var(--ui-primary);
  border-radius: 50%;
  animation: yshf-spin 0.85s linear infinite;
}

.yshf-view__message {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid rgba(201, 95, 102, 0.2);
  border-radius: 10px;
  color: #9a4048;
  background: rgba(250, 233, 234, 0.94);
  font-size: 11px;
}

.yshf-view__message.success {
  border-color: rgba(67, 141, 99, 0.2);
  color: #2e714b;
  background: rgba(228, 241, 231, 0.94);
}

.yshf-view__message button {
  flex: none;
  padding: 3px 8px;
  border: 1px solid currentcolor;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

@keyframes yshf-spin {
  to { transform: rotate(360deg); }
}
</style>
