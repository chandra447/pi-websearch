# web-search — a Pi extension

A port of [oh-my-pi](https://github.com/can1357/oh-my-pi)'s web search to Pi:
**an ordered fallback chain of providers, most of which need no API key.**

Registered as the `web_search` tool plus a `/websearch` command.

## Install

```bash
pi install git:github.com/chandra447/pi-websearch
# or, for local development:
git clone https://github.com/chandra447/pi-websearch \
  ~/.pi/agent/extensions/web-search
```

Either way Pi auto-discovers it on start; `/reload` picks up edits without a
restart. No configuration is required — the keyless providers work immediately.
Verify the checkout with `bun test/probe.ts --fixtures`.

---

## Why a chain

No single search provider is reliable. HTML scrapers hit bot walls, free API
tiers rate limit per IP, keyed APIs expire. oh-my-pi's answer — which this
extension ports — is to treat "search" as an ordered list of candidates and walk
it **sequentially**, returning the first acceptable answer. A provider that
fails costs one round trip and appears in the response as a note:

```
Note: answered by Bing after Firecrawl failed (Firecrawl authorization failed (403). Check the API key …)
```

Five candidates work with zero credentials, so the tool is useful on a fresh
machine before any key exists.

## What the model sees

```
Note: …                                    ← only when a candidate failed or a constraint was relaxed
Provider: Exa (api_key), 229ms              ← always, and FIRST, so it survives truncation
## Sources (5)
[1] Title (3d ago)
    https://…
    snippet (truncated to 240 chars)
## Citations (n)                            ← unused by these providers, kept for a future grounded backend
## Related (n)                              ← Kagi / SearXNG only
Search queries: n                           ← grounded providers only
```

The provenance line sits at the top on purpose. Appended at the end it landed past
the collapsed tool-result fold (`... (9 more lines, ctrl+o to expand)`), so the
answering provider was invisible in the session.

## What the TUI shows

`renderCall` and `renderResult` are defined, so the tool row carries the
provenance instead of dumping raw text:

```
web_search "sqlite WAL mode checkpoint starvation" limit=5
  ✓ Exa (api_key) · 5 sources · 1.7s
```

with fallbacks named on the same line:

```
  ✓ Bing (keyless) · 1 source · 0.3s · fell back after firecrawl
```

Expanding the row (`ctrl+o`) lists sources with titles and URLs from
`details.response.sources` rather than re-rendering the raw markdown, plus one
`warning` line per failed candidate.

## Providers

`keyless` means it runs with no credential at all.

| id | label | keyless | notes |
|---|---|---|---|
| `exa` | Exa | ✅ public MCP tool | fastest keyless path; falls back to `api.exa.ai` when `EXA_API_KEY` is set |
| `keenable` | Keenable | ✅ `/search/public` | clean JSON; `KEENABLE_API_KEY` lifts rate limits |
| `parallel` | Parallel | ✅ `search.parallel.ai/mcp` | best excerpts; free tier is quota-limited per IP |
| `bing` | Bing | ✅ HTML | the only mainstream engine that answered from a shared/VPN egress IP |
| `tavily` | Tavily | — | `TAVILY_API_KEY` |
| `brave` | Brave | — | `BRAVE_API_KEY` |
| `duckduckgo` | DuckDuckGo | ✅ HTML | excellent residential, walled from datacenter/VPN |
| `firecrawl` | Firecrawl | ✅ but IP-gated | `FIRECRAWL_API_KEY`, or `FIRECRAWL_BASE_URL` for self-hosting |
| `searxng` | SearXNG | — | `SEARXNG_ENDPOINT` (+ optional `SEARXNG_TOKEN`) |
| `kagi` | Kagi | — | `KAGI_API_KEY` |
| `jina` | Jina | — | `JINA_API_KEY` (there is no keyless *search* reader) |
| `deepseek` | DeepSeek | — | `DEEPSEEK_API_KEY`; queries capped at 128 chars |
| `startpage` | Startpage | ✅ HTML | challenge-prone; two-step `sc` token flow |
| `bravehtml` | Brave (HTML) | ✅ HTML | challenge-prone |
| `marginalia` | Marginalia | ✅ HTML | small independent index; usually empty for mainstream queries |
| `public` | Public Web | ✅ | aggregate fan-out over every keyless scraper; **explicit only** |

Keyed providers are skipped **silently** when their key is absent, so keeping
them in the chain costs nothing.

## Configuration

Zero config required. Everything is re-read on every tool call, so `/reload` is
never needed for a config or environment change.

`~/.pi/agent/web-search.json` — every field optional:

```json
{
  "chain": ["exa", "keenable", "bing"],
  "disabled": ["duckduckgo"],
  "timeoutSeconds": 20,
  "defaultLimit": 10,
  "maxLimit": 20,
  "recency": null
}
```

| env var | meaning |
|---|---|
| `PI_WEBSEARCH_CHAIN` | comma-separated provider ids, overrides `chain` |
| `PI_WEBSEARCH_DISABLE` | comma-separated ids to drop |
| `PI_WEBSEARCH_TIMEOUT` | per-provider hard timeout, seconds |

A configured `chain` is honored **exactly** — providers you leave out are not
appended. That makes `PI_WEBSEARCH_CHAIN=bing` a real diagnostic tool instead of
"bing first, then everything anyway". `public` cannot appear in a chain (it is
explicit-only); request it with `provider: "public"`.

Credentials come from environment variables only. Pi's auth storage is
deliberately not consulted: it is an internal surface with a broker-managed
refresh pipeline, and a third-party extension reading it would couple to
something upstream can change (and can race a token refresh).

## Query syntax

Google-style directives are parsed once by `query.ts` (adapted from oh-my-pi's
parser: same directive set and the same lenient post-filter, but a simpler token
model — one `filetype:` and parenthesised groups are not supported) into a
`StructuredQuery`, then used three ways:

1. mapped onto each provider's **native** filters where they exist
   (Tavily `include_domains`/`time_range`, Exa `includeDomains`/`startPublishedDate`,
   Bing `site:`/`filetype:`, DDG `df=`, Firecrawl `tbs=`, Kagi `filters.after`, …);
2. re-emitted into the engine query via `formatQuery` with **only** the operators
   that engine understands — never as literal garbage;
3. applied as a **lenient** post-filter (`applyQueryConstraints`). A dimension
   that would eliminate every remaining result is dropped and reported rather
   than returning nothing:

```
Note: no results matched `site:arxiv.org`; the constraint was relaxed
```

Supported: `site:`/`-site:`, `inurl:`/`-inurl:`, `intitle:`/`-intitle:`,
`intext:`, `filetype:`, `lang:`, `after:`/`before:`, `"quoted phrases"`,
`-exclusions`, `OR` groups. Negated directives (`-site:`, `-inurl:`, `-intitle:`,
`-filetype:`) are honored in both the outgoing query and the post-filter.

## Fallback semantics (ported)

- **Sequential**, one candidate at a time. No parallel fan-out in the chain
  (`public` is the parallel one).
- **Per-provider hard timeout** (`AbortSignal.any` of the tool-call signal and a
  ceiling). A timeout is a failure → advance.
- **Availability gating.** The automatic chain skips an unavailable candidate
  silently; an explicit `provider:` pick reports why it could not run.
- **No renderable content is a failure.** A provider returning zero usable
  sources throws with status `204` so the chain advances.
- **Cancellation is rethrown.** An `AbortError` that coincides with an aborted
  tool-call signal must not be recorded as "this provider failed, try the next".
- **All-failed is a normal tool result**, not a throw:
  `Error: All web search providers failed: a: …; b: …` with `details.failures[]`
  carrying `{provider, label, reason, status}`.

## Findings from adversarial review, and what was done

**1. A poisoned SERP is worse than no SERP.** From a shared/VPN egress IP, Bing
answers `tokio async runtime` with **broccoli-recipe pages**: HTTP 200, a correct
`<title>`, ten well-formed `b_algo` blocks — content from someone else's search.
Every structural check passes, so a naive chain hands the model confident
nonsense. `search.ts` therefore runs `looksRelevant()`: if the top five hits
share no vocabulary with the query, the response is rejected as `204` and the
chain advances. Directives-only queries are exempt.

**2. Providers that return plausible-but-empty results are indistinguishable
from success.** Several engines answer 200 with a result-shaped page. Every
provider distinguishes "no parseable results" from "an answer" and throws in the
first case, so the chain advances instead of silently degrading.

**3. An IP block was reported as a bad API key.** `classifyProviderHttpError`
tested `401/403` before looking at the body, so Firecrawl's `403 "your IP looks
like a VPN or proxy"` produced *"authorization failed — check the API key or base
URL"*. The key was fine; the network was the problem. Classification now reads
the body first, and the messages distinguish *"the key is wrong"* from *"this
network is blocked"*.

**4. One unenforceable operator switched the poisoned-SERP guard off.** The guard
was gated on `!hasDirectives`, but `hasDirectives` is set at directive
*recognition* — before validation. So `-intext:spam`, or a malformed
`after:last-tuesday`, left the flag true while enforcing nothing, and disabled
the guard for the whole query. The gate is now "does the parsed query have free
text to compare against", and unenforceable operators emit a `Note:` instead of
being silently discarded.

**5. `public` had no per-engine relevance filter.** The orchestrator's check runs
once on the *merged* top-5, so a poisoned engine's results survived whenever a
good engine also answered. The aggregate now filters each engine's result set
before it enters the consensus index.

**6. An empty chain was diagnosed as missing credentials.** `PI_WEBSEARCH_CHAIN=public`,
or a chain of typo'd ids, reaches zero candidates and used to report *"No web
search provider is available. This should be impossible…"* — sending you to look
for API keys when the actual problem was the chain itself.

## Layout

```
~/.pi/agent/extensions/web-search/
├── index.ts          Pi registration: the web_search tool + /websearch. No logic.
├── search.ts         The orchestrator: chain walk, fallback notes, formatting,
│                     constraint relaxation, relevance guard. Imports nothing from Pi.
├── config.ts         ~/.pi/agent/web-search.json + env → WebSearchConfig / Credentials
├── types.ts          SearchResponse / SearchSource / SearchProviderError / labels
├── query.ts          Adapted from oh-my-pi: directive parser, formatters,
│                     lenient constraint post-filter, recency→date
├── providers/
│   ├── base.ts       SearchParams + the SearchProvider interface
│   ├── utils.ts      withHardTimeout, readJson, error classification, normalization
│   ├── html.ts       Browser headers, entity decoding, capped body read
│   ├── mcp.ts        Minimal JSON-RPC tools/call client (Exa, Parallel)
│   ├── registry.ts   The provider list, in default priority order
│   ├── public.ts     The keyless aggregate meta-provider
│   └── <id>.ts       One module per provider
└── test/probe.ts     Live verification harness (bun test/probe.ts)
```

`index.ts` holds no logic so the orchestrator stays testable without booting Pi;
`search.ts` imports nothing from `@earendil-works/*` for the same reason.

## Verifying

```bash
cd ~/.pi/agent/extensions/web-search
bun test/probe.ts --fixtures     # offline assertions, no network, exits non-zero on failure
bun test/probe.ts --all          # every query, real network
bun test/probe.ts plain          # one query
PI_WEBSEARCH_CHAIN=bing bun test/probe.ts plain        # pin a chain
env -u EXA_API_KEY bun test/probe.ts --all             # force the keyless paths
```

`--fixtures` is not decoration. Every bug this extension has actually shipped was
silent — a poisoned SERP, a directive parsed but never enforced, an error naming
the wrong cause. None of them throw, so none are caught by "did a search return
results". The fixtures pin the two real poisoned SERPs observed in production
(a Bing broccoli result set and a `public` ChatGPT result set), the substring
trap that let them through, and the classification order that made an IP block
read as a bad API key.

Measured on macOS, Node 26, from a shared/VPN egress IP:

| provider | result | latency |
|---|---|---|
| `exa` (keyless MCP) | 5 sources | ~0.5 s |
| `exa` (API key) | 5 sources | ~0.2 s |
| `keenable` (keyless) | 3 sources | ~0.4 s |
| `parallel` (keyless MCP) | 3 sources, quota-flaky | ~1.0 s |
| `bing` (HTML) | sources, but **poisoned for some queries** | ~0.3 s |
| `duckduckgo` (HTML) | bot wall (`anomaly-modal`, HTTP 202) | — |
| `firecrawl` (keyless) | 403, IP flagged as VPN/proxy | — |
| `startpage` (HTML) | captcha | — |
| `marginalia` (HTML) | empty for mainstream queries | — |
| `tavily` (key) | 5 sources | ~0.3 s |

Those results are why the default chain leads with the keyless **API** services
and puts the challenge-prone scrapers last.

## Adding a provider

1. `providers/<id>.ts` exporting `searchX(params: SearchParams)` and an
   `xProvider: SearchProvider` object.
2. Add the id to `SearchProviderId` + `SEARCH_PROVIDER_LABELS` in `types.ts`.
3. Add it to `KNOWN_PROVIDER_IDS` and `DEFAULT_CHAIN` in `config.ts`.
4. Add it to `PROVIDERS` in `providers/registry.ts`.

Throw `SearchProviderError(id, message, status?)` on any failure — silence is
reserved for success.
