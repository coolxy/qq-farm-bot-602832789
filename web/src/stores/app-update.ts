import type {
  PanelUpdateJobState,
  RollbackReleaseItem,
  SystemUpdateStatus,
} from '@/api/system-update'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { fetchSystemUpdateJob, fetchSystemUpdateStatus } from '@/api/system-update'

/**
 * 在线更新与版本回滚的状态机。
 *
 * 这里最麻烦的不是「调接口」，而是**服务会在更新过程中把自己杀掉**：
 * 轮询请求会连续失败几秒到几分钟，然后恢复。所以轮询逻辑不能一遇错就判失败，
 * 而是把网络错误当成「服务正在重启」继续等，只有超过总时限才判超时。
 */

/** 轮询总时限：构建 + 重启在这个项目里最慢见过 4 分半。 */
const JOB_POLL_TIMEOUT_MS = 12 * 60 * 1000
const JOB_POLL_INTERVAL_MS = 2000

/** 自己的构建指纹，由 vite 在打包时烘焙进来。 */
const selfBuildId = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : ''

export const useAppUpdateStore = defineStore('app-update', () => {
  const status = ref<SystemUpdateStatus | null>(null)
  const job = ref<PanelUpdateJobState | null>(null)
  const jobLog = ref('')
  const loading = ref(false)
  const acting = ref(false)
  const error = ref('')
  /** 服务正在重启：接口暂时打不通，界面要显示「等待服务回来」而不是报错。 */
  const reconnecting = ref(false)
  const lastRefresh = ref(0)

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollDeadline = 0

  const releases = computed<RollbackReleaseItem[]>(() => status.value?.releases || [])
  const summary = computed(() => status.value?.releasesSummary || null)
  const jobRunning = computed(() => job.value?.status === 'running')
  const hasIncoming = computed(() => (status.value?.behindCount || 0) > 0)
  const dirtyCount = computed(() => status.value?.dirtyFiles?.length || 0)

  /**
   * 容器部署：版本由镜像决定，重建只能发生在宿主机。
   * 面板要按这套语义换一套说法，而不是继续展示 git 部署的「落后几个提交」。
   */
  const isDocker = computed(() => status.value?.mode === 'docker')
  const canCheck = computed(() => Boolean(status.value?.canCheck) && !acting.value && !jobRunning.value)
  /** 远端确实比本地新（容器里靠它判断要不要提示重建）。 */
  const hasNewVersion = computed(() => Boolean(status.value?.hasNewVersion))
  const remoteInfo = computed(() => status.value?.remoteVersion || null)
  /** 宿主机重建命令，只在容器模式下有值。 */
  const deployCommand = computed(() => status.value?.deployCommand || '')
  /** 在宿主机启用更新助手的命令，只在容器模式下有值。 */
  const agentEnableCommand = computed(() => status.value?.agentEnableCommand || '')
  /**
   * 宿主机更新助手在不在。
   *
   * 容器里没法自己重建自己，一键更新靠的是这个独立容器。它不在时按钮就该禁用并把
   * 启用方式摆出来，而不是给一个点了报错的按钮。
   */
  const dockerAgent = computed(() => status.value?.dockerAgent || null)
  const agentAvailable = computed(() => Boolean(dockerAgent.value?.available))
  const localVersionLabel = computed(() => {
    const info = status.value
    const version = info?.localVersion || info?.webVersion || ''
    if (!version)
      return ''
    const build = info?.localBuild || info?.webBuild || 0
    return build ? `v${version}（第 ${build} 次更新）` : `v${version}`
  })

  /**
   * 服务器上的前端构建号与当前页面不一致 —— 说明页面里跑的是旧 bundle，
   * 需要提示刷新，否则用户会觉得「更新完了怎么什么都没变」。
   */
  const stalePanel = computed(() => {
    const remote = status.value?.webBuildId || ''
    return Boolean(remote && selfBuildId && remote !== selfBuildId)
  })

  const canApply = computed(() => {
    if (!status.value)
      return false
    if (!status.value.applySupported || status.value.jobBusy || acting.value)
      return false
    // 容器模式没有 git、也没有「落后几个提交」，能更新与否只取决于更新助手在不在。
    // 「远端有没有新版本」不在这里拦：更新自己会先查一次，没新版本会明确告诉用户。
    if (isDocker.value)
      return agentAvailable.value
    if (dirtyCount.value > 0)
      return false
    if (status.value.behindCount > 0 || status.value.needsApply)
      return true
    // 从没检查过远端：behindCount 是本地缓存的远端引用，可能早就过期了。
    // 「一键更新」自己会先 fetch 再判断，所以这里放行，别让用户卡在假的最新年份上。
    return status.value.lastCheckedAt == null
  })

  const canRollback = computed(() => releases.value.some(item => item.canRollback))

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  async function refreshStatus(): Promise<SystemUpdateStatus | null> {
    loading.value = true
    try {
      const data = await fetchSystemUpdateStatus()
      status.value = data
      job.value = data.job || job.value
      error.value = ''
      reconnecting.value = false
      lastRefresh.value = Date.now()
      return data
    }
    catch (e: any) {
      error.value = getApiErrorMessage(e, '读取更新状态失败')
      return null
    }
    finally {
      loading.value = false
    }
  }

  async function refreshJob(): Promise<PanelUpdateJobState | null> {
    try {
      const data = await fetchSystemUpdateJob()
      job.value = data.job
      jobLog.value = data.log || ''
      reconnecting.value = false
      return data.job
    }
    catch {
      // 服务正在重启，接口必然打不通；这不是失败，等下一轮。
      reconnecting.value = true
      return null
    }
  }

  /**
   * 轮询作业进度直到出结果。
   *
   * 三种终止条件：作业结束、超过总时限、调用方主动停（stopPolling）。
   * 中间的请求失败一律忽略——那正是服务被重启的正常表现。
   */
  function pollJob() {
    stopPolling()
    pollDeadline = Date.now() + JOB_POLL_TIMEOUT_MS

    const tick = async () => {
      pollTimer = null
      const current = await refreshJob()
      if (current && current.status !== 'running') {
        await refreshStatus()
        return
      }
      if (Date.now() > pollDeadline) {
        reconnecting.value = false
        error.value = '等待更新结果超时，请刷新页面查看当前版本。'
        return
      }
      pollTimer = setTimeout(tick, JOB_POLL_INTERVAL_MS)
    }

    pollTimer = setTimeout(tick, JOB_POLL_INTERVAL_MS)
  }

  async function check() {
    acting.value = true
    try {
      const data = await api.post('/api/system-update/check').then(r => r.data?.data)
      if (data)
        status.value = data
      return true
    }
    catch (e: any) {
      error.value = getApiErrorMessage(e, '检查更新失败')
      return false
    }
    finally {
      acting.value = false
    }
  }

  async function applyUpdate() {
    acting.value = true
    error.value = ''
    try {
      const data = await api
        .post('/api/system-update/apply', { pullFirst: true }, { skipErrorToast: true } as any)
        .then(r => r.data?.data)
      job.value = data?.job || null
      if (data?.status)
        status.value = data.status
      pollJob()
      return true
    }
    catch (e: any) {
      error.value = getApiErrorMessage(e, '启动更新失败')
      return false
    }
    finally {
      acting.value = false
    }
  }

  async function rollback(releaseId: string, confirmIncompatible = false) {
    acting.value = true
    error.value = ''
    try {
      const data = await api
        .post('/api/system-update/rollback', { releaseId, confirmIncompatible }, { skipErrorToast: true } as any)
        .then(r => r.data?.data)
      job.value = data?.job || null
      if (data?.status)
        status.value = data.status
      pollJob()
      return true
    }
    catch (e: any) {
      error.value = getApiErrorMessage(e, '启动回滚失败')
      return false
    }
    finally {
      acting.value = false
    }
  }

  async function removeReleases(releaseIds: string[]) {
    acting.value = true
    try {
      await api.post('/api/system-update/releases/delete', { releaseIds })
      await refreshStatus()
      return true
    }
    catch (e: any) {
      error.value = getApiErrorMessage(e, '删除版本失败')
      return false
    }
    finally {
      acting.value = false
    }
  }

  async function cleanOrphans() {
    acting.value = true
    try {
      await api.post('/api/system-update/releases/delete', { cleanOrphans: true })
      await refreshStatus()
      return true
    }
    catch (e: any) {
      error.value = getApiErrorMessage(e, '清理孤儿版本失败')
      return false
    }
    finally {
      acting.value = false
    }
  }

  function dismissJob() {
    stopPolling()
    job.value = null
    jobLog.value = ''
    error.value = ''
    reconnecting.value = false
  }

  /** 刷新页面拿新 bundle。只有构建号真的变了才需要。 */
  function reloadPanel() {
    window.location.reload()
  }

  return {
    status,
    job,
    jobLog,
    loading,
    acting,
    error,
    reconnecting,
    lastRefresh,
    releases,
    summary,
    jobRunning,
    hasIncoming,
    dirtyCount,
    stalePanel,
    isDocker,
    canCheck,
    hasNewVersion,
    remoteInfo,
    deployCommand,
    agentEnableCommand,
    dockerAgent,
    agentAvailable,
    localVersionLabel,
    canApply,
    canRollback,
    selfBuildId,
    refreshStatus,
    refreshJob,
    pollJob,
    stopPolling,
    check,
    applyUpdate,
    rollback,
    removeReleases,
    cleanOrphans,
    dismissJob,
    reloadPanel,
  }
})
