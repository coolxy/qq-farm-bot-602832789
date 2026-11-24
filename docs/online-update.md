# 面板在线更新与版本回滚

设置页 → 「版本与更新」里可以在浏览器里完成三件事：检查远端有没有新提交、一键拉取并重建重启、回退到任意一次历史构建。本文说明它怎么工作、边界在哪、出问题怎么救。

## 1. 为什么不是上游那套

上游 `liyangpengs/qq-farm-bot` 的 PR #181 / #182 也做了这件事，但它的实现绑在**会话宿主架构**上：`packages/session-contract` 提供 IPC 协议与进程锁，`tools/service-control.mjs` 负责启停托管，游戏会话跑在独立进程里，所以「后端重启但玩家不掉线」成立。

本项目已经有自己的连接宿主（见 [socket-host.md](socket-host.md)），启动链是 `start.sh` → `node core/client.js`，用 `version.json` + git hooks 管版本。把上游整套搬进来等于换掉部署方式，收益（热重启不掉线）和风险（两套宿主抢 WS 会话）不成比例。

所以这里只提取「更新与回滚」这件事本身，**不引入任何新的进程架构**：

```
面板点击 → 后端 spawn(detached) → tools/farm-release.mjs → git pull → start.sh 重建重启
                                      ↑
                            它必须活得比后端久
```

## 2. 参与的四样东西

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `release-layout.js` | `core/src/services/` | 纯 CommonJS 零依赖。归档目录命名、快照、恢复、清理、激活状态。后端与执行器**共用这一份** |
| `release-store.ts` | `core/src/services/` | 只读查询层：后端/前端配对、与当前客户端版本的兼容性、总览统计 |
| `system-update.ts` | `core/src/services/` | 环境探测、git 检查/拉取、作业状态机、把执行器拉起来、回滚前置校验 |
| `farm-release.mjs` | `tools/` → `core/runtime/runner/` | 真正干活的执行器。`update` / `rollback` / `snapshot` 三个命令 |

执行器必须是独立 `.mjs`，不能编进 `core/dist`：更新时 `core/dist` 正在被整个覆盖；回滚时源码还会 `git reset` 回旧提交。它不能依赖任何正在被替换的东西。

**而且它不能住在会被 `git reset` 改动的地方。** 回滚到「这个功能还不存在」的版本时，`git reset` 会把 `tools/farm-release.mjs` 从磁盘删掉——执行器在半路上把自己删了，剩下的重启步骤就没人做。实测踩过一次：`git reset` 之后下一次调用直接 `Cannot find module ...tools/farm-release.mjs`。

所以：

1. 后端拉起前先把它和 `release-layout.js` 复制到 `core/runtime/runner/`（`.gitignore` 里，git 不碰）；
2. 真正被 spawn 的是副本，副本里两个文件并排放着，连工作树都不再依赖；
3. 手动在 `tools/` 下直接跑它时，会先自举到副本再从副本重跑一次，然后才干活。

副作用是好事：万一面板自己坏了，`node core/runtime/runner/farm-release.mjs rollback --release <id>` 仍然能把服务救回来。

## 3. 目录布局

```
<repo>/releases/
  backend-20261124044746-e686e1d/{release-meta.json, client.js, dist/}
  web-20261124044746-e686e1d/{release-meta.json, dist/}
<repo>/core/runtime/
  active-releases.json   # { backend: {active, previous, history}, web: {...} }
  update-job.json        # 作业状态（面板轮询读它）
  update-job.log         # 执行器完整日志
  update.lock            # 发布互斥（当前未使用，保留给外部脚本）
  runner/                # 执行器稳定副本（farm-release.mjs + release-layout.js）
  trash/                 # 恢复产物时的临时暂存（正常情况下一闪而过）
```

- 目录名 = `<kind>-<UTC 时间戳>-<短提交>`。**同一次构建的后端与前端共用同一个时间戳**，配对就靠这个后缀；跨秒拍摄的历史归档按提交号兜底配对。
- 两个目录都写进了 `.gitignore`。不忽略的话「工作区必须干净」这条前置检查永远过不去。
- `release-meta.json` 自带版本号、提交号与体积。回滚**只读它，不执行快照里的代码**。
- 默认保留最近 3 份（`FARM_RELEASES_KEEP`），运行中与上一版永不自动清理。一份约 47 MB（后端 6 MB + 前端 41 MB）。

## 4. 更新流程

1. 归档当前产物（回滚点）
2. `git pull --ff-only`
3. 依赖清单（`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`）有变化才 `pnpm install --frozen-lockfile`
4. 停服 → `bash start.sh`（它自己按 mtime 判断要重建前端还是后端，装完就拉起新进程）
5. 归档新产物，更新 `active-releases.json`，清理超出保留份数的旧版本

失败时**自动回滚**：`git reset --hard` 回原提交 → 恢复旧产物 → 再次 `start.sh`，然后把失败原因写进作业状态。

> 宁可「更新没成功但服务还在」，不要「更新没成功且服务已停」。后者在无人的 NAS 上就是彻底停摆。

## 5. 回滚流程

1. 归档当前产物（保证回滚本身可逆）
2. `git reset --hard <归档记录的提交>`
3. 把归档产物覆盖回 `core/dist`、`core/client.js`、`web/dist`（配套前端一起）
4. 停服 → `bash start.sh`

不重新构建，几十秒完成。这句话不是修辞，靠两件事保证：

- 恢复时先把目标目录改名挪进 `core/runtime/trash/` 再整目录复制（不是逐个文件删），几千个文件也是瞬间完成；
- 复制完把产物的 mtime 显式刷成当前时间。否则 Windows 上 `fs.cpSync` 会保留源文件时间（`CopyFileW` 的行为，POSIX 上不保留），产物看起来比刚 checkout 的源码还旧，`start.sh` 就会判定「需要重建」并白跑一遍构建。

注意 `version.json` 会跟着 `git reset` 一起退回——**版本号会短暂回退，下次更新会重新升上去**，这是刻意的：让源码树保持干净比让版本号单调更重要。

执行器不受第 2 步影响：它跑在 `core/runtime/runner/` 的副本里，`git reset` 之后照常把第 4 步做完。

前置拒绝条件（任何一条都会明确报错而不是硬来）：

- 工作区有未提交改动 → `DIRTY_WORKTREE`
- 当前分支有**未推送**的本地提交 → `AHEAD_OF_UPSTREAM`（回滚会丢掉它们）
- 目标提交已不在本地仓库 → `COMMIT_MISSING`（先 fetch）
- 选了当前正在运行的版本 / 归档不完整 → `RELEASE_NOT_ROLLBACKABLE`
- 目标不是后端归档 → `WRONG_RELEASE_KIND`（前端必须跟随配套后端）
- 与当前客户端版本不兼容 → `RELEASE_INCOMPATIBLE`，面板二次确认后可继续

## 6. 停服为什么要按进程组

后端会 `fork` 出连接宿主子进程（`core/src/host/`）。只对父进程发 `SIGTERM` 会留下一堆孤儿宿主占着会话 socket，重启后新旧宿主互相打架，比不重启更糟。

所以执行器的顺序是：

1. `app_dev.pid` 里有一个活着的进程 → 跑 `bash stop.sh`（它按进程组整组结束，30 秒不退就 `SIGKILL`）
2. pid 文件不存在（手动 `node client.js` 起的）→ 直接结束，POSIX 上再补一刀 `-pid` 进程组

两个 Windows 特有的坑，都已经写进代码：

- **pid 命名空间**：`start.sh` 用 `nohup setsid node … &` 启动，写进 `app_dev.pid` 的是 MSYS pid。`process.kill(msysPid, 0)` 抛 `ESRCH`，而 `bash -c 'kill -0 msysPid'` 是通的。所以存活判定要两个命名空间都问一遍，否则活得好好的服务会被判成「没起来」。
- **启动成功 ≠ pid 活着**：进程起来了但端口还没监听、宿主正在退出，pid 一样是活的。真正的判据是 `/api/game-version` 能答话（不需要鉴权，返回里带 `botVersion`；字段在顶层，不在 `data` 里）。探测不到就按失败处理并触发自动回滚。

## 7. 面板怎么知道「更新完成了」

服务在更新过程中会自己死掉几秒到几分钟，接口必然打不通。所以：

- 轮询期间网络错误只标记 `reconnecting`，**不写错误态**——否则那几分钟满屏红字
- 总时限 12 分钟，超过就报「等待结果超时，请刷新查看当前版本」
- 服务回来后读 `core/runtime/update-job.json`，`status` 不是 `running` 即结束
- 状态写着 `running` 但 pid 已死（被 `kill -9` 或机器重启）→ 判定失败并落盘，避免永远转圈

前端构建新增 `web/dist/version.json`：

```json
{ "buildId": "3.35.8-238-1795496178724", "appVersion": "3.35.8", "appBuild": 238, "builtAt": 1795496178724 }
```

`buildId` 同时被烘焙进 bundle（`__APP_BUILD_ID__`）。后端报告当前服务器上的 `buildId`，前端一比就知道标签页里是不是旧 bundle，是就提示刷新。入口 `index.html` 设了 `no-store`，保证刷新能立刻拿到引用新 bundle 的 HTML。

## 8. 支持范围与限制

| 运行形态 | 检查更新 | 一键更新 / 回滚 |
| --- | --- | --- |
| 源码 + git + `start.sh` 启动 | ✅ | ✅ |
| 源码 + git，手动 `node client.js` 启动 | ✅ | ⚠️ 能跑，但停服退回直接杀进程，宿主子进程可能残留 |
| Docker 容器 + 更新助手（updater 服务） | ✅ | ✅ 由助手在宿主机拉代码并重建容器 |
| Docker 容器，未启用助手 | ✅（读远端 `version.json`） | ❌ 容器内重启自身等于打死容器，请在宿主机重建 |
| 单文件打包（pkg） | ❌ | ❌ |

其他限制：

- 只支持 `--ff-only` 拉取。本地分叉过就先手动处理。
- 更新会重启服务，**游戏连接会断**。免扫码续期能不能接上取决于授权还有效；`code` 已失效的账号需要重新扫码。
- 重启由 `start.sh` 负责，所以**不要用 systemd / pm2 之类的外部守护**同时管这个进程，否则杀掉后会和外部的自动重启打架。
- 归档不包含 `core/src`：源码交给 git，产物交给归档，两边各管一摊。

## 8.1 容器部署的一键更新：updater 助手

容器里既没有 `.git` 也没有 git 命令，更不该在容器里改代码（改动会随重建消失）。所以容器部署的一键更新交给一个**独立的轻量容器**：它挂着 `docker.sock` 与项目目录，收到面板的请求就去 `git pull` + `docker compose up -d --build`。

为什么不能是应用容器里的一个子进程：要重建的正是应用容器自己。同一个容器里的进程会在 `docker stop` 那一刻一起被杀，更新只做一半——这是「容器里更新到一半服务就没了」这类事故的根因。

```
面板点「立即更新」
   → 后端写 core/data/runtime/update-request.json（数据卷）
   → updater 轮询到请求，git pull --ff-only
   → docker compose up -d --build（宿主机 daemon 干活）
   → 应用容器被重建；作业状态/日志一直写在数据卷里，新容器起来后接着读
   → 面板恢复连接，显示结果与完整日志
```

启用（默认不开，因为它挂了 `docker.sock`，等于宿主机 root 权限）：

```bash
cd <宿主机项目目录>
docker compose --profile update up -d          # 起 updater
# 之后面板「版本与更新」里的「立即更新」就可用了
docker compose --profile update rm -sf updater # 不想要了就收掉
```

也可以把 `COMPOSE_PROFILES=update` 写进 `.env`，之后普通的 `docker compose up -d` 就会带上它。

几个实现细节，出问题时能对上：

- **通信只靠数据卷**。`update-request.json`（应用→助手）、`update-job.json` / `update-job.log`（助手→应用）、`update-agent.json`（助手心跳）。文件名两边必须一致，测试逐条比对。
- **作业活性的判据是心跳，不是 pid**。助手在另一个容器里，它的 pid 在后端命名空间毫无意义（通常是 1，永远「活着」）。心跳 120 秒没更新才判死。
- **compose project 名从自身容器 label 读**，不猜目录名。猜错会另起一套容器，还会撞 `container_name`。
- **代码没变化就跳过重建**。NAS 上重建一次镜像几分钟起，为一个空更新等一轮不划算。
- **应用容器要把 runtime 放在数据卷里**（compose 已设 `FARM_RUNTIME_DIR=/app/core/data/runtime`），否则容器一重建，「更新进行到哪了」就没了。
- 私密仓库需要令牌：`UPDATE_GIT_TOKEN` 写进 `.env`。公开仓库不用管，助手会用匿名 HTTPS 拉取，`GIT_TERMINAL_PROMPT=0` 保证需要凭据时直接失败而不是卡住。

## 9. 排障

| 现象 | 先看哪里 |
| --- | --- |
| 点「立即更新」没反应 | `core/runtime/update-job.json` 的 `error`；`update-job.log` 末尾 |
| 一直显示「服务正在重启」 | `app_dev.log` 是否在增长；端口 3007 是否被别的进程占了 |
| 更新后登录状态全丢 | 预期行为，重启会断连接；看账号授权是否还能自动续期 |
| 更新成功但界面没变 | 面板应提示「面板已更新，点此刷新」；强制 `Ctrl+F5` |
| 回滚报「有未推送的本地提交」 | `git log @{u}..HEAD`，推上去或 `git reset --hard @{u}` 再来 |
| 归档占用太大 | 面板里删单个版本，或调小 `FARM_RELEASES_KEEP`，或点「清理孤儿」 |
| 回滚到很老的版本后，服务停了没起来 | 用稳定副本手动拉起：`node core/runtime/runner/farm-release.mjs rollback --release <id>` |
| 容器部署：显示「未启用」更新助手 | `docker compose ps` 看 `qq-farm-bot-updater` 在不在；没有就 `docker compose --profile update up -d` |
| 容器部署：点更新后一直「进行中」 | 助手心跳断了（`core/data/runtime/update-agent.json` 很久没更新）；先看 updater 容器日志 `docker logs --tail 50 qq-farm-bot-updater` |
| 容器部署：更新卡在「正在拉取代码」 | 私有仓库没凭据。看 `update-job.log` 末尾；需要的话在 `.env` 里加 `UPDATE_GIT_TOKEN` |
| 容器部署：当前运行版本显示「未知」 | 老镜像的 Dockerfile 运行阶段没拷 `version.json`；后端会退到 `web/dist/version.json`，升级到本版后不再出现 |

手工排查命令：

```bash
# 当前归档与激活状态
cat core/runtime/active-releases.json

# 上一次作业结果
cat core/runtime/update-job.json

# 强制给当前版本拍一张快照（不重启、不更新）
node tools/farm-release.mjs snapshot

# 执行器稳定副本（git reset 删不掉，面板坏了也能用它救回来）
node core/runtime/runner/farm-release.mjs snapshot
```
