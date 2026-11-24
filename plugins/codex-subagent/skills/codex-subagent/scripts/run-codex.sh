#!/usr/bin/env bash
set -euo pipefail

# Lightweight OpenAI Codex CLI wrapper for Linux and macOS.
# Supports exec / review / resume / accounts / init-account with CODEX_HOME multi-account isolation.

MODE="exec"
SANDBOX="read-only"
CWD="$(pwd)"
MODEL=""
TIMEOUT_SEC=300
SESSION_ID=""
USE_LAST=0
UNCOMMITTED=0
BASE_BRANCH=""
COMMIT_SHA=""
KEEP_SESSION=0
WORKTREE=0
TRUST=0
OUTPUT_SCHEMA=""
IMAGES=()
PROMPT_TEXT=""
PROMPT_FILE=""
ACCOUNT=""
CUSTOM_CODEX_HOME=""

usage() {
  cat <<'USAGE'
Usage: run-codex.sh [OPTIONS]
  --mode <exec|review|resume|accounts|init-account>  Execution mode (default: exec)
  --account <name>              Account alias (default/1 -> ~/.codex; others -> ~/.codex-accounts/<name>)
  --codex-home <dir>            Explicit CODEX_HOME directory (overrides --account)
  --sandbox <read-only|workspace-write>  Sandbox level for exec and resume (default: read-only)
  --cwd <dir>                   Working directory (default: current directory)
  --model <model>               Optional Codex model override
  --timeout <sec>               Hard timeout in seconds (default: 300)
  --session-id <id>             Session ID for resume mode (mutually exclusive with --last)
  --last                        Resume most recent session (mutually exclusive with --session-id)
  --uncommitted                 Review uncommitted changes (exclusive with --base/--commit/prompt)
  --base <branch>               Review diff against base branch (exclusive with --uncommitted/--commit/prompt)
  --commit <sha>                Review specific commit (exclusive with --uncommitted/--base/prompt)
  --keep-session                Persist session for exec/review (default adds --ephemeral; resume keeps continuity)
  --worktree                    Run in an isolated managed Git worktree
  --image <path>                Attach image file (repeatable; supported in exec and resume, not review)
  --output-schema <file>        JSON Schema file constraining the final structured output
  --trust                       Explicitly trust the working directory (default: off)
  --prompt <text>               Prompt string (reads stdin if omitted and stdin is piped)
  --prompt-file <path>          Read prompt text from file
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:?}"; shift 2 ;;
    --account) ACCOUNT="${2:?}"; shift 2 ;;
    --codex-home) CUSTOM_CODEX_HOME="${2:?}"; shift 2 ;;
    --sandbox) SANDBOX="${2:?}"; shift 2 ;;
    --cwd) CWD="${2:?}"; shift 2 ;;
    --model) MODEL="${2:?}"; shift 2 ;;
    --timeout) TIMEOUT_SEC="${2:?}"; shift 2 ;;
    --session-id) SESSION_ID="${2:?}"; shift 2 ;;
    --last) USE_LAST=1; shift ;;
    --uncommitted) UNCOMMITTED=1; shift ;;
    --base) BASE_BRANCH="${2:?}"; shift 2 ;;
    --commit) COMMIT_SHA="${2:?}"; shift 2 ;;
    --keep-session) KEEP_SESSION=1; shift ;;
    --worktree) WORKTREE=1; shift ;;
    --image) IMAGES+=("${2:?}"); shift 2 ;;
    --output-schema) OUTPUT_SCHEMA="${2:?}"; shift 2 ;;
    --trust) TRUST=1; shift ;;
    --prompt) PROMPT_TEXT="${2:?}"; shift 2 ;;
    --prompt-file) PROMPT_FILE="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$MODE" in
  exec|review|resume|accounts|init-account) ;;
  *)
    echo "ERROR: Unsupported --mode value: $MODE (allowed: exec | review | resume | accounts | init-account)" >&2
    exit 2
    ;;
esac

case "$SANDBOX" in
  read-only|workspace-write) ;;
  *)
    echo "ERROR: Unsupported --sandbox value: $SANDBOX (allowed: read-only | workspace-write)" >&2
    exit 2
    ;;
esac

if [[ ! "$TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --timeout must be a positive integer in seconds, got: $TIMEOUT_SEC" >&2
  exit 2
fi

CODEX_BIN="$(command -v codex || true)"
if [[ -z "$CODEX_BIN" && -x "$HOME/.local/bin/codex" ]]; then
  CODEX_BIN="$HOME/.local/bin/codex"
fi
if [[ -z "$CODEX_BIN" ]]; then
  echo "ERROR: codex CLI not found in PATH or ~/.local/bin/codex. Install OpenAI Codex CLI and run 'codex login' first." >&2
  exit 127
fi

resolve_codex_home() {
  local acc="$1"
  if [[ -n "$CUSTOM_CODEX_HOME" ]]; then
    printf '%s' "$CUSTOM_CODEX_HOME"
    return
  fi
  if [[ -z "$acc" ]]; then
    printf '%s' "${CODEX_HOME:-$HOME/.codex}"
    return
  fi
  if [[ "$acc" == "default" || "$acc" == "1" ]]; then
    printf '%s' "$HOME/.codex"
    return
  fi
  if [[ ! "$acc" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: Invalid account alias '$acc' (allowed characters: A-Z, a-z, 0-9, '.', '_', '-')." >&2
    exit 2
  fi
  if [[ -d "$HOME/.codex-$acc" ]]; then
    printf '%s' "$HOME/.codex-$acc"
  else
    printf '%s' "$HOME/.codex-accounts/$acc"
  fi
}

ensure_account_dir() {
  local dir="$1"
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true
  local cfg="$dir/config.toml"
  if [[ ! -f "$cfg" ]]; then
    printf 'cli_auth_credentials_store = "file"\n' > "$cfg"
    chmod 600 "$cfg" 2>/dev/null || true
  elif ! grep -qE '^\s*cli_auth_credentials_store\s*=' "$cfg"; then
    printf '\ncli_auth_credentials_store = "file"\n' >> "$cfg"
  fi
}

print_account_status() {
  local label="$1"
  local dir="$2"
  local st
  if st="$(CODEX_HOME="$dir" "$CODEX_BIN" login status 2>&1)"; then
    printf '%-14s | %-42s | %s\n' "$label" "$dir" "$st"
  else
    printf '%-14s | %-42s | NOT LOGGED IN (%s)\n' "$label" "$dir" "${st//$'\n'/ }"
  fi
}

if [[ "$MODE" == "accounts" ]]; then
  echo "ACCOUNT        | CODEX_HOME                                 | STATUS"
  echo "---------------+--------------------------------------------+------------------------------"
  print_account_status "default" "$HOME/.codex"
  if [[ -d "$HOME/.codex-accounts" ]]; then
    for d in "$HOME/.codex-accounts"/*; do
      [[ -d "$d" ]] && print_account_status "$(basename "$d")" "$d"
    done
  fi
  for d in "$HOME"/.codex-*; do
    [[ -d "$d" ]] || continue
    bn="$(basename "$d")"
    [[ "$bn" == ".codex-accounts" ]] && continue
    [[ -f "$d/config.toml" || -f "$d/auth.json" ]] || continue
    print_account_status "${bn#.codex-}" "$d"
  done
  exit 0
fi

TARGET_HOME="$(resolve_codex_home "$ACCOUNT")"

if [[ "$MODE" == "init-account" ]]; then
  if [[ -z "$ACCOUNT" && -z "$CUSTOM_CODEX_HOME" ]]; then
    echo "ERROR: init-account mode requires --account <name> or --codex-home <dir>." >&2
    exit 2
  fi
  ensure_account_dir "$TARGET_HOME"
  echo "Initialized account directory: $TARGET_HOME"
  print_account_status "${ACCOUNT:-custom}" "$TARGET_HOME"
  echo "If not yet logged in, run the following in your interactive terminal:"
  echo "  CODEX_HOME=\"$TARGET_HOME\" \"$CODEX_BIN\" login"
  exit 0
fi

export CODEX_HOME="$TARGET_HOME"

if [[ ! -d "$TARGET_HOME" ]]; then
  echo "ERROR: Account directory does not exist: $TARGET_HOME (run '--mode init-account --account ${ACCOUNT:-2}' and log in first)." >&2
  exit 2
fi

if [[ ! -d "$CWD" ]]; then
  echo "ERROR: Working directory does not exist: $CWD" >&2
  exit 2
fi

if [[ -n "$OUTPUT_SCHEMA" && ! -f "$OUTPUT_SCHEMA" ]]; then
  echo "ERROR: File specified by --output-schema does not exist: $OUTPUT_SCHEMA" >&2
  exit 2
fi

if [[ "${#IMAGES[@]}" -gt 0 ]]; then
  if [[ "$MODE" == "review" ]]; then
    echo "ERROR: --image is not supported in review mode; use '--mode exec --sandbox read-only' for image-assisted analysis." >&2
    exit 2
  fi
  for img in "${IMAGES[@]}"; do
    if [[ ! -f "$img" ]]; then
      echo "ERROR: File specified by --image does not exist: $img" >&2
      exit 2
    fi
  done
fi

if [[ -n "$PROMPT_FILE" ]]; then
  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: File specified by --prompt-file does not exist: $PROMPT_FILE" >&2
    exit 2
  fi
  PROMPT_TEXT="$(cat "$PROMPT_FILE")"
elif [[ -z "$PROMPT_TEXT" && ! -t 0 ]]; then
  PROMPT_TEXT="$(cat)"
fi

# Strip whitespace-only input so an empty non-interactive pipe (e.g. /dev/null) is not treated as a prompt
PROMPT_NONEMPTY="${PROMPT_TEXT#"${PROMPT_TEXT%%[![:space:]]*}"}"
if [[ -z "$PROMPT_NONEMPTY" ]]; then
  PROMPT_TEXT=""
fi

if [[ "$MODE" == "review" ]]; then
  REVIEW_SCOPE_COUNT=0
  [[ "$UNCOMMITTED" -eq 1 ]] && REVIEW_SCOPE_COUNT=$((REVIEW_SCOPE_COUNT + 1))
  [[ -n "$BASE_BRANCH" ]] && REVIEW_SCOPE_COUNT=$((REVIEW_SCOPE_COUNT + 1))
  [[ -n "$COMMIT_SHA" ]] && REVIEW_SCOPE_COUNT=$((REVIEW_SCOPE_COUNT + 1))

  if [[ "$REVIEW_SCOPE_COUNT" -gt 1 ]]; then
    echo "ERROR: In review mode, --uncommitted, --base, and --commit are mutually exclusive; specify at most one." >&2
    exit 2
  fi
  if [[ "$REVIEW_SCOPE_COUNT" -gt 0 && -n "$PROMPT_TEXT" ]]; then
    echo "ERROR: In review mode, --uncommitted / --base / --commit cannot be combined with a custom prompt. Use '--mode exec --sandbox read-only' for custom review instructions, or pass a prompt without scope flags." >&2
    exit 2
  fi
fi

if [[ "$MODE" == "resume" ]]; then
  if [[ "$USE_LAST" -eq 0 && -z "$SESSION_ID" ]]; then
    echo "ERROR: resume mode requires --last or --session-id <id>." >&2
    exit 2
  fi
  if [[ "$USE_LAST" -eq 1 && -n "$SESSION_ID" ]]; then
    echo "ERROR: In resume mode, --last and --session-id are mutually exclusive; specify only one." >&2
    exit 2
  fi
fi

TMP_DIR="$(mktemp -d)"
OUT_FILE="$TMP_DIR/last_message.md"
ERR_FILE="$TMP_DIR/stderr.log"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Top-level exec flags must appear after 'exec' and before any subcommand (review/resume)
CMD=("$CODEX_BIN" "exec" "--color" "never" "-C" "$CWD" "--skip-git-repo-check")

if [[ "$MODE" == "exec" || "$MODE" == "resume" ]]; then
  CMD+=("--sandbox" "$SANDBOX")
fi
if [[ -n "$MODEL" ]]; then
  CMD+=("-m" "$MODEL")
fi
if [[ "$WORKTREE" -eq 1 ]]; then
  CMD+=("--worktree")
fi
if [[ "$TRUST" -eq 1 ]]; then
  CMD+=("--trust")
fi
if [[ -n "$OUTPUT_SCHEMA" ]]; then
  CMD+=("--output-schema" "$OUTPUT_SCHEMA")
fi
# Apply --ephemeral by default for exec/review unless --keep-session is set; resume preserves continuity
if [[ ("$MODE" == "exec" || "$MODE" == "review") && "$KEEP_SESSION" -eq 0 ]]; then
  CMD+=("--ephemeral")
fi
# Place -i before -o in exec mode so variadic <FILE>... does not greedily consume positional "-"
if [[ "$MODE" == "exec" && "${#IMAGES[@]}" -gt 0 ]]; then
  for img in "${IMAGES[@]}"; do
    CMD+=("-i" "$img")
  done
fi
CMD+=("-o" "$OUT_FILE")

case "$MODE" in
  exec)
    ;;
  review)
    CMD+=("review")
    [[ "$UNCOMMITTED" -eq 1 ]] && CMD+=("--uncommitted")
    [[ -n "$BASE_BRANCH" ]] && CMD+=("--base" "$BASE_BRANCH")
    [[ -n "$COMMIT_SHA" ]] && CMD+=("--commit" "$COMMIT_SHA")
    ;;
  resume)
    CMD+=("resume")
    if [[ "${#IMAGES[@]}" -gt 0 ]]; then
      for img in "${IMAGES[@]}"; do
        CMD+=("-i" "$img")
      done
    fi
    [[ "$USE_LAST" -eq 1 ]] && CMD+=("--last")
    [[ -n "$SESSION_ID" ]] && CMD+=("$SESSION_ID")
    ;;
esac

if [[ -n "$PROMPT_TEXT" ]]; then
  CMD+=("-")
fi

cd "$CWD"
set +e
if [[ -n "$PROMPT_TEXT" ]]; then
  if command -v timeout >/dev/null 2>&1; then
    printf '%s' "$PROMPT_TEXT" | timeout -k 10s "${TIMEOUT_SEC}s" "${CMD[@]}" >/dev/null 2>"$ERR_FILE"
  else
    printf '%s' "$PROMPT_TEXT" | "${CMD[@]}" >/dev/null 2>"$ERR_FILE"
  fi
else
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 10s "${TIMEOUT_SEC}s" "${CMD[@]}" >/dev/null 2>"$ERR_FILE"
  else
    "${CMD[@]}" >/dev/null 2>"$ERR_FILE"
  fi
fi
RC=$?
set -e

if [[ -s "$OUT_FILE" ]]; then
  cat "$OUT_FILE"
fi

if [[ "$RC" -ne 0 ]]; then
  echo "" >&2
  echo "=== CODEX_FAILED (exit=$RC, CODEX_HOME=$CODEX_HOME) ===" >&2
  if [[ -s "$ERR_FILE" ]]; then
    tail -n 60 "$ERR_FILE" >&2
  fi
  exit "$RC"
fi
