<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import SweetPotatoTab from '@/components/activity/SweetPotatoTab.vue'
import { useAccountStore } from '@/stores/account'

const emit = defineEmits<{ back: [] }>()
const accountStore = useAccountStore()
const { currentAccountId } = storeToRefs(accountStore)
const tabRef = ref<InstanceType<typeof SweetPotatoTab> | null>(null)
const refreshing = ref(false)

const accountId = computed(() => String(currentAccountId.value || ''))

async function refresh() {
  refreshing.value = true
  try {
    await tabRef.value?.reload()
  }
  finally {
    refreshing.value = false
  }
}
</script>

<template>
  <ActivityShell theme="day">
    <div class="activity-center">
      <ActivityHeader
        title="以薯换福"
        :loading="refreshing"
        show-refresh
        @back="emit('back')"
        @refresh="refresh"
      />
      <main class="activity-content gameplay-content">
        <SweetPotatoTab ref="tabRef" :account-id="accountId" />
      </main>
    </div>
  </ActivityShell>
</template>
