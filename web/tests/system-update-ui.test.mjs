import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

/**
 * 版本与更新面板的接线护栏。
 *
 * 这条链路有个特点：真正验证要「点一下更新」，代价是拉代码 + 构建 + 重启，
 * 端到端跑一次太贵。所以把不会变的部分用静态断言钉住：
 *   - 设置页确实挂了入口，面板文件确实存在
 *   - 面板把「服务重启期间请求失败」当成等待而不是错误（否则整段时间满屏红字）
 *   - 构建产物里带 buildId，前端才能判断自己是不是旧 bundle
 */

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const settings = read('src/views/Settings.vue')
const panel = read('src/components/settings/VersionUpdatePanel.vue')
const store = read('src/stores/app-update.ts')
const api = read('src/api/system-update.ts')
const viteConfig = read('vite.config.ts')

test('设置页挂了「版本与更新」入口', () => {
  assert.match(settings, /key: 'system-update'/, '标签列表里要有 system-update')
  assert.match(settings, /VersionUpdatePanel/, '要引入并渲染面板组件')
  assert.match(settings, /activeTab === 'system-update'/, '要按 activeTab 渲染')
  // 类型与 key 列表必须同步，否则 storage 里存过的旧值会被当成非法标签丢掉。
  assert.match(settings, /'system-update'/, 'SettingsTab 类型要包含新标签')
})

test('面板区分「服务重启中」与「请求失败」', () => {
  assert.match(panel, /store\.reconnecting/, '要把重连状态单独显示')
  assert.match(panel, /服务正在重启/, '要给出人话提示，别让人以为更新挂了')
})

test('store 的轮询把网络错误当成等待，而不是失败', () => {
  const block = store.match(/async function refreshJob\(\)[\s\S]*?\n {2}\}/)
  assert.ok(block, '要有 refreshJob')
  assert.match(block[0], /catch \{/, '网络错误要单独 catch')
  assert.match(block[0], /reconnecting\.value = true/, '失败时标记为重连中而不是报错')
  assert.ok(!/error\.value = getApiErrorMessage/.test(block[0]), '轮询失败不能污染 error，否则会满屏红字')
})

test('轮询有总时限，不会永远转圈', () => {
  assert.match(store, /JOB_POLL_TIMEOUT_MS/, '要有轮询总时限常量')
  assert.match(store, /等待更新结果超时/, '超时要有明确文案')
})

test('面板过期判定用构建指纹，而不是版本号', () => {
  assert.match(store, /__APP_BUILD_ID__/, '要读构建时烘焙的指纹')
  assert.match(store, /webBuildId/, '要和后端报告的构建号比较')
  assert.match(panel, /stalePanel/, '面板要据此提示刷新')
})

test('回滚必须二次确认，且不兼容时要额外确认', () => {
  assert.match(panel, /askConfirm\('回滚到此版本'/, '回滚要走确认弹窗')
  assert.match(panel, /confirmIncompatible/, '不兼容版本要带二次确认标记')
})

test('接口封装与后端路由一一对应', () => {
  for (const endpoint of [
    '/api/system-update/status',
    '/api/system-update/check',
    '/api/system-update/apply',
    '/api/system-update/rollback',
    '/api/system-update/job',
    '/api/system-update/releases/delete',
  ]) {
    assert.ok(api.includes(endpoint) || store.includes(endpoint), `前端没有调用 ${endpoint}`)
  }
})

test('vite 构建产出 version.json，供后端判断「服务器上是哪份前端」', () => {
  assert.match(viteConfig, /version\.json/, '构建要写 version\.json')
  assert.match(viteConfig, /buildId/, '要写 buildId')
  assert.match(viteConfig, /__APP_BUILD_ID__/, '要把 buildId 烘焙进 bundle')
})

test('容器部署：助手在跑就显示「立即更新」，不在就给出启用命令', () => {
  // 以前容器模式只有一个灰按钮加一句「去宿主机执行命令」。有更新助手（updater 容器）
  // 时，点一下就该能更新；没有时要说清怎么启用，而不是把用户挡在门外。
  assert.match(panel, /!store\.isDocker \|\| store\.agentAvailable/, '助手在跑时容器模式也要有按钮')
  assert.match(panel, /store\.agentEnableCommand/, '要给出启用助手的命令')
  assert.match(panel, /store\.deployCommand/, '手动重建命令仍然保留')
  assert.match(panel, /agentAvailable \? '已就绪' : '未启用'/, '要有状态标记')
  assert.match(store, /agentAvailable/, 'store 要暴露助手状态')
  assert.match(store, /return agentAvailable\.value/, '容器模式能不能点，取决于助手在不在')
  assert.match(api, /dockerAgent: DockerUpdateAgentStatus/, '类型里要有助手状态')
  assert.match(api, /agentEnableCommand: string/)
})

test('版本号兜底：容器里读不到 version.json 也不显示「未知」', () => {
  // 镜像运行阶段漏拷 version.json 时，「当前运行版本」会退成「未知」。
  // 后端退到 web/dist/version.json，前端再兜一层。
  assert.match(panel, /store\.status\?\.localVersion \|\| store\.status\?\.webVersion/, '前端要有第二条兜底')
  assert.match(api, /webBuild: number/, '构建次数也要能兜底')
  assert.match(store, /info\?\.localBuild \|\| info\?\.webBuild/, '版本标签同样兜底')
})

test('容器部署不展示「历史版本」——归档是源码部署才有的东西', () => {
  assert.match(panel, /v-if="!store\.isDocker" class="farm-card/, '容器里没有 releases 归档，别给空列表')
})
