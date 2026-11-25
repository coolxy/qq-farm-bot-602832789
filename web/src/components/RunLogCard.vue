<script setup lang="ts">
import RunLogPanel from '@/components/RunLogPanel.vue'

// 农场 / 牧场首页共用的日志卡片外壳：
// 桌面端由父行高撑开（min-height 兜底），卡片绝对定位铺满，避免下半部分留白；
// 移动端退回普通文档流，列表高度由 RunLogPanel 内的媒体查询定死并自己滚动
// （这里不要再传 max-h-*，max-height 裁不住 overflow:visible 的内容，日志会外溢撑高页面）。
const props = withDefaults(defineProps<{
  defaultModule?: string
  maxLogs?: number
  levelInSignature?: boolean
  listClass?: string
  minHeight?: number
}>(), {
  defaultModule: 'ranch',
  maxLogs: 300,
  levelInSignature: true,
  listClass: 'min-h-0 flex-1',
  minHeight: 480,
})
</script>

<template>
  <div class="dash-logs flex flex-1 flex-col gap-6 md:w-3/4" :style="{ '--dash-logs-min-height': `${props.minHeight}px` }">
    <div class="dash-logs__card flex flex-1 flex-col farm-card rounded-2xl bg-white p-5 shadow-md md:overflow-hidden dark:bg-gray-800">
      <RunLogPanel
        :default-module="props.defaultModule"
        :max-logs="props.maxLogs"
        :level-in-signature="props.levelInSignature"
        :list-class="props.listClass"
      />
    </div>
  </div>
</template>

<style scoped>
@media (min-width: 768px) {
  .dash-logs {
    position: relative;
    min-height: var(--dash-logs-min-height, 480px);
  }

  .dash-logs__card {
    position: absolute;
    inset: 0;
  }
}
</style>
