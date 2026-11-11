# Architecture

Two views of the same thing: a rendered diagram, and a Mermaid source you can
edit. Both describe the code as it is, not as it was planned.

![web_search architecture](./architecture.svg)

The rasterised copy is [`architecture.png`](./architecture.png) for renderers
that do not handle SVG.

## Diagram source

```mermaid
flowchart TD
    A["Pi — model emits a tool call"] --> B["index.ts<br/><sub>Type.Object schema · onUpdate · truncateHead · renderCall/renderResult</sub>"]
    B --> C["search.ts — parse query<br/><sub>→ StructuredQuery</sub>"]
    C --> D["resolveChain<br/><sub>config chain → [{provider, explicit}]</sub>"]
    D --> E{"candidate left?"}
    E -- yes --> F{"isAvailable(credentials)?"}
    F -- no --> E
    F -- "skip silently" --> E
    F -- yes --> G["provider.search({ timeoutMs })<br/><sub>one attempt — no retry, no backoff</sub>"]
    G --> H{"renderable? + looksRelevant()?"}
    H -- "no → 204" --> E
    H -- yes --> I["relax unsatisfiable directives<br/><sub>emits a Note · cannot advance the chain</sub>"]
    I --> J["format<br/><sub>Note → Provider → ## Sources</sub>"]
    J --> K["return result + details<br/><sub>failures[] · timings[]</sub>"]
    E -- no --> L["failures → error result<br/><sub>or, if the chain was empty, a config error</sub>"]

    subgraph registry["providers/registry.ts — 16 modules, one shape"]
        direction LR
        P1["9 need no credential<br/><sub>exa · keenable · parallel · bing · duckduckgo<br/>firecrawl · startpage · bravehtml · marginalia</sub>"]
        P2["6 need a key<br/><sub>tavily · brave · searxng · kagi · jina · deepseek</sub>"]
        P3["public<br/><sub>fan-out aggregate, explicit only</sub>"]
    end

    G -.-> registry
```

## Reading order

| Layer | File | Why it exists |
|---|---|---|
| Pi glue | `index.ts` | Schema, partial-result updates, output truncation, TUI renderers, `/websearch`. No search logic. |
| Orchestrator | `search.ts` | The chain walk, the guards, formatting, provenance. Imports nothing from `@earendil-works/*`, so it runs under `bun`/`node`. |
| Config | `config.ts` | Chain order, limits, timeouts, credentials. Resolved per call. |
| Query | `query.ts` | Directive parser, per-engine query formatting, lenient constraint filter, relevance guard. |
| Providers | `providers/*.ts` | One module per engine, all shaped `{ id, label, isAvailable, search }`. |

## The three facts worth remembering

1. **One attempt per candidate.** There is no retry or backoff anywhere. A `429`
   from a rate limiter says the same thing 300 ms later, so the chain — 16
   independent providers — is the retry.
2. **`204` is the failure signal for "answered, but unusable".** A provider that
   returns nothing, or returns results unrelated to the query, throws `204` and
   the chain advances exactly as if it had errored.
3. **Two things look like fallback but are not.** Constraint relaxation runs
   *after* a candidate has already won and can only annotate the answer.
   `looksRelevant` runs before and is a veto that re-enters the fallback loop.
