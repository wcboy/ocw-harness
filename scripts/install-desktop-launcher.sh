#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
app_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
destination=${1:-"$HOME/Desktop/OCW Harness.app"}
# A bundle identifier belongs to whoever installs the app, so it is overridable.
# The default is the repository owner rather than any one developer, and it must
# match desktop/Info.plist so the clobber check below recognises our own app.
bundle_prefix=${OCW_BUNDLE_PREFIX:-io.github.wcboy}
bundle_id="$bundle_prefix.ocw-harness"
plist_template="$app_dir/desktop/Info.plist"
launcher_template="$app_dir/desktop/launcher"
system_icon="/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericNetworkIcon.icns"
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
stage_root=$(/usr/bin/mktemp -d "/tmp/ocw-harness-launcher.XXXXXX")
stage_app="$stage_root/OCW Harness.app"
contents_dir="$stage_app/Contents"
resources_dir="$contents_dir/Resources"
previous_app="$stage_root/previous.app"

cleanup() {
  /bin/rm -rf "$stage_root"
}
trap cleanup EXIT HUP INT TERM

if [ -e "$destination" ]; then
  existing_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)
  if [ "$existing_id" != "$bundle_id" ]; then
    echo "目标位置已有其他应用：$destination" >&2
    exit 1
  fi
fi

node_command=$(command -v node 2>/dev/null || true)
npm_command=$(command -v npm 2>/dev/null || true)
if [ -z "$node_command" ] || [ -z "$npm_command" ]; then
  echo "安装桌面入口前需要在当前终端中找到 Node.js 与 npm。" >&2
  exit 1
fi
runtime_path=$(dirname "$node_command")
npm_path=$(dirname "$npm_command")
if [ "$runtime_path" != "$npm_path" ]; then
  runtime_path="$runtime_path:$npm_path"
fi

browser_bundle_id=$(
  /usr/bin/defaults export com.apple.LaunchServices/com.apple.launchservices.secure - 2>/dev/null \
    | /usr/bin/plutil -convert json -o - -- - 2>/dev/null \
    | "$node_command" -e '
const fs = require("node:fs");
const preferences = JSON.parse(fs.readFileSync(0, "utf8"));
const handlers = Array.isArray(preferences.LSHandlers) ? preferences.LSHandlers : [];
const match = [...handlers].reverse().find((handler) =>
  (handler.LSHandlerURLScheme === "https" || handler.LSHandlerURLScheme === "http") &&
  (handler.LSHandlerRoleAll || handler.LSHandlerRoleViewer)
);
process.stdout.write(match ? (match.LSHandlerRoleAll || match.LSHandlerRoleViewer) : "");
' 2>/dev/null \
    || true
)
case "$browser_bundle_id" in
  com.google.chrome) browser_bundle_id="com.google.Chrome" ;;
  com.apple.safari) browser_bundle_id="com.apple.Safari" ;;
esac
if [ -z "$browser_bundle_id" ]; then
  browser_bundle_id="com.apple.Safari"
fi
registry_path=${OCW_HARNESS_REGISTRY_DIR:-"$HOME/Library/Application Support/OCW Harness/registry"}
/bin/mkdir -p "$registry_path"
/bin/chmod 700 "$registry_path"

mkdir -p "$contents_dir/MacOS" "$resources_dir"
/usr/bin/install -m 644 "$plist_template" "$contents_dir/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$contents_dir/Info.plist" >/dev/null
/usr/bin/install -m 755 "$launcher_template" "$contents_dir/MacOS/launcher"
/usr/bin/printf '%s\n' "$app_dir" >"$resources_dir/project-path"
/bin/chmod 644 "$resources_dir/project-path"
/usr/bin/printf '%s\n' "$runtime_path" >"$resources_dir/runtime-path"
/bin/chmod 644 "$resources_dir/runtime-path"
/usr/bin/printf '%s\n' "$browser_bundle_id" >"$resources_dir/browser-bundle-id"
/bin/chmod 644 "$resources_dir/browser-bundle-id"
/usr/bin/printf '%s\n' "$registry_path" >"$resources_dir/registry-path"
/bin/chmod 644 "$resources_dir/registry-path"

if [ -f "$system_icon" ]; then
  /usr/bin/install -m 644 "$system_icon" "$resources_dir/AppIcon.icns"
fi

/usr/bin/xattr -cr "$stage_app" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$stage_app" >/dev/null
/usr/bin/codesign --verify --deep --strict "$stage_app"

mkdir -p "$(dirname "$destination")"
if [ -e "$destination" ]; then
  /bin/mv "$destination" "$previous_app"
fi
if ! /bin/mv "$stage_app" "$destination"; then
  if [ -e "$previous_app" ]; then
    /bin/mv "$previous_app" "$destination"
  fi
  echo "无法把桌面应用安装到：$destination" >&2
  exit 1
fi

if ! /usr/bin/codesign --verify --deep "$destination"; then
  /bin/mv "$destination" "$stage_root/invalid.app"
  if [ -e "$previous_app" ]; then
    /bin/mv "$previous_app" "$destination"
  fi
  echo "桌面应用签名复验失败，已恢复原入口。" >&2
  exit 1
fi
"$lsregister" -f "$destination"
/usr/bin/touch "$destination"

echo "桌面启动入口已安装：$destination"
echo "双击后会启动 Harness 注册中心，并用 ${browser_bundle_id} 打开及前置多任务工作流窗口。"
