<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import SweetPotatoTab from '@/components/activity/SweetPotatoTab.vue'
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

const accountId = computed(() => String(currentAccountId.value || ''))

/**
 * 页头刷新：详情、兑换目录、收购记录三块都要重拉。
 *
 * 目录（cmd 97）与记录（cmd 95）都不在活动快照里，只刷详情的话，
 * 用户看到的还是上一次的价格与进度。
 */
async function refreshActivity() {
  const id = accountId.value
  if (!id)
    return false
  const ok = await activityStore.loadSweetPotatoDetail(id)
  activityStore.loadSweetPotatoCatalog(id)
  loadRecords(true)
  return ok
}

/** 兑换目录（cmd 97）不在快照里，进页面自动拉一次；已加载过就不重复打请求。 */
function loadCatalog() {
  const id = accountId.value
  if (!id || !sweetPotatoDetail.value || sweetPotatoDetail.value.catalogLoaded)
    return
  activityStore.loadSweetPotatoCatalog(id)
}

/** 本人铺子额度（cmd 92）同样不在快照里：没有值时自动补一次。 */
function loadShopQuota() {
  const id = accountId.value
  if (!id || !sweetPotatoDetail.value || sweetPotatoDetail.value.shop.quota !== null)
    return
  activityStore.refreshSweetPotatoQuote(id)
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

/**
 * 收购记录按账号隔离：store 在换号时已清空，这里再用 force 跳过「已加载」守卫，
 * 否则切号后会一直显示上一个账号的记录。
 */
let recordsAccountId = ''
watch(
  () => [currentAccountId.value, sweetPotatoDetail.value?.activityId],
  () => {
    const id = accountId.value
    if (!id)
      return
    const switched = id !== recordsAccountId
    recordsAccountId = id
    loadRecords(switched)
  },
  { immediate: true },
)

function loadRecords(force = false) {
  const id = accountId.value
  if (!id)
    return
  activityStore.loadSweetPotatoRecords(id, force)
}

async function onSell(payload: { friendGid: string, count: number | null, expectedPrice: number | null }) {
  const id = accountId.value
  if (!id)
    return
  // 卖完额度与比价都会变，store 内部已经在成功后补刷，这里不用再拉一遍。
  await activityStore.sellSweetPotato(id, payload.friendGid, payload.count, payload.expectedPrice)
}

async function onClaimCommission() {
  const id = accountId.value
  if (!id)
    return
  const ok = await activityStore.claimSweetPotatoCommission(id)
  if (ok)
    loadRecords(true)
}
</script>

<template>
  <ActivityShell theme="day">
    <div class="activity-center">
      <ActivityHeader
        title="以薯换福"
        :remaining="remainingText"
        :balance="sweetPotatoDetail?.luckCoinBalanceKnown ? (sweetPotatoDetail.luckCoinBalance || '0') : '--'"
        :currency-image="sweetPotatoDetail?.luckCoin.image"
        currency-name="福气币"
        :loading="sweetPotatoDetailLoading"
        show-refresh
        @back="emit('back')"
        @refresh="refreshActivity"
      />
      <div v-if="!currentAccountId" class="activity-state detail-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="sweetPotatoDetailLoading && !sweetPotatoDetail" class="activity-state detail-state">
        <div class="activity-spinner" /><strong>正在加载以薯换福</strong>
      </div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status">
          <span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="sweetPotatoDetailLoading" @click="refreshActivity">
            重试
          </button>
        </div>
        <main class="activity-content gameplay-content">
          <SweetPotatoTab
            :key="`sweet-potato-${currentAccountId}`"
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
            @claim-seed="activityStore.claimSweetPotatoSeeds(accountId)"
            @sell="onSell"
            @share="activityStore.shareSweetPotatoShop(accountId)"
            @exchange="(index, count) => activityStore.exchangeSweetPotatoGoods(accountId, index, count)"
            @scan-friends="(force) => activityStore.scanSweetPotatoFriendShops(accountId, force)"
            @refresh-shop="loadShopQuota"
            @refresh-quote="activityStore.refreshSweetPotatoQuote(accountId)"
            @claim-commission="onClaimCommission"
            @load-records="activityStore.loadSweetPotatoRecords(accountId, true)"
          />
        </main>
      </template>
    </div>
  </ActivityShell>
</template>
