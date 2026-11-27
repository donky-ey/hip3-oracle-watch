# HTTP API for front ends

Read-only JSON over HTTP, served by `npm run serve` or `npm start`. No
authentication. Response types are in the `@hip3-oracle-watch/api-types` workspace
package ([source](../packages/api-types/src/index.ts)). It imports nothing, so it
can also be copied into a project outside this repository.

Base URL in local development: `http://127.0.0.1:8787`

## Conventions

- Perp names look like `xyz:SKHX`. A bare ticker (`SKHX`, any case) is accepted in
  paths. In a URL the colon may be written as is or as `%3A`.
- `/v1/coin/{coin}` and `/v1/coins` use epoch milliseconds for every time, so
  values can go straight into a chart. The older routes use ISO 8601 strings.
- Basis is `(mark / oracle - 1) * 10000`, in basis points. Negative means the perp
  trades below its oracle.
- `fundingHourly` is a fraction per hour: `0.0005` is 0.05%.
- Oracle `state` is inferred from public data. Show it as an inference.
- Errors are `{ "error": "..." }` with status 400 (bad parameter), 404 (unknown
  perp or route) or 405 (anything but GET).
- Every response carries `Access-Control-Allow-Origin` (default `*`, change with
  `--cors-origin`).

## Routes for a detail page

### `GET /v1/coins`

All perps with data in the last six hours, sorted by name. Use it for a picker or
for `generateStaticParams`.

```json
{ "coins": [{ "coin": "xyz:SKHX", "category": "stocks", "venue": "krx" }] }
```

`venue` is `null` when the reference market has not been identified.

### `GET /v1/coin/{coin}?hours=24&intervalMinutes=5`

Everything one detail page needs, in one response.

| Parameter | Default | Notes |
|---|---|---|
| `hours` | 24 | How far back the series goes. |
| `intervalMinutes` | 5 | Bucket size. `hours * 60 / intervalMinutes` must not exceed 2000. |

| Field | What to draw |
|---|---|
| `current` | Header: state chip, basis, funding, prices, age of the data. |
| `series` | The line: `basisBp` per bucket, with `basisMinBp`/`basisMaxBp` as a range. Buckets with no ticks are absent, so do not connect across long gaps. |
| `stateSegments` | Bands behind the chart, one per stretch of unchanged inferred state. `conflict: true` means behaviour contradicted the calendar. |
| `sessionSegments` | A second band: scheduled phases of the underlying market. Empty when `venue.id` is `null`. |
| `events` | Markers on the time axis. `detail` differs by `kind`. |
| `venue` | Time zone for local-time labels, and `nextScheduledChange`. `verified: false` means the hours are hand-compiled. |
| `window` | The x-axis domain: `from`, `to`, `intervalMinutes`. |
| `health` | If `collectorRunning` is false the numbers are old; say so on the page. |

Abridged example:

```json
{
  "coin": "xyz:SKHX",
  "category": "stocks",
  "current": {
    "coin": "xyz:SKHX", "state": "internal", "confidence": "both",
    "stateSince": "2026-11-26T11:04:00.000Z", "calendarPhase": "closed",
    "behavior": "internal", "calendarConflict": false,
    "oraclePx": 780.29, "markPx": 775.72, "midPx": 775.695,
    "basisBp": -58.57, "fundingHourly": -0.000577, "fundingAnnualizedPct": -505.48,
    "openInterestUsd": 390251948, "observed": "2026-11-26T11:37:58.000Z", "ageSeconds": 2
  },
  "venue": {
    "id": "krx", "timezone": "Asia/Seoul", "verified": false,
    "nextScheduledChange": { "ts": 1795734000000, "phase": "extended" }
  },
  "window": { "from": 1795685700000, "to": 1795693080000, "intervalMinutes": 5 },
  "series": [
    { "ts": 1795687500000, "basisBp": -128.69, "basisMinBp": -131.34, "basisMaxBp": -125.89,
      "oraclePx": 786.37, "markPx": 776.25, "fundingHourly": -0.0008003 }
  ],
  "stateSegments": [
    { "from": 1795687680000, "to": 1795690920000, "state": "external", "confidence": "calendar", "conflict": false },
    { "from": 1795690920000, "to": 1795691040000, "state": "transition", "confidence": "calendar", "conflict": false },
    { "from": 1795691040000, "to": 1795693080000, "state": "internal", "confidence": "both", "conflict": false }
  ],
  "sessionSegments": [
    { "from": 1795685700000, "to": 1795690800000, "phase": "extended" },
    { "from": 1795690800000, "to": 1795693080000, "phase": "closed" }
  ],
  "events": [
    { "ts": 1795691070000, "kind": "mode_switch",
      "detail": { "from": "external", "to": "internal", "confidence": "both", "basisBp": -117.29 } }
  ],
  "note": "state is inferred ...", "source": "Hyperliquid info API ...",
  "health": { "now": "2026-11-26T11:38:00.000Z", "collectorRunning": true, "detectorRunning": true,
              "collectorLastPoll": "2026-11-26T11:37:58.000Z", "detectorLastRun": "2026-11-26T11:37:55.000Z" }
}
```

Event `detail` by kind:

| `kind` | Fields |
|---|---|
| `mode_switch` | `from`, `to`, `confidence`, `basisBp` |
| `basis_breach` | `basisBp`, `z`, `mode`, `heldMs` |
| `oracle_jump` | `stepBp`, `from`, `to`, `mark` |
| `oracle_stale` | `seconds`, `markChanges` |
| `funding_extreme` | `funding1h`, `basisBp` |
| `oi_cap_near` | `usage` |
| `calendar_conflict` | `calendar`, `behavior`, `towardMark`, `updates` |

## Routes for a list page

### `GET /v1/overview`

All perps as `CoinSnapshot`, widest absolute basis first, plus `health`.

### `GET /v1/events?coin=&kind=&hours=24&limit=100`

Events across all perps, newest first. Times are ISO strings in `at`.

### `GET /v1/health`

Whether the collector and detector are running.

## Using it from Next.js

Inside this repository the app lives in `apps/web` and depends on the types package:

```json
{ "dependencies": { "@hip3-oracle-watch/api-types": "*" } }
```

The package ships TypeScript source, so tell Next.js to compile it:

```ts
// apps/web/next.config.ts
import type { NextConfig } from "next";

const config: NextConfig = { transpilePackages: ["@hip3-oracle-watch/api-types"] };
export default config;
```

Fetching in a Server Component avoids CORS altogether and keeps the API address
off the client. Data changes every few seconds, so do not cache it for long.

```ts
// lib/api.ts
import type { CoinDetail, CoinList } from "@hip3-oracle-watch/api-types";

const BASE = process.env.ORACLE_WATCH_API ?? "http://127.0.0.1:8787";

export async function getCoins(): Promise<CoinList> {
  const res = await fetch(`${BASE}/v1/coins`, { next: { revalidate: 300 } });
  if (!res.ok) throw new Error(`coins: HTTP ${res.status}`);
  return res.json();
}

export async function getCoin(coin: string, hours = 24, intervalMinutes = 5): Promise<CoinDetail | null> {
  const url = `${BASE}/v1/coin/${encodeURIComponent(coin)}?hours=${hours}&intervalMinutes=${intervalMinutes}`;
  const res = await fetch(url, { next: { revalidate: 10 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`coin ${coin}: HTTP ${res.status}`);
  return res.json();
}
```

For live updates in a Client Component, poll the same URL from the browser every
ten seconds; that is the detector's own cadence, so polling faster shows nothing
new. In that case the browser calls the API directly and CORS applies.

A colon is awkward in a route segment. Routing on the bare ticker
(`/coin/SKHX`) and passing it through works, because the API accepts bare tickers.
