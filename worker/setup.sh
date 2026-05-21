#!/usr/bin/env bash
#
# MCL Tech — Cloudflare Worker one-command deploy
#
# Run from worker/ directory: ./setup.sh
#
# Prerequisites:
#  - Node 18+ (you have it if `node --version` works)
#  - A free Cloudflare account (sign up at dash.cloudflare.com)
#  - An Anthropic API key (platform.claude.com/settings/keys)
#
# What this does (you do nothing except click an OAuth screen + paste a key):
#  1. Installs wrangler
#  2. Opens your browser for Cloudflare login (one click)
#  3. Creates two KV namespaces, captures both IDs
#  4. Patches wrangler.toml with the IDs
#  5. Prompts for your Anthropic API key, sets it as a secret
#  6. Deploys the worker, captures the workers.dev URL
#  7. Patches build/index.html with the URL
#  8. Commits both patches and pushes them
#
set -euo pipefail

GREEN='\033[1;32m'; RED='\033[1;31m'; YELLOW='\033[1;33m'; CYAN='\033[1;36m'; DIM='\033[2m'; RESET='\033[0m'
step() { echo -e "\n${CYAN}━━━ $* ━━━${RESET}"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
die()  { echo -e "${RED}✗${RESET} $*"; exit 1; }

# Must be run from worker/
[[ -f wrangler.toml && -f src/index.js ]] || die "Run this from the worker/ directory (cd worker && ./setup.sh)"

# Prereqs
command -v node >/dev/null || die "node not installed — get it from nodejs.org (need 18+)"
command -v npm  >/dev/null || die "npm not installed"
NODE_MAJOR=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
[[ "$NODE_MAJOR" -ge 18 ]] || die "node $NODE_MAJOR is too old — need 18+"

# 1. install
step "1/7  Installing wrangler"
npm install --silent --no-audit --no-fund
ok "wrangler installed"

# 2. login
step "2/7  Cloudflare login"
if npx --no-install wrangler whoami >/dev/null 2>&1; then
  ok "Already authenticated"
else
  echo -e "${DIM}Your browser will open. Sign in to your Cloudflare account.${RESET}"
  npx wrangler login
  ok "Logged in"
fi

# 3. KV namespaces (idempotent — wrangler errors if a namespace name already exists,
# so we tolerate that and re-discover the IDs via `kv namespace list`)
step "3/7  Creating KV namespaces"
create_kv() {
  local flag="$1"  # "" for prod, "--preview" for preview
  local out
  if out=$(npx wrangler kv namespace create RATE_LIMIT $flag 2>&1); then
    echo "$out"
  else
    if echo "$out" | grep -qiE 'already exists|namespace.*exists'; then
      echo "$out"
      return 0
    fi
    echo "$out" >&2
    return 1
  fi
}
PROD_OUT=$(create_kv "") || die "Failed to create production KV namespace"
PREVIEW_OUT=$(create_kv "--preview") || die "Failed to create preview KV namespace"

# Parse IDs from wrangler output (handles both new TOML snippet and legacy formats)
extract_id() {
  echo "$1" | grep -oE '"[a-f0-9]{32}"' | head -1 | tr -d '"'
}
KV_ID=$(extract_id "$PROD_OUT")
KV_PREVIEW_ID=$(extract_id "$PREVIEW_OUT")

# Fallback: query the namespace list if extraction failed (namespace exists from prior run)
if [[ -z "$KV_ID" || -z "$KV_PREVIEW_ID" ]]; then
  warn "Couldn't parse new IDs from output, listing existing namespaces..."
  LIST_JSON=$(npx wrangler kv namespace list 2>/dev/null || echo "[]")
  KV_ID=${KV_ID:-$(echo "$LIST_JSON" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
      try { const arr=JSON.parse(d); const m=arr.find(n=>n.title.endsWith('-RATE_LIMIT') && !n.title.includes('preview'));
            if(m) console.log(m.id); } catch(_) {}
    });
  ")}
  KV_PREVIEW_ID=${KV_PREVIEW_ID:-$(echo "$LIST_JSON" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
      try { const arr=JSON.parse(d); const m=arr.find(n=>n.title.includes('preview') && n.title.endsWith('RATE_LIMIT'));
            if(m) console.log(m.id); } catch(_) {}
    });
  ")}
fi

[[ -n "$KV_ID" && -n "$KV_PREVIEW_ID" ]] || die "Couldn't capture KV namespace IDs. Re-run, or set them manually in wrangler.toml"
ok "Production:  $KV_ID"
ok "Preview:     $KV_PREVIEW_ID"

# 4. patch wrangler.toml
step "4/7  Patching wrangler.toml"
sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$KV_ID/g" wrangler.toml
sed -i.bak "s/REPLACE_WITH_KV_PREVIEW_ID/$KV_PREVIEW_ID/g" wrangler.toml
rm -f wrangler.toml.bak
ok "wrangler.toml updated"

# 5. secret
step "5/7  Setting Anthropic API key as a secret"
echo -e "${DIM}Paste your Anthropic API key when prompted. Get one at https://platform.claude.com/settings/keys${RESET}"
if npx wrangler secret list 2>/dev/null | grep -q ANTHROPIC_API_KEY; then
  warn "ANTHROPIC_API_KEY secret already exists — leaving it alone. Delete it manually if you want to rotate."
else
  npx wrangler secret put ANTHROPIC_API_KEY
fi
ok "Secret set"

# 6. deploy
step "6/7  Deploying"
DEPLOY_OUT=$(npx wrangler deploy 2>&1 | tee /dev/tty)
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://mcl-instant\.[a-zA-Z0-9.-]+\.workers\.dev' | head -1)
[[ -n "$WORKER_URL" ]] || die "Couldn't parse worker URL from wrangler output — copy it manually from above and replace WORKER_URL_REPLACE_ME in ../build/index.html"
ok "Deployed: $WORKER_URL"

# 7. patch build page + commit + push
step "7/7  Patching build/index.html and pushing"
sed -i.bak "s|WORKER_URL_REPLACE_ME|${WORKER_URL}/generate|g" ../build/index.html
rm -f ../build/index.html.bak

cd ..
if [[ -n "$(git status --porcelain worker/wrangler.toml build/index.html)" ]]; then
  git add worker/wrangler.toml build/index.html
  git commit -m "Wire deployed worker — KV IDs + production URL

https://claude.ai/code/session_017rGCzqjtHqzNtbJfYfZo43"
  if git push origin HEAD 2>&1 | tee /tmp/push.out | grep -q "rejected"; then
    warn "Push rejected (likely branch protection on main). Pushing to a branch instead..."
    BRANCH="wire-worker-$(date +%s)"
    git checkout -b "$BRANCH"
    git push -u origin "$BRANCH"
    echo -e "\n${YELLOW}Open a PR for '$BRANCH' and merge to go fully live.${RESET}"
  else
    ok "Pushed"
  fi
else
  ok "No file changes to commit (already patched)"
fi

echo -e "\n${GREEN}═══════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}  ✓ DEPLOYED${RESET}"
echo -e "${GREEN}  Worker:  ${WORKER_URL}${RESET}"
echo -e "${GREEN}  Page:    https://mcldigital.tech/build/${RESET}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${RESET}"
echo ""
echo "Quick smoke test:"
echo "  curl -X POST ${WORKER_URL}/generate \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"prompt\":\"I run a small bakery in Bangor specialising in sourdough\"}'"
echo ""
