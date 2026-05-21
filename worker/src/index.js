// MCL Tech — Instant Site Builder
// Cloudflare Worker that proxies POST /generate to Anthropic with streaming.
//
// Security:
//  - ANTHROPIC_API_KEY lives as a Wrangler secret; never returned to client
//  - Prompt length capped at 500 chars
//  - Basic prompt-injection guard
//  - 3 generations per IP per hour via Cloudflare KV (RATE_LIMIT binding)
//
// Streaming:
//  - Anthropic SSE -> plain text deltas piped to the response body
//  - Frontend accumulates and sets iframe.srcdoc as HTML grows

const ALLOWED_ORIGINS = [
  'https://mcldigital.tech',
  'https://www.mcldigital.tech',
];

const MAX_PROMPT_LEN = 500;
const MIN_PROMPT_LEN = 5;
const MAX_TOKENS = 4000;
const RATE_LIMIT_PER_HOUR = 3;

// System prompt — static, cacheable. Any byte change here invalidates the prompt cache.
const SYSTEM_PROMPT = `You are a senior front-end developer who builds beautiful, conversion-focused landing pages for small businesses across Northern Ireland and the UK.

The user will describe their business in one sentence. Generate a complete, single-file HTML landing page tailored to that business.

CRITICAL OUTPUT RULES (the response is rendered directly in a browser):
- Output ONLY raw HTML. Start the response with <!DOCTYPE html> and nothing before it.
- NO markdown fences (\`\`\`html or \`\`\`), NO commentary before or after, NO explanation.
- Single file: all CSS in one inline <style> tag inside <head>. JavaScript is optional; if present, keep it tiny and inline at the end of <body>.

DESIGN BRIEF:
- Mobile-first, responsive from 320px up. Use clamp() for fluid typography.
- Google Fonts via @import in the <style> tag. PICK TASTEFUL PAIRINGS — NEVER Inter, Roboto, or Arial. Pick from: Fraunces, Manrope, Plus Jakarta Sans, Space Grotesk, DM Sans, Playfair Display, Crimson Pro, Cormorant Garamond, Bricolage Grotesque, Outfit, Lora, Source Serif Pro. A display + body pairing is best.
- Choose a colour palette that fits the business:
  - Butcher / bakery / cafe: warm reds, cream, off-white, deep brown accent
  - Strength coach / gym / fitness: bold black, electric yellow or lime, sharp contrast
  - Boat charter / sailing / marine: deep navy, sand, soft white, brass accent
  - Microbrewery / craft beer: amber, cream, hop green
  - Hair salon / beauty: muted rose or terracotta, charcoal, ivory
  - Tradesperson (plumber, electrician, builder): confident navy, white, accent yellow
  - Restaurant / fine dining: forest green or burgundy, cream, gold accent
  - Tech / SaaS / consultancy: dark slate, single bright accent, generous whitespace
  - Otherwise pick something thoughtful and specific to the vibe — not generic.
- NO IMAGES whatsoever (no <img>, no SVG illustrations beyond simple icons). Use CSS gradients, geometric shapes, oversized typography, generous whitespace for visual interest.
- One bold visual signature element (e.g. an oversized headline word with a coloured underline, a diagonal section divider, a circular brand mark made from text). Do not over-design.

SECTIONS (in this order):
1. Hero — business name as the strongest element on the page, a one-line value proposition, two CTAs ("Book now" / "Get in touch" or appropriate equivalents). No nav bar.
2. About — 2 short paragraphs (max 60 words each), locally rooted Northern Irish voice. No "we pride ourselves", no "passionate", no clichés.
3. Three services or offerings — title + 1-2 line description for each, laid out as a clean grid.
4. One testimonial — invented but plausible, with a believable Northern Irish first name + last initial + town. Use: Belfast, Bangor, Newry, Derry/Londonderry, Lisburn, Coleraine, Antrim, Ballymena, Carrickfergus, Larne, Newtownards, Holywood, Hillsborough. Quote should sound like a real customer, not a marketing line.
5. Contact CTA — full-width section with email shown clearly. Wire the primary button as <a href="mailto:hello@[business-slug].co.uk"> with subject line set. Include opening hours if relevant to the business type.
6. Footer — small, plain. Copyright + business name + town. Nothing else.

TONE:
- Warm, confident, plainspoken. Like a good local business owner who isn't trying too hard.
- Locally rooted without being kitsch. ABSOLUTELY NO leprechauns, NO shamrocks, NO "wee", NO "craic", NO "top of the morning". Avoid stage-Irish language entirely.
- Short sentences. Active voice. Specific details over generic claims.
- Names: pick a real-sounding business name based on the description (e.g. "Antrim Iron & Fire" for a butcher, "Strand Boatworks" for boat charter). Avoid the user's exact words as the literal business name unless they obviously provided one.

LENGTH BUDGET:
- The entire response MUST fit comfortably under 4000 tokens.
- Prefer a tight design system (3-4 CSS custom properties for colour, 2 fonts, 5-6 reusable utility classes) over verbose CSS.
- Skip CSS resets beyond the basics. Skip vendor prefixes.

START NOW. <!DOCTYPE html>`;

// ---------- helpers ----------

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin || '') || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonError(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function looksLikeInjection(prompt) {
  const patterns = [
    /ignore\s+(previous|prior|all|above|earlier)/i,
    /system\s+prompt/i,
    /new\s+instructions/i,
    /disregard\s+(previous|prior|the\s+above)/i,
    /override\s+(your|the)\s+(instructions|rules)/i,
    /you\s+are\s+now\s+a/i,
    /forget\s+(everything|your|all\s+previous)/i,
  ];
  return patterns.some((re) => re.test(prompt));
}

// Parse Anthropic SSE response, emit only the text deltas as a plain ReadableStream.
function anthropicSSEToTextStream(sourceBody) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = sourceBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by \n\n; each event has data: lines.
          let nlIdx;
          while ((nlIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nlIdx);
            buffer = buffer.slice(nlIdx + 1);
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (!data || data === '[DONE]') continue;
            try {
              const event = JSON.parse(data);
              if (
                event.type === 'content_block_delta' &&
                event.delta &&
                event.delta.type === 'text_delta' &&
                typeof event.delta.text === 'string'
              ) {
                controller.enqueue(encoder.encode(event.delta.text));
              } else if (event.type === 'error') {
                controller.enqueue(encoder.encode(`\n\n[Generation error: ${event.error?.message || 'unknown'}]`));
              }
            } catch (_) {
              // Ignore unparseable SSE frames (heartbeats, etc.)
            }
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ---------- main handler ----------

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonError(405, 'Method not allowed', origin);
    }

    const url = new URL(request.url);
    if (!url.pathname.endsWith('/generate')) {
      return jsonError(404, 'Not found', origin);
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonError(400, 'Invalid JSON body', origin);
    }

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return jsonError(400, 'Missing prompt', origin);
    if (prompt.length < MIN_PROMPT_LEN) return jsonError(400, 'Prompt too short — give us a sentence about your business.', origin);
    if (prompt.length > MAX_PROMPT_LEN) return jsonError(400, `Prompt too long (max ${MAX_PROMPT_LEN} chars).`, origin);
    if (looksLikeInjection(prompt)) {
      return jsonError(400, 'Prompt rejected. Please describe your business in plain language.', origin);
    }

    // Rate limit by Cloudflare-connecting IP, bucketed per hour.
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const rlKey = `rl:${ip}:${hourBucket}`;

    let count = 0;
    try {
      const raw = await env.RATE_LIMIT.get(rlKey);
      count = raw ? parseInt(raw, 10) || 0 : 0;
    } catch (err) {
      // KV unavailable — fail open (don't block legitimate traffic), but log.
      console.warn('KV read failed:', err);
    }
    if (count >= RATE_LIMIT_PER_HOUR) {
      return jsonError(429, `You've hit the limit of ${RATE_LIMIT_PER_HOUR} builds per hour. Try again later, or book a call to chat through what you need.`, origin);
    }

    // Increment before calling Anthropic so simultaneous requests don't blow the budget.
    try {
      await env.RATE_LIMIT.put(rlKey, String(count + 1), { expirationTtl: 3600 });
    } catch (err) {
      console.warn('KV write failed:', err);
    }

    // Call Anthropic with streaming.
    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: MAX_TOKENS,
          stream: true,
          thinking: { type: 'disabled' },
          output_config: { effort: 'low' },
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (err) {
      console.error('Anthropic fetch failed:', err);
      return jsonError(502, 'Generation service unavailable. Try again.', origin);
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      console.error('Anthropic non-OK:', upstream.status, text.slice(0, 500));
      const status = upstream.status === 401 ? 500 : upstream.status >= 500 ? 502 : 500;
      return jsonError(status, 'Generation failed. Try again in a moment.', origin);
    }

    const stream = anthropicSSEToTextStream(upstream.body);

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        ...corsHeaders(origin),
      },
    });
  },
};
