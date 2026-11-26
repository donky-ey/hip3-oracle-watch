# hip3-oracle-watch

Watches oracle state and mark/oracle dislocations on Hyperliquid HIP-3 equity and
commodity perps. Read-only: it places no orders and holds no keys.

Status: week 1 of 4. The collector, storage and session calendar exist. The state
detector, events, MCP server and alerts do not yet.

## Run

Requires Node 22.13 or newer.

```bash
npm install
```

```bash
npm run collect -- --db oracle-watch.db
```

```bash
npm run status -- --db oracle-watch.db --hours 24
```

```bash
npm run compact -- --db oracle-watch.db --retention-days 7 --vacuum
```

```bash
npm run session -- xyz:NVDA
```

`collect` polls `metaAndAssetCtxs` for the whole dex every 5 seconds and follows the
40 most traded coins over WebSocket (`activeAssetCtx`). A row is written only when
oracle, mark, mid, funding or open interest changes. `status` reports coverage and
any stretch longer than three poll intervals without a successful poll.

Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1` so `fetch` honours `HTTPS_PROXY`.
The WebSocket picks the proxy up on its own.

## Data

SQLite, one file.

| Table | Contents |
|---|---|
| `ticks` | coin, time, oracle, mark, mid, impact prices, funding, open interest, source |
| `bars_1m` | one-minute bars built from ticks older than the retention window |
| `polls` | one row per successful full poll; coverage is measured here |
| `dex_config` | `perpDexs` entry for the dex, stored when it changes |
| `ws_events` | socket opens and closes |

## Retention

Raw ticks are kept for 7 days (`--retention-days`). Older ticks are folded into
`bars_1m` and deleted. The collector does this at start-up and then hourly;
`compact` does it on demand. Each bar keeps oracle and mark open/high/low/close,
the minimum and maximum basis in basis points, the largest single oracle step, and
closing funding and open interest. Poll records are kept for 90 days.

Measured on a 6.6 million tick backlog: 56 seconds, 690 MB down to 61 MB after
`--vacuum`. Deleting rows does not shrink the file by itself; SQLite reuses the
freed pages, so the file stops growing once it reaches its steady size. Pass
`--vacuum` to hand the space back, and stop the collector first because it
rewrites the whole file.

Rough sizing at 150 coins: about 370 MB per day of raw ticks and up to 33 MB per
day of bars.

## Calendar caveat

`data/venues.json` and `data/symbols.json` are hand-compiled first drafts. Every
venue is marked `verified: false`, non-US holiday lists cover 2026 only, and tickers
whose reference market is not known map to `unknown`. Do not rely on a session
phase until the venue has been checked against the exchange's own calendar.

## Test

```bash
npm test
```

Not investment advice. Oracle state reported by later versions of this tool is an
inference from public data, not a statement from the deployer.
