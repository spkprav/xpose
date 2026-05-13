#!/usr/bin/env bash
# Ensure ollama binary, daemon, and required model are ready for wiki:keywords.
# Idempotent: safe to re-run. Override model via OLLAMA_MODEL env.

set -euo pipefail

MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"

step() { printf "\033[1m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

# ── 1. binary ─────────────────────────────────────────────────────────
step "Checking ollama binary"
if command -v ollama >/dev/null 2>&1; then
  ok "ollama installed: $(ollama --version 2>/dev/null | head -1)"
else
  warn "ollama not found, installing"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install ollama
      else
        die "Homebrew missing. Install from https://brew.sh or grab ollama from https://ollama.com/download"
      fi
      ;;
    Linux)
      curl -fsSL https://ollama.com/install.sh | sh
      ;;
    *)
      die "Unsupported OS $(uname -s). Install manually: https://ollama.com/download"
      ;;
  esac
  ok "installed: $(ollama --version 2>/dev/null | head -1)"
fi

# ── 2. daemon ─────────────────────────────────────────────────────────
step "Checking ollama daemon at $OLLAMA_HOST"
if curl -sf "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  ok "daemon reachable"
else
  warn "daemon not running, starting in background"
  nohup ollama serve >/tmp/ollama.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if curl -sf "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
      ok "daemon up (after ${i}s)"
      break
    fi
  done
  curl -sf "$OLLAMA_HOST/api/tags" >/dev/null 2>&1 \
    || die "daemon did not start. Tail /tmp/ollama.log for details."
fi

# ── 3. model ──────────────────────────────────────────────────────────
step "Checking model $MODEL"
if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$MODEL"; then
  ok "$MODEL already pulled"
else
  warn "$MODEL not present, pulling (this can take a while)"
  ollama pull "$MODEL"
  ok "$MODEL ready"
fi

printf "\n\033[1;32mAll set.\033[0m  Run: npm run wiki:keywords -- <screen_name>\n"
