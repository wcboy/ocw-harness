#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ -r "$here/source-project" ]; then
  IFS= read -r app_dir <"$here/source-project" || true
  export OCW_BUILD_DIR="$here"
else
  app_dir=$(CDPATH= cd -- "$here/.." && pwd)
fi
exec "$app_dir/scripts/run-bound-ui.sh" "$@"
