#!/bin/sh
# 宿主机更新助手（updater 服务）。
#
# 为什么需要它：应用跑在容器里，容器里没有 git、没有 docker 命令，也不该在容器里改代码
# ——代码改动会随容器重建消失。而「重建容器」这件事只能由宿主机的 docker daemon 做。
# 于是把这件事交给一个**独立的轻量容器**：它挂着 docker.sock 与宿主机项目目录，
# 常驻轮询数据卷里的更新请求，收到就 git pull + docker compose up -d --build。
#
# 为什么必须是独立容器，而不是应用容器里的一个子进程：更新要重建的正是应用容器自己。
# 同一个容器里的进程会在 docker stop 时一起被杀，更新只做一半就没了。
#
# 通信全部走数据卷（两个容器都挂着 qq-farm-data）：
#   <数据卷>/runtime/update-request.json  应用写请求 → 助手领
#   <数据卷>/runtime/update-job.json      助手写作业状态 ← 面板轮询
#   <数据卷>/runtime/update-job.log       助手写完整日志 ← 面板展示
#   <数据卷>/runtime/update-agent.json    助手写心跳 ← 应用据此判断「能不能一键更新」
# 应用容器被重建后，新容器从同一个卷里读回作业结果，所以面板能接着显示进度与结论。
#
# 可调环境变量：
#   UPDATE_PROJECT_DIR   宿主机项目目录在容器里的挂载点（默认 /project）
#   UPDATE_DATA_DIR      数据卷挂载点（默认 /data）
#   UPDATE_POLL_SECONDS  轮询间隔秒数（默认 3）
#   UPDATE_GIT_TOKEN     私密仓库用的访问令牌；公开仓库不需要
#   UPDATE_COMPOSE_PROJECT  compose project 名；默认从自身容器的 label 里读
#   UPDATE_BUILD_POLL_SECONDS 构建期间刷进度/心跳的间隔（默认 2）
#   UPDATE_PULL_ATTEMPTS  git pull 最多尝试次数（默认 3），0/非法值回落到 3
#   UPDATE_PULL_RETRY_DELAY 重试间隔基数秒数（默认 5，第 n 次等 n×基数）
#   UPDATE_ONCE=1        只跑一轮就退出（测试用）
set -u

PROJECT_DIR="${UPDATE_PROJECT_DIR:-/project}"
DATA_DIR="${UPDATE_DATA_DIR:-/data}"
RUNTIME_DIR="$DATA_DIR/runtime"
POLL_SECONDS="${UPDATE_POLL_SECONDS:-3}"
BUILD_POLL_SECONDS="${UPDATE_BUILD_POLL_SECONDS:-2}"
ONCE="${UPDATE_ONCE:-0}"
PROTOCOL=1
MAX_LINES=40

HEARTBEAT_FILE="$RUNTIME_DIR/update-agent.json"
REQUEST_FILE="$RUNTIME_DIR/update-request.json"
JOB_FILE="$RUNTIME_DIR/update-job.json"
LOG_FILE="$RUNTIME_DIR/update-job.log"

# 毫秒级时间戳。BusyBox 的 date 没有 %N（只有秒），只能秒 × 1000。
# 后端一律用 Date.now() 的毫秒做比较：写秒会让「每几秒刷一次」的心跳
# 差 1000 倍，被算成几十年没心跳（面板会打出「已经 29896434 分钟没有心跳」），
# 一键更新链路整条判死。这一层是协议的一部分，别改回 `date +%s`。
now_ms() {
  echo $(( $(date +%s) * 1000 ))
}

STARTED_AT=$(now_ms)
JOB_ID=""
REQUEST_ID=""
FROM_COMMIT=""
TARGET_COMMIT=""
JOB_STARTED_AT=""

mkdir -p "$RUNTIME_DIR" || {
  echo "[错误] 无法创建 $RUNTIME_DIR，检查数据卷挂载" >&2
  exit 1
}

# ── 小工具 ────────────────────────────────────────────────────────────────────

# JSON 字符串转义：只处理会让 JSON 失效的三类字符（反斜杠、双引号、回车）。
json_escape() {
  printf '%s' "$1" | tr -d '\r' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/  /g'
}

# 从一行 JSON 里取字符串字段。助手自己写的文件结构固定，grep -o 取第一个匹配足够。
read_field() {
  [ -f "$1" ] || return 0
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null \
    | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'
}

log() {
  printf '%s\n' "$1" >> "$LOG_FILE"
}

# 心跳：应用侧靠它判断「宿主机那侧有人在」。判死阈值是 120 秒，所以只要循环在转，
# 哪怕正在构建也要保证每轮都写一次。
# projectDir 由 compose 注入，正常是 /project 这种容器内路径；仍然转义一遍——
# 反斜杠没转义时 JSON 直接失效，面板会把「路径写错」误判成「助手没在跑」。
write_heartbeat() {
  tmp="$HEARTBEAT_FILE.tmp"
  printf '{"protocol":%s,"pid":%s,"startedAt":%s,"heartbeatAt":%s,"projectDir":"%s"}\n' \
    "$PROTOCOL" "$$" "$STARTED_AT" "$(now_ms)" "$(json_escape "$PROJECT_DIR")" \
    > "$tmp" && mv -f "$tmp" "$HEARTBEAT_FILE"
}

# 写作业状态。字段名与后端 PanelUpdateJobState 对齐，后端不需要任何翻译层。
#
# 整份 JSON 交给**一个 awk** 生成：早先版本用 tail|tr|sed|awk 加一堆 $() 子壳，
# 一次要起二十来个进程。NAS 的 ARM CPU 上这套开销是实打实的（本机 Windows 实测
# 单次更新多花 8 秒），而这里每两秒就要写一次。
write_job() {
  status="$1"
  phase="$2"
  detail="${3:-}"
  error="${4:-}"
  now=$(now_ms)
  [ -f "$LOG_FILE" ] || : > "$LOG_FILE"
  tmp="$JOB_FILE.tmp"
  awk -v id="$JOB_ID" -v rid="$REQUEST_ID" -v pid="$$" \
      -v status="$status" -v phase="$phase" -v detail="$detail" -v error="$error" \
      -v started="${JOB_STARTED_AT:-$now}" -v updated="$now" \
      -v fromc="$FROM_COMMIT" -v toc="$TARGET_COMMIT" -v max="$MAX_LINES" '
    function esc(s) {
      gsub(/\\/, "\\\\", s)
      gsub(/"/, "\\\"", s)
      gsub(/\r/, "", s)
      gsub(/\t/, "  ", s)
      return s
    }
    { buf[++n] = $0 }
    END {
      first = (n > max) ? n - max + 1 : 1
      lines = ""
      for (i = first; i <= n; i++)
        lines = lines (i > first ? "," : "") "\"" esc(buf[i]) "\""
      out = "{\"id\":\"" esc(id) "\",\"requestId\":\"" esc(rid) "\",\"origin\":\"agent\","
      out = out "\"action\":\"update\",\"pid\":" pid ",\"status\":\"" status "\","
      out = out "\"phase\":\"" esc(phase) "\",\"detail\":\"" esc(detail) "\","
      out = out "\"startedAt\":" started ",\"updatedAt\":" updated ","
      out = out "\"recentLines\":[" lines "],"
      out = out "\"fromCommit\":\"" esc(fromc) "\",\"targetCommit\":\"" esc(toc) "\""
      if (status == "succeeded" || status == "failed") out = out ",\"finishedAt\":" updated
      if (error != "") out = out ",\"error\":\"" esc(error) "\""
      printf "%s}\n", out
    }' "$LOG_FILE" > "$tmp" && mv -f "$tmp" "$JOB_FILE"
}

# ── 环境检查 ──────────────────────────────────────────────────────────────────

ensure_git() {
  command -v git >/dev/null 2>&1 && return 0
  log "[环境] 镜像里没有 git，尝试安装…"
  command -v apk >/dev/null 2>&1 && apk add --no-cache git >> "$LOG_FILE" 2>&1
  command -v git >/dev/null 2>&1
}

# compose project 名必须和宿主机那次启动的一致，否则会另起一套容器（还会撞 container_name）。
# 自己容器的 label 里就有，比猜目录名可靠——用户把项目放在哪个目录都不影响。
ensure_compose_project() {
  [ "${COMPOSE_PROJECT_READY:-0}" = "1" ] && return 0
  if [ -n "${UPDATE_COMPOSE_PROJECT:-}" ]; then
    export COMPOSE_PROJECT_NAME="$UPDATE_COMPOSE_PROJECT"
  elif [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
    detected=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$(hostname)" 2>/dev/null | tr -d '\r')
    if [ -n "$detected" ] && [ "$detected" != "<no value>" ]; then
      export COMPOSE_PROJECT_NAME="$detected"
    fi
  fi
  COMPOSE_PROJECT_READY=1
  return 0
}

# ── 更新本身 ──────────────────────────────────────────────────────────────────

# ── 网络参数与重试 ────────────────────────────────────────────────────────────
# 现场故障：NAS 上 `git pull` 报 `OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 0`。
# 这种形态是 TCP 还连着、TLS 记录被中间设备静默丢掉，git 会挂在半死连接上干等；
# 隔几秒重试一次往往就通了。两个措施：
#   1) 强制 HTTP/1.1 —— HTTP/2 的多路复用长连接在部分代理 / NAT / 运营商下会被掐；
#   2) 低速断连 —— 30 秒内低于 1KB/s 就主动放弃，把「假死」变成可重试的失败。
# 次数与间隔可用环境变量调（默认 3 次、每次 5 秒递增），测试里调小免得白等。
GIT_NET_OPTS="-c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30"
PULL_MAX_ATTEMPTS=$(printf '%s' "${UPDATE_PULL_ATTEMPTS:-3}" | tr -cd '0-9')
[ -n "$PULL_MAX_ATTEMPTS" ] || PULL_MAX_ATTEMPTS=3
PULL_RETRY_DELAY=$(printf '%s' "${UPDATE_PULL_RETRY_DELAY:-5}" | tr -cd '0-9')
[ -n "$PULL_RETRY_DELAY" ] || PULL_RETRY_DELAY=5

pull_once() {
  if [ -n "${UPDATE_GIT_TOKEN:-}" ]; then
    origin_url=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || echo "")
    branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
    case "$origin_url" in
      https://github.com/*)
        # 一次性凭据 URL：令牌不写进 .git/config，只出现在这一次进程里。
        auth_url=$(printf '%s' "$origin_url" | sed "s|^https://github.com/|https://x-access-token:${UPDATE_GIT_TOKEN}@github.com/|")
        # $GIT_NET_OPTS 故意不加引号：要按空格拆成多个 -c 参数。
        GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" $GIT_NET_OPTS pull --ff-only "$auth_url" "$branch" >> "$LOG_FILE" 2>&1
        return $?
        ;;
    esac
  fi
  # GIT_TERMINAL_PROMPT=0：需要凭据时直接失败，而不是停在原地等人敲用户名
  # （容器里没人能敲，卡住只会让面板一直显示「正在拉取代码」）。
  GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" $GIT_NET_OPTS pull --ff-only >> "$LOG_FILE" 2>&1
}

# 失败原因按日志实况给，而不是一句「常见原因」让人自己猜。
# 顺序有讲究：SSL 那几行里同时带 "unable to access"，所以网络分支必须排在最后。
pull_failure_hint() {
  recent=$(tail -n 80 "$LOG_FILE" 2>/dev/null || true)
  hint=""
  case "$recent" in
    *"Not possible to fast-forward"*|*"diverging branches"*|*"local changes"*|*"would be overwritten"*|*"Please commit"*)
      hint="本地有未提交改动或与远端分叉了；助手只做 --ff-only，请先在项目目录处理本地改动再更新" ;;
    *"Authentication failed"*|*"could not read Username"*|*"Repository not found"*|*"terminal prompts disabled"*)
      hint="仓库需要凭据：私密仓库请在更新助手上配置 UPDATE_GIT_TOKEN（公开仓库请确认 origin 能匿名拉取）" ;;
    *SSL_ERROR*|*SSL_connect*|*gnutls*)
      hint="到 GitHub 的 TLS 连接被中断（SSL_ERROR_SYSCALL）。已按 HTTP/1.1 + 多次重试执行，仍失败说明 NAS 出网到 github.com 不稳定；稍后再试，或在宿主机上手动 git pull" ;;
    *"Could not resolve host"*|*"Connection timed out"*|*"Connection refused"*|*"unable to access"*|*"Failed to connect"*)
      hint="NAS 访问不到 github.com（DNS / 出网 / 防火墙）；先在宿主机执行 curl -I https://github.com/ 确认" ;;
  esac
  [ -n "$hint" ] || hint="git pull --ff-only 失败：常见原因是本地有未提交改动、分支没有上游、或私密仓库缺少凭据（见日志）"
  printf '%s' "$hint"
}

run_pull() {
  log "[更新] 当前提交 ${FROM_COMMIT:-未知}，开始拉取代码…"
  attempt=1
  while [ "$attempt" -le "$PULL_MAX_ATTEMPTS" ]; do
    if pull_once; then
      [ "$attempt" -gt 1 ] && log "[更新] 第 ${attempt} 次拉取成功。"
      return 0
    fi
    if [ "$attempt" -lt "$PULL_MAX_ATTEMPTS" ]; then
      pause=$((attempt * PULL_RETRY_DELAY))
      log "[更新] 第 ${attempt}/${PULL_MAX_ATTEMPTS} 次拉取失败，${pause} 秒后重试…"
      sleep "$pause"
    fi
    attempt=$((attempt + 1))
  done
  log "[更新] 已连续重试 ${PULL_MAX_ATTEMPTS} 次，仍然失败。"
  return 1
}

# 容器里是 root，宿主机上的项目目录通常属于某个普通用户。git pull 写出来的文件会变成
# root 的，之后用户在宿主机上编辑或手动 pull 就撞权限。这里按项目目录的属主把它改回去；
# 改不动就算了（目录本来就属于 root、或者当前用户没权限），不影响更新结果。
restore_owner() {
  owner=$(stat -c '%u:%g' "$PROJECT_DIR" 2>/dev/null || echo "")
  [ -n "$owner" ] || return 0
  [ "$owner" = "0:0" ] && return 0
  chown -R "$owner" "$PROJECT_DIR/.git" 2>/dev/null || true
  [ -n "$FROM_COMMIT" ] && [ -n "$TARGET_COMMIT" ] || return 0
  git -C "$PROJECT_DIR" diff --name-only "$FROM_COMMIT..$TARGET_COMMIT" 2>/dev/null \
    | while IFS= read -r changed; do
        [ -n "$changed" ] && chown "$owner" "$PROJECT_DIR/$changed" 2>/dev/null
      done
  return 0
}

run_update() {
  JOB_STARTED_AT=$(now_ms)
  : > "$LOG_FILE"
  if [ "${RETRY_REQUEST_ID:-}" = "$REQUEST_ID" ]; then
    log "[更新] 上一轮被中断，这一次是重试。"
  fi
  log "[更新] 助手接手请求 ${REQUEST_ID}"
  write_job running "准备更新" "宿主机更新助手已接手" ""

  if ! ensure_git; then
    log "[错误] 更新助手缺少 git，无法拉取代码。"
    write_job failed "环境不完整" "" "更新助手容器里没有 git 且安装失败，请检查容器镜像"
    return 1
  fi
  # 项目目录是宿主机 bind mount，属主通常不是容器用户；不放行 safe.directory
  # 会直接报 dubious ownership，之后每条 git 命令都失败。
  git config --global --add safe.directory "$PROJECT_DIR" >/dev/null 2>&1

  FROM_COMMIT=$(git -C "$PROJECT_DIR" rev-parse --short=7 HEAD 2>/dev/null || echo "")
  write_job running "正在拉取代码" "git pull --ff-only（HTTP/1.1，最多 ${PULL_MAX_ATTEMPTS} 次）" ""
  if ! run_pull; then
    log "[错误] git pull 失败。服务没被动，仍在运行。"
    write_job failed "拉取代码失败" "服务未受影响" "$(pull_failure_hint)"
    return 1
  fi
  TARGET_COMMIT=$(git -C "$PROJECT_DIR" rev-parse --short=7 HEAD 2>/dev/null || echo "")

  # 代码没变就别重建：NAS 上重建一次镜像往往是几分钟到十几分钟，白跑一次很难受。
  if [ -n "$FROM_COMMIT" ] && [ "$FROM_COMMIT" = "$TARGET_COMMIT" ]; then
    log "[更新] 代码已是最新（$TARGET_COMMIT），跳过重建。"
    write_job succeeded "已是最新版本" "代码没有变化，未重建镜像" ""
    return 0
  fi

  log "[更新] 代码已更新：${FROM_COMMIT:-(未知)} → ${TARGET_COMMIT:-(未知)}，开始重建容器…"
  write_job running "正在重建镜像" "docker compose up -d --build（机型越慢耗时越长）" ""

  ensure_compose_project
  # 直接追加到 LOG_FILE：面板每隔两秒读一次 tail，构建输出是实时流过去的。
  ( cd "$PROJECT_DIR" && exec docker compose up -d --build ) >> "$LOG_FILE" 2>&1 &
  build_pid=$!
  while kill -0 "$build_pid" 2>/dev/null; do
    write_heartbeat
    write_job running "正在重建镜像" "docker compose up -d --build（机型越慢耗时越长）" ""
    sleep "$BUILD_POLL_SECONDS"
  done
  wait "$build_pid"
  build_rc=$?

  if [ "$build_rc" -ne 0 ]; then
    log "[错误] 重建失败（退出码 $build_rc）。旧容器仍在运行，服务没有中断。"
    write_job failed "重建失败" "旧容器仍在运行" \
      "docker compose up -d --build 返回 $build_rc，往上翻构建日志找第一条报错"
    return 1
  fi

  log "[更新] 重建完成，容器已切到新镜像（$TARGET_COMMIT）。"
  docker image prune -f >> "$LOG_FILE" 2>&1 || true
  restore_owner
  write_job succeeded "更新完成" "容器已重建，刷新页面即为新版本" ""
  return 0
}

# ── 主循环 ────────────────────────────────────────────────────────────────────

# 助手中途重启时，上次的作业会永远停在 running（应用的判活靠心跳，心跳也断了）。
# 这里先把这种僵尸作业收尾，并记下要被重试的请求号——重建是幂等的，重跑安全；
# 但真正的失败（比如工作区有未提交改动）不能每次轮询都重跑，所以只放行这一轮。
reconcile_stale_job() {
  RETRY_REQUEST_ID=""
  [ -f "$JOB_FILE" ] || return 0
  status=$(read_field "$JOB_FILE" status)
  origin=$(read_field "$JOB_FILE" origin)
  [ "$status" = "running" ] || return 0
  [ "$origin" = "agent" ] || return 0
  JOB_ID=$(read_field "$JOB_FILE" id)
  RETRY_REQUEST_ID=$(read_field "$JOB_FILE" requestId)
  log "[更新] 上一次更新被中断（助手重启），准备重试。"
  write_job failed "任务中断" "更新助手重启过" "上次更新没有跑完，将重新尝试"
}

handle_request() {
  [ -f "$REQUEST_FILE" ] || return 0
  req_id=$(read_field "$REQUEST_FILE" id)
  [ -n "$req_id" ] || return 0

  # 同一个请求只处理一次：作业里记着 requestId，且必须是助手自己写的。
  # 应用写的那份占位作业 origin=app，看到它就说明还没人领。
  job_request=$(read_field "$JOB_FILE" requestId)
  job_origin=$(read_field "$JOB_FILE" origin)
  job_status=$(read_field "$JOB_FILE" status)
  if [ "$job_origin" = "agent" ] && [ "$job_request" = "$req_id" ] && [ "$req_id" != "$RETRY_REQUEST_ID" ]; then
    case "$job_status" in
      succeeded|failed) return 0 ;;
    esac
  fi

  JOB_ID="$req_id"
  REQUEST_ID="$req_id"
  run_update
  RETRY_REQUEST_ID=""
}

reconcile_stale_job
while :; do
  write_heartbeat
  ensure_compose_project
  handle_request
  [ "$ONCE" = "1" ] && break
  sleep "$POLL_SECONDS"
done
