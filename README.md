# hip3-oracle-watch

Watches oracle state and mark/oracle dislocations on Hyperliquid HIP-3 equity and
commodity perps. Read-only: it places no orders and holds no keys.

Status: week 2 of 4. The collector, storage, session calendar and state detector
exist. The MCP server, HTTP endpoints and alerts do not yet.

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
npm run detect -- --db oracle-watch.db --hours 6 --follow
```

```bash
npm run events -- --db oracle-watch.db --hours 24 --kind mode_switch
```

```bash
npm run states -- --db oracle-watch.db
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

## Oracle state

The API does not say whether the deployer's oracle is following an external market
or its own internal pricing, so `detect` infers it from two kinds of evidence.

- Calendar: whether the underlying market is open, from `data/venues.json`.
- Behavior: over the last five minutes, the share of oracle updates that moved
  toward the mark price. Internal pricing creeps toward mark; an external feed
  moves both ways.

| State | Meaning |
|---|---|
| `external` | oracle is following an outside market |
| `internal` | oracle is on the deployer's internal pricing |
| `transition` | within ten minutes of a scheduled open or close, behavior not yet clear |
| `stale` | no oracle update for 15 minutes while mark kept moving |
| `unknown` | no venue mapping and too few updates to judge |

Every state carries a confidence: `both` when calendar and behavior agree,
`behavior` when only behavior speaks or it overrules the calendar, `calendar` when
there were too few updates to judge. When the two disagree, behavior wins and the
row is flagged as a conflict, which usually means the calendar is wrong.

| Event | Fires when |
|---|---|
| `mode_switch` | the mode changes and holds for two evaluations |
| `basis_breach` | basis is at least 50 bp and 3 sigma from its baseline for a minute |
| `oracle_jump` | one oracle update moves at least 100 bp |
| `oracle_stale` | the stale state begins |
| `funding_extreme` | hourly funding reaches 0.05% in either direction |
| `oi_cap_near` | open interest reaches 90% of the deployer's cap |
| `calendar_conflict` | calendar and behavior disagree for two evaluations |

`detect` replays stored ticks through the same code that runs live, so it can be
rerun over history; rows are keyed so a rerun does not duplicate them. It never
evaluates past the last tick or across a collector outage.

The behavior thresholds were set from a short sample on one US market holiday.
Treat the output as an inference to be checked, not as a statement by the deployer.

## Data

SQLite, one file.

| Table | Contents |
|---|---|
| `ticks` | coin, time, oracle, mark, mid, impact prices, funding, open interest, source |
| `bars_1m` | one-minute bars built from ticks older than the retention window |
| `states` | detector output, one row per change of state, confidence or conflict |
| `events` | detector events |
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
