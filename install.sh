#!/usr/bin/env bash
set -euo pipefail

# Install one or all Antigravity Power Pack plugins into ~/.gemini/config/plugins.
# Usage:
#   ./install.sh                           # Install all 6 plugins
#   ./install.sh office-preview            # Install specific plugin(s)
#   ./install.sh --list                    # List available plugins
#   ./install.sh --uninstall [name...]     # Remove installed plugin(s)
#   ./install.sh --dest /custom/dir [...]  # Override plugin install directory

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_SRC="$SCRIPT_DIR/plugins"
DEST_DIR="${AGY_PLUGINS_DIR:-$HOME/.gemini/config/plugins}"
ACTION="install"
TARGETS=()

usage() {
  cat <<'USAGE'
Usage: ./install.sh [OPTIONS] [PLUGIN_NAME...]

Options:
  --list              List all available plugins in this pack
  --uninstall         Remove the specified plugin(s) (or all 6 if none given)
  --dest <dir>        Override target directory (default: ~/.gemini/config/plugins)
  -h, --help          Show this help message

Examples:
  ./install.sh
  ./install.sh office-preview codex-subagent
  ./install.sh --uninstall visible-thinking-brief
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) ACTION="list"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --dest) DEST_DIR="${2:?Missing directory after --dest}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "ERROR: Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done

AVAILABLE=()
while IFS= read -r plugin_name; do
  [[ -n "$plugin_name" ]] && AVAILABLE+=("$plugin_name")
done < <(
  for d in "$PLUGINS_SRC"/*; do
    [[ -d "$d" && -f "$d/plugin.json" ]] && basename "$d"
  done | sort
)

if [[ "$ACTION" == "list" ]]; then
  echo "Available plugins in Antigravity Power Pack (${#AVAILABLE[@]}):"
  for p in "${AVAILABLE[@]}"; do
    echo "  - $p"
  done
  exit 0
fi

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  TARGETS=("${AVAILABLE[@]}")
fi

is_available_plugin() {
  local candidate="$1"
  local item
  for item in "${AVAILABLE[@]}"; do
    if [[ "$item" == "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

for name in "${TARGETS[@]}"; do
  if ! is_available_plugin "$name"; then
    echo "ERROR: Unknown plugin '$name'. Run './install.sh --list' to see valid names." >&2
    exit 2
  fi
done

if [[ "$ACTION" == "uninstall" ]]; then
  for name in "${TARGETS[@]}"; do
    target="$DEST_DIR/$name"
    if [[ -d "$target" ]]; then
      rm -rf "$target"
      echo "Removed: $target"
    else
      echo "Not installed (skipped): $name"
    fi
  done
  exit 0
fi

mkdir -p "$DEST_DIR"
for name in "${TARGETS[@]}"; do
  target="$DEST_DIR/$name"
  rm -rf "$target"
  cp -a "$PLUGINS_SRC/$name" "$target"
  # Ensure shell scripts remain executable
  find "$target" -type f -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
  echo "Installed: $name -> $target"
done

echo ""
echo "Done. Open Antigravity -> Customizations -> Plugins to enable your installed plugins."
