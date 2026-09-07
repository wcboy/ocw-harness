#!/bin/sh
set -eu

export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/opt/node@22/bin:/usr/local/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
if [ -n "${OCW_RUNTIME_PATH:-}" ]; then
  export PATH="$OCW_RUNTIME_PATH:$PATH"
fi

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
app_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
workflow_root=${1:-${OCW_WORKFLOW_ROOT:-}}
dashboard_port=${PORT:-4173}
dashboard_url="http://127.0.0.1:${dashboard_port}"
registry_dir=${OCW_HARNESS_REGISTRY_DIR:-"$HOME/Library/Application Support/OCW Harness/registry"}
registry_cli="$app_dir/scripts/harness-registry.mjs"
log_path="/tmp/ocw-workflow-console-${dashboard_port}.log"
server_pid=""
launch_token=""

cd "$app_dir"

json_field() {
  body=$1
  key=$2
  printf '%s' "$body" | /usr/bin/plutil -extract "$key" raw -o - -- - 2>/dev/null
}

binding_matches() {
  response=$(curl --noproxy 127.0.0.1 --connect-timeout 1 --max-time 3 -fsS "$dashboard_url/api/health" 2>/dev/null) || return 1
  required=$(json_field "$response" binding.required) || return 1
  status=$(json_field "$response" binding.status) || return 1
  registry_mode=$(json_field "$response" binding.registryMode) || return 1
  bound_registry=$(json_field "$response" binding.registryDir) || return 1
  adapter_version=$(json_field "$response" binding.adapterVersion) || return 1
  source_digest=$(json_field "$response" binding.sourceDigest) || return 1
  ui_status=$(json_field "$response" binding.ui.status) || return 1
  [ "$source_digest" = "$expected_source" ] && [ "$ui_status" = "current" ] && [ "$required" = "true" ] && [ "$status" = "bound" ] && [ "$registry_mode" = "true" ] && [ "$bound_registry" = "$registry_dir" ] && [ "$adapter_version" = "$expected_adapter" ]
}

frontend_attached() {
  [ -n "$launch_token" ] || return 1
  response=$(curl --noproxy 127.0.0.1 --connect-timeout 1 --max-time 3 -fsS "$dashboard_url/api/health?launch=$launch_token" 2>/dev/null) || return 1
  attached=$(json_field "$response" binding.frontendAttached) || return 1
  clients=$(json_field "$response" binding.connectedClients) || return 1
  launch_attached=$(json_field "$response" binding.launchAttached) || return 1
  launch_clients=$(json_field "$response" binding.launchClients) || return 1
  [ "$attached" = "true" ] && [ "$clients" -gt 0 ] && [ "$launch_attached" = "true" ] && [ "$launch_clients" -gt 0 ]
}

open_frontend() {
  browser_bundle_id=${OCW_BROWSER_BUNDLE_ID:-}
  launch_token=$(/usr/bin/uuidgen | tr '[:upper:]' '[:lower:]')
  launch_url="${dashboard_url}/?launch=${launch_token}"

  if [ -z "$browser_bundle_id" ]; then
    /usr/bin/open "$launch_url"
    return
  fi

  # A normal `open -b` can target an automation/headless Chrome instance that
  # shares the bundle id. Starting a fresh app instance makes LaunchServices
  # deliver the URL to a visible browser, while Chrome still reuses its normal
  # profile when one is already running.
  /usr/bin/open -n -b "$browser_bundle_id" "$launch_url"
}

register_requested_harness() {
  [ -x "$registry_cli" ] || return 0
  [ -n "$workflow_root" ] || return 0
  [ -f "$workflow_root/state.json" ] || [ -f "$workflow_root/ocw-head.json" ] || return 1
  command -v node >/dev/null 2>&1 || return 0

  session_id=${OCW_HARNESS_SESSION_ID:-${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-default}}}
  if [ -n "${OCW_HARNESS_LABEL:-}" ]; then
    registration=$(node "$registry_cli" register --registry "$registry_dir" --source "$workflow_root" --session "$session_id" --label "$OCW_HARNESS_LABEL")
  else
    registration=$(node "$registry_cli" register --registry "$registry_dir" --source "$workflow_root" --session "$session_id")
  fi
  json_field "$registration" registrationId
}

release=$(node scripts/ui-release.mjs)
expected_source=$(json_field "$release" sourceDigest)
expected_adapter=$(json_field "$release" adapterVersion)
node scripts/ensure-ui.mjs
registered_id=$(register_requested_harness)

if ! binding_matches; then
  if /usr/bin/nc -z 127.0.0.1 "$dashboard_port" >/dev/null 2>&1; then
    echo "端口 ${dashboard_port} 已被另一个或不匹配的工作流窗口占用。" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "找不到 Node.js；请重新安装桌面入口以记录当前运行时位置。" >&2
    exit 1
  fi


  server_pid=$(env OCW_HARNESS_REGISTRY_DIR="$registry_dir" PORT="$dashboard_port" node scripts/launch-supervisor.mjs "$log_path")
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if binding_matches; then
      break
    fi
    sleep 0.25
  done
fi

if ! binding_matches; then
  if [ -n "$server_pid" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
  echo "Harness 前端启动失败，请查看 ${log_path}" >&2
  exit 1
fi

if ! open_frontend; then
  echo "Harness 已启动，但无法把浏览器窗口带到前台。请重新安装桌面入口，或直接访问 ${dashboard_url}。" >&2
  exit 1
fi

for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
  if frontend_attached; then
    break
  fi
  sleep 0.25
done

if ! frontend_attached; then
  echo "Harness 服务已就绪，但本次页面握手未完成；服务保留供重试。" >&2
  exit 1
fi

response=$(curl --noproxy 127.0.0.1 --connect-timeout 1 --max-time 3 -fsS "$dashboard_url/api/health")
frontend_url=$(json_field "$response" binding.frontendUrl)
binding_id=$(json_field "$response" binding.bindingId)
clients=$(json_field "$response" binding.connectedClients)
registrations=$(json_field "$response" binding.registryCount)
tasks=$(json_field "$response" binding.taskCount)
sessions=$(json_field "$response" binding.sessionCount)
printf 'OCW Harness 已绑定前端：%s\n' "$frontend_url"
printf '注册中心 %s · %s 个任务 · %s 个 session · %s 个实时客户端\n' "$binding_id" "$tasks" "$sessions" "$clients"
printf '本次浏览器页面已通过独立启动握手。\n'
if [ -n "$registered_id" ]; then
  printf '已注册或刷新：%s\n' "$registered_id"
fi
if [ -n "${OCW_BROWSER_BUNDLE_ID:-}" ]; then
  printf '浏览器 %s 已打开并前置。\n' "$OCW_BROWSER_BUNDLE_ID"
fi
