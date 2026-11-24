import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * 容器部署的一键更新：updater 容器 + docker-update-agent.sh。
 *
 * 这条链路没法在这里真跑一遍 docker（要 daemon、要 NAS、一次构建几分钟），所以拆成两层：
 *   - 静态断言：compose / Dockerfile / 脚本里那些「少一行就废掉」的接线；
 *   - 行为测试：把 git 和 docker 换成假命令，真跑一遍脚本，检查它写出来的作业 JSON
 *     是不是后端 / 面板认得的形状（字段名、状态、日志、心跳）。
 * 行为测试需要 POSIX sh，Windows 上跳过。
 */

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const compose = read('../../docker-compose.yml')
const dockerfile = read('../../core/Dockerfile')
const agent = read('../../scripts/docker-update-agent.sh')
const service = read('../../core/src/services/system-update.ts')

function section(text, start, end) {
  const from = text.indexOf(start)
  assert.ok(from >= 0, `找不到片段 ${start}`)
  const to = end ? text.indexOf(end, from + start.length) : text.length
  return text.slice(from, to >= 0 ? to : text.length)
}

test('compose 里的 updater 是一个独立容器，且默认不启动', () => {
  const updater = section(compose, '  updater:', '\nvolumes:')
  assert.match(updater, /profiles:\s*\["update"\]/, '必须用 profile 门控：挂了 docker.sock 等于宿主机 root')
  assert.match(updater, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/, '要能指挥宿主机 daemon')
  assert.match(updater, /\.:\/project/, '要能 git pull 宿主机那份源码')
  assert.match(updater, /qq-farm-data:\/data/, '和面板交换请求/进度靠这个卷')
  assert.match(updater, /docker-update-agent\.sh/, '入口就是助手脚本')
  assert.match(updater, /cp \/project\/scripts\/docker-update-agent\.sh \/tmp/, '先复制再执行：更新会改写项目目录')
  assert.match(updater, /init:\s*true/, '没有 init 时 docker stop 要等满 10 秒再 SIGKILL')
  assert.match(updater, /restart:\s*unless-stopped/)
  assert.match(updater, /qq-farm-bot-updater/, '容器名固定，面板/文档都按这个名字说事')
})

test('应用容器把更新作业写在数据卷里，重建后还能读回进度', () => {
  assert.match(compose, /FARM_RUNTIME_DIR=\/app\/core\/data\/runtime/, '写容器可写层的作业状态会随重建消失')
  assert.match(service, /FARM_RUNTIME_DIR/, '后端要认这个环境变量')
})

test('镜像运行阶段必须带上 version.json，否则面板只能显示「未知」', () => {
  const runner = section(dockerfile, 'AS runner')
  assert.match(runner, /COPY --from=web-builder \/app\/version\.json/, '运行阶段漏拷 version.json 就是这个 bug 的根因')
  assert.ok(
    runner.indexOf('version.json') > runner.indexOf('COPY --from=web-builder /app/web/dist'),
    'version.json 放最后：版本号每次都变，放前面会让下面所有层缓存失效',
  )
})

test('助手脚本守住几条硬边界', () => {
  assert.match(agent, /GIT_TERMINAL_PROMPT=0/, '容器里没人能敲用户名，必须直接失败')
  assert.match(agent, /safe\.directory/, 'bind mount 属主不是容器用户，不放行就 dubious ownership')
  assert.match(agent, /docker inspect[^\n]*com\.docker\.compose\.project/, 'project 名要从 label 读，不能猜目录名')
  assert.match(agent, /COMPOSE_PROJECT_NAME/, 'project 名不对会另起一套容器并撞 container_name')
  assert.match(agent, /git -C "\$PROJECT_DIR" rev-parse/, '代码没变要能被识别出来')
  assert.match(agent, /跳过重建/, '代码没变时不该白重建一次镜像')
  assert.match(agent, /write_heartbeat/, '心跳是应用判断「能不能一键更新」的唯一依据')
  assert.match(agent, /while kill -0 "\$build_pid"/, '构建期间也要持续写心跳，否则面板会把进行中的作业判死')

  // 危险动作：这些都是「删数据」级别的，脚本里一条都不能有
  const code = agent.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(code, /down -v|--volumes|volume prune|rm -rf|docker system prune/, '助手不得删卷/删数据')
  assert.doesNotMatch(code, /git reset --hard/, '助手只做 fast-forward，不回退用户代码')
  assert.doesNotMatch(code, /git clean/, '不得清理用户工作区')
})

test('助手写出的作业 JSON 与后端 PanelUpdateJobState 同形', () => {
  // 作业 JSON 由 awk 拼出来，键名在脚本里是转义过的 \"key\" 形式
  for (const key of ['id', 'requestId', 'origin', 'action', 'status', 'phase', 'startedAt', 'updatedAt', 'recentLines', 'fromCommit', 'targetCommit'])
    assert.ok(agent.includes(`\\"${key}\\"`), `作业 JSON 缺少字段 ${key}`)
  assert.match(agent, /status == "succeeded" \|\| status == "failed"/, '终态分支')
  assert.match(agent, /finishedAt/, '终态要带 finishedAt')
})

test('后端与脚本对「请求/作业/心跳」的文件名必须完全一致', () => {
  const names = ['update-agent.json', 'update-request.json', 'update-job.json', 'update-job.log']
  for (const name of names) {
    assert.ok(agent.includes(name), `助手脚本没用 ${name}`)
  }
  assert.match(service, /AGENT_HEARTBEAT_FILENAME = 'update-agent\.json'/)
  assert.match(service, /AGENT_REQUEST_FILENAME = 'update-request\.json'/)
  // AGENT_STALE_MS 必须比助手的心跳间隔宽得多，否则构建中会被误判为「助手已停止」
  const stale = Number(/AGENT_STALE_MS = (\d+)/.exec(service)?.[1] || 0)
  assert.ok(stale >= 90000, `判死阈值 ${stale}ms 太紧，构建期间会误杀`)
})

/* ── 行为测试：把 git / docker 换成假命令，真跑一轮脚本 ───────────────────────── */

// 有 POSIX sh 就真跑。Windows 上装了 Git Bash 也能跑；没有就跳过（而不是假装通过）。
const agentPath = fileURLToPath(new URL('../../scripts/docker-update-agent.sh', import.meta.url))
let shellMissing = false
try {
    execFileSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
}
catch {
    shellMissing = true
}
const skipShell = shellMissing ? '当前环境没有 POSIX sh，跳过真跑' : false

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'farm-agent-'))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(root, 'proj'), { recursive: true })
  mkdirSync(join(root, 'data', 'runtime'), { recursive: true })
  writeFileSync(join(bin, 'git'), `#!/bin/sh
STATE="$(dirname "$0")/../state"
case "$*" in
  *"rev-parse --short"*) if [ -f "$STATE" ]; then echo "def5678"; else echo "abc1234"; fi ;;
  *"pull --ff-only"*) echo "Updating abc1234..def5678"; : > "$STATE" ;;
  *"diff --name-only"*) echo "README.md" ;;
  *) exit 0 ;;
esac
`, 'utf8')
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
case "$*" in
  inspect*) echo "qq-farm-bot" ;;
  "compose up -d --build"*) echo "COMPOSE_PROJECT=$COMPOSE_PROJECT_NAME"; echo "Container qq-farm-bot  Started" ;;
  *) : ;;
esac
exit 0
`, 'utf8')
  chmodSync(join(bin, 'git'), 0o755)
  chmodSync(join(bin, 'docker'), 0o755)
  return root
}

function runAgent(root, extraEnv = {}) {
  return execFileSync('sh', [agentPath], {
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      UPDATE_PROJECT_DIR: join(root, 'proj'),
      UPDATE_DATA_DIR: join(root, 'data'),
      UPDATE_ONCE: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function writeRequest(root, id) {
  writeFileSync(join(root, 'data', 'runtime', 'update-request.json'), JSON.stringify({ id, requestedAt: 1 }), 'utf8')
}

function readJob(root) {
  return JSON.parse(readFileSync(join(root, 'data', 'runtime', 'update-job.json'), 'utf8'))
}

test('助手真跑一轮：拉代码 → 重建 → 写出 succeeded 作业与心跳', { skip: skipShell }, () => {
  const root = makeSandbox()
  try {
    writeRequest(root, 'docker_test0001')
    runAgent(root, { UPDATE_COMPOSE_PROJECT: 'qq-farm-bot' })

    const job = readJob(root)
    assert.equal(job.status, 'succeeded')
    assert.equal(job.origin, 'agent')
    assert.equal(job.requestId, 'docker_test0001')
    assert.equal(job.fromCommit, 'abc1234')
    assert.equal(job.targetCommit, 'def5678')
    assert.ok(job.finishedAt > 0)
    assert.ok(job.recentLines.some(line => line.includes('COMPOSE_PROJECT=qq-farm-bot')), 'project 名要带对')
    assert.ok(job.recentLines.some(line => line.includes('重建完成')))

    const heartbeat = JSON.parse(readFileSync(join(root, 'data', 'runtime', 'update-agent.json'), 'utf8'))
    assert.equal(heartbeat.protocol, 1)
    assert.ok(heartbeat.heartbeatAt > 0, '心跳时间戳是判活依据')
    assert.equal(heartbeat.projectDir, join(root, 'proj'))
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('助手真跑一轮：同一个请求不会重复执行', { skip: skipShell }, () => {
  const root = makeSandbox()
  try {
    writeRequest(root, 'docker_test0002')
    runAgent(root, { UPDATE_COMPOSE_PROJECT: 'qq-farm-bot' })
    const first = readFileSync(join(root, 'data', 'runtime', 'update-job.log'), 'utf8')

    runAgent(root, { UPDATE_COMPOSE_PROJECT: 'qq-farm-bot' })
    const second = readFileSync(join(root, 'data', 'runtime', 'update-job.log'), 'utf8')
    assert.equal(second, first, '第二轮不该重跑同一个请求，日志原样保留')
    assert.equal(readJob(root).status, 'succeeded')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('助手真跑一轮：拉取失败要把原因写进作业，且不动服务', { skip: skipShell }, () => {
  const root = makeSandbox()
  try {
    writeFileSync(join(root, 'bin', 'git'), `#!/bin/sh
case "$*" in
  *"rev-parse --short"*) echo "abc1234" ;;
  *"pull --ff-only"*) echo "error: Your local changes would be overwritten"; exit 1 ;;
  *) exit 0 ;;
esac
`, 'utf8')
    chmodSync(join(root, 'bin', 'git'), 0o755)
    writeRequest(root, 'docker_test0003')
    runAgent(root, { UPDATE_COMPOSE_PROJECT: 'qq-farm-bot' })

    const job = readJob(root)
    assert.equal(job.status, 'failed')
    assert.match(job.phase, /拉取代码失败/)
    assert.match(job.error, /git pull --ff-only 失败/)
    assert.ok(!job.recentLines.some(line => line.includes('compose up')), '拉取失败就不该往下重建')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
