import api from '@/api'

/**
 * 在线更新与版本回滚的类型与接口封装。
 *
 * 单独成文件而不是塞进 `api/index.ts`：那块是全局 axios 实例与错误归一化，
 * 这里只描述这一个功能的契约，store 与组件都从这里取类型。
 */

export interface IncomingCommitInfo {
  hash: string
  shortHash: string
  subject: string
  author: string
  timestampMs: number
}

export interface PanelUpdateJobState {
  id: string
  action: 'update' | 'rollback' | 'snapshot'
  pid?: number
  status: 'running' | 'succeeded' | 'failed'
  phase: string
  detail?: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  exitCode?: number | null
  error?: string
  fromCommit?: string
  targetCommit?: string
  releaseId?: string
  recentLines: string[]
}

export interface ReleaseCompatInfo {
  compatible: boolean
  outdated: boolean
  reasons: string[]
}

export interface RollbackReleaseItem {
  releaseId: string
  kind: 'backend' | 'web'
  createdAt: number
  commit: string
  shortCommit: string
  commitSubject: string
  version: string
  build: number
  pairedReleaseId: string
  sizeBytes: number
  isActive: boolean
  isPrevious: boolean
  canRollback: boolean
  canDelete: boolean
  compat: ReleaseCompatInfo
}

export interface ReleasesSummary {
  totalCount: number
  rollbackableCount: number
  incompatibleCount: number
  totalSizeBytes: number
  incompatibleSizeBytes: number
  orphanWebCount: number
  orphanSizeBytes: number
  activeBackendId: string
  activeWebId: string
  activeVersion: string
  activeBuild: number
}

/** 远端版本信息：容器/打包部署没有 git，靠读远端 version.json 比对版本号。 */
export interface RemoteVersionInfo {
  repo: string
  branch: string
  version: string
  build: number
  summary: string
  commit: string
  updatedAt: string
}

/** 宿主机更新助手：容器部署下一键更新的执行者（独立容器，挂着 docker.sock）。 */
export interface DockerUpdateAgentStatus {
  available: boolean
  startedAt: number | null
  heartbeatAt: number | null
  projectDir: string
  protocol: number
  heartbeatFile: string
  reason: string
}

export interface SystemUpdateStatus {
  mode: 'source' | 'docker' | 'packaged' | 'unknown'
  gitSupported: boolean
  unsupportedReason: string
  applySupported: boolean
  applyUnsupportedReason: string
  repoRoot: string
  branch: string
  detached: boolean
  commit: string
  shortCommit: string
  commitSubject: string
  startupCommit: string
  needsApply: boolean
  upstream: string
  remote: string
  remoteBranch: string
  behindCount: number
  aheadCount: number
  dirtyFiles: string[]
  incomingCommits: IncomingCommitInfo[]
  canCheck: boolean
  canPull: boolean
  canApply: boolean
  jobBusy: boolean
  lastCheckedAt: number | null
  lastCheckError: string
  lastPulledAt: number | null
  job: PanelUpdateJobState | null
  releases: RollbackReleaseItem[]
  releasesSummary: ReleasesSummary | null
  webBuildId: string
  webVersion: string

  /** 本地版本（仓库根 version.json，缺失时退到前端构建产物里的版本）。 */
  localVersion: string
  localBuild: number
  /** 远端版本；没查过时为 null。 */
  remoteVersion: RemoteVersionInfo | null
  /** 远端确实比本地新（按 build 号优先比较）。 */
  hasNewVersion: boolean
  remoteCheckedAt: number | null
  remoteCheckError: string
  /** 容器部署时给用户在宿主机执行的命令；其它模式为空串。 */
  deployCommand: string
  /** 容器部署时在宿主机启用更新助手的命令；其它模式为空串。 */
  agentEnableCommand: string
  /** 宿主机更新助手状态；非容器模式下 available 恒为 false。 */
  dockerAgent: DockerUpdateAgentStatus
  /** 前端构建产物记录的构建次数，版本号兜底用。 */
  webBuild: number
}

export async function fetchSystemUpdateStatus(): Promise<SystemUpdateStatus> {
  const res = await api.get('/api/system-update/status')
  return res.data?.data
}

export async function fetchSystemUpdateJob(): Promise<{ job: PanelUpdateJobState | null, log: string }> {
  const res = await api.get('/api/system-update/job')
  return res.data?.data || { job: null, log: '' }
}
