# mcl-instant — Cloudflare Worker

Proxies the `/build` lead magnet on **mcldigital.tech** to the Anthropic API with streaming. Keeps the API key server-side; rate-limits by IP.

## Deploy

**Primary path: GitHub Actions** (no local terminal needed).

Add two repo secrets at https://github.com/mcljd/mcldigital/settings/secrets/actions:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | from https://dash.cloudflare.com/profile/api-tokens |
| `ANTHROPIC_API_KEY` | from https://platform.claude.com/settings/keys |

Then go to **Actions → Deploy Cloudflare Worker → Run workflow**, or push a change under `worker/**`. The workflow handles KV creation, secret rotation, deploy, URL patching, and a smoke test.

**Fallback: `./setup.sh` from this directory** runs the same flow locally if you'd rather not use Actions.

## What it does

`POST /generate` with `{ "prompt": "..." }` (≤ 500 chars) →
streamed `text/plain` response containing the generated single-file HTML.

- Model: `claude-sonnet-4-6`
- Max output: 4000 tokens
- Thinking: disabled
- Effort: `low` (fast + cheap)
- System prompt is cached (`cache_control: { type: "ephemeral" }`) — first request warms the cache, subsequent requests pay ~10% the input cost

## Limits & safety

- Prompt: 5–500 chars, rejected if it contains common injection phrases
- Rate limit: **3 generations / IP / hour** via Cloudflare KV (`RATE_LIMIT` binding, hour-bucketed keys with 3600s TTL)
- CORS: only `https://mcldigital.tech`, `https://www.mcldigital.tech`, and `localhost` are allowed origins
- Errors are mapped to friendly client messages; Anthropic auth/server errors are logged but never echoed to the client

## First-time deploy

```bash
cd worker
npm install

npx wrangler login

# 1. Create the KV namespace and paste both IDs into wrangler.toml
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create RATE_LIMIT --preview

# 2. Set the Anthropic key as a secret
npx wrangler secret put ANTHROPIC_API_KEY

# 3. Ship it
npx wrangler deploy
```

The worker will be reachable at `https://mcl-instant.<your-account>.workers.dev`.
Paste that URL into `build/index.html` (search for `WORKER_URL_REPLACE_ME`).

## Local dev

```bash
cp .dev.vars.example .dev.vars
# paste your Anthropic key into .dev.vars

npm run dev
# → http://localhost:8787
```

The `/build/index.html` page auto-detects `localhost` and posts to `http://localhost:8787/generate` in dev.

## Cost guardrails

At Sonnet 4.6 streaming rates, a 4000-token output costs ~€0.06. Rate limit caps each IP at 3/hour = ~€0.18/IP/hour worst case. If usage spikes beyond expected:

1. Check `npx wrangler tail` for the prompts hitting the worker
2. Tighten `RATE_LIMIT_PER_HOUR` in `src/index.js` (currently 3)
3. Consider adding a Cloudflare WAF rule if you see distributed abuse

## Observability

Logs (info + errors) stream via `npx wrangler tail` once deployed. Workers Analytics auto-tracks request counts, error rates, and CPU time in the Cloudflare dashboard.
