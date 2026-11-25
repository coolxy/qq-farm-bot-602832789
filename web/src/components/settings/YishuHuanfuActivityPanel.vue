<script setup lang="ts">
import { computed } from 'vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

const automation = defineModel<any>('automation', { required: true })

// 出售时间：30 分钟一档，空串 = 不限。到点之后每一轮自动任务都会按原逻辑卖，
// 不是一次性定时任务，所以不需要秒级精度，也不存在调度卡点失败的问题。
const sellTimeOptions = computed(() => {
  const options: Array<{ label: string, value: string }> = [
    { label: '不限时段（随时可卖）', value: '' },
  ]
  for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
    const label = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    options.push({ label, value: label })
  }
  return options
})

const enabled = computed(() => automation.value.automation.yishu_enabled !== false)
</script>

<template>
  <section
    class="min-w-0 border border-gray-100 rounded-lg p-4 space-y-3 dark:border-gray-700"
    aria-label="以薯换福活动自动化"
  >
    <div class="space-y-1">
      <h3 class="text-base text-gray-900 font-semibold dark:text-gray-100">
        以薯换福
      </h3>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        领种子 / 分享 / 收提成都是「服务端说能做」才发一次写，卖薯先比价再卖。
      </p>
    </div>

    <div class="automation-setting-item">
      <BaseSwitch v-model="automation.automation.yishu_enabled" label="启用以薯换福自动任务" />
    </div>

    <div v-if="enabled" class="space-y-4">
      <div>
        <div class="mb-2 text-sm text-gray-800 font-medium dark:text-gray-200">
          每日种子与暴击
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div class="automation-setting-item">
            <BaseSwitch v-model="automation.automation.yishu_claim_seed" label="每日领取红薯种子" />
          </div>
          <div class="automation-setting-item">
            <BaseSwitch v-model="automation.automation.yishu_share" label="每日触发分享暴击" />
          </div>
        </div>
      </div>

      <div>
        <div class="mb-2 text-sm text-gray-800 font-medium dark:text-gray-200">
          小铺提成
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div class="automation-setting-item">
            <BaseSwitch v-model="automation.automation.yishu_claim_commission" label="定时领取小铺提成" />
          </div>
          <BaseInput
            v-model.number="automation.automation.yishu_commission_interval_hours"
            label="提成领取间隔 (小时)"
            type="number"
            min="1"
            max="48"
          />
        </div>
      </div>

      <div>
        <div class="mb-2 text-sm text-gray-800 font-medium dark:text-gray-200">
          好友比价与出售
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div class="automation-setting-item">
            <BaseSwitch v-model="automation.automation.yishu_scan_enabled" label="定时比较好友收购价" />
          </div>
          <BaseInput
            v-model.number="automation.automation.yishu_scan_interval_hours"
            label="比价间隔 (小时)"
            type="number"
            min="1"
            max="48"
          />
          <div class="automation-setting-item">
            <BaseSwitch v-model="automation.automation.yishu_auto_sell" label="晚间卖给价更高的好友" />
          </div>
          <BaseSelect
            v-model="automation.automation.yishu_sell_after_time"
            label="出售时间"
            :options="sellTimeOptions"
          />
          <BaseInput
            v-model.number="automation.automation.yishu_sell_min_gain"
            label="至少比自家高 (福气币/个)"
            type="number"
            min="0"
            max="100000"
          />
          <BaseInput
            v-model.number="automation.automation.yishu_sell_keep_count"
            label="保留蜜薯数量 (个)"
            type="number"
            min="0"
            max="100000"
          />
        </div>
      </div>

      <div class="rounded-lg bg-gray-50 p-3 space-y-3 dark:bg-gray-800/60">
        <div class="text-sm text-gray-800 font-medium dark:text-gray-200">
          比价范围与兜底
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BaseInput
            v-model.number="automation.automation.yishu_scan_friend_limit"
            label="参与比价的好友数上限"
            type="number"
            min="1"
            max="200"
          />
          <BaseInput
            v-model.number="automation.automation.yishu_sell_min_count"
            label="起卖数量 (个)"
            type="number"
            min="1"
            max="10000"
          />
        </div>
        <BaseSwitch v-model="automation.automation.yishu_sell_fallback_own" label="好友铺子都收满时，剩下的卖给自己铺子" />
      </div>
    </div>

    <p class="text-xs text-gray-500 dark:text-gray-400">
      10 分钟检查一次：今日还没领种子、还没分享才各发一次写，服务端已经标记过的只按天记一行跳过日志。提成按「提成领取间隔」节流，间隔内有余额也先不动。
      背包蜜薯达到「起卖数量」才进入比价：先扣掉「保留蜜薯数量」，再要求好友价格至少比自家高「至少比自家高」个福气币，
      比价（cmd 92 逐个查铺子）按「比价间隔」节流，间隔内复用上一轮的排序；关闭「定时比较好友收购价」后不再扫好友，只卖自己铺子。
    </p>
    <p class="text-xs text-gray-500 dark:text-gray-400">
      「出售时间」不是精准卡点：选了 23:00，就是过了 23:00 之后每一轮自动任务（10 分钟一次）都按同样的逻辑卖，
      等晚一点的好处是好友当天基本都分享过、暴击加成已经加上、价格排在前面；代价是高价铺子的额度可能被别人先吃满，届时会按价格往下找。留空表示不限时段。
    </p>
  </section>
</template>

<style scoped>
/* 与自动化设置页保持同一套开关行样式（那边是 scoped，这里必须自带一份）。 */
.automation-setting-item {
  display: flex;
  min-height: 42px;
  align-items: center;
  padding: 9px 11px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
}
</style>
