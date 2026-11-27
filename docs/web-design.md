# Front-end design brief (`apps/web`)

Direction: colour and density after Vercel's dashboard, tables after Stripe's,
chart structure after Grafana's state timeline, charts drawn with TradingView
Lightweight Charts. This file fixes the decisions so the pages stay consistent;
it is a brief, not an implementation.

## Principles

1. **Near-monochrome.** Background, text and chart line are greys. Colour appears
   only where it carries state. If a screenshot loses its meaning in greyscale
   apart from the state chips and strips, the palette is right.
2. **Tables first.** The list page is a table. A chart appears only where a
   trend needs a shape: the detail page, and a small sparkline per row.
3. **Inference is labelled.** Oracle state is inferred. Wherever it is shown, the
   evidence (`confidence`) sits next to it, and weak evidence looks weaker.
4. **Stale data is visible.** If `health.collectorRunning` is false, a banner says
   so and numbers are dimmed. Never show old prices as if live.

## Tokens

Dark is the default; light must also work.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#000000` | `#ffffff` | page |
| `--panel` | `#0a0a0a` | `#fafafa` | cards, table header |
| `--line` | `#1f1f1f` | `#eaeaea` | borders, grid lines |
| `--ink` | `#ededed` | `#171717` | primary text, chart line |
| `--muted` | `#8f8f8f` | `#666666` | secondary text, axis labels |
| `--external` | `#3fb950` | `#1a7f37` | state: following an outside market |
| `--internal` | `#d29922` | `#9a6700` | state: internal pricing |
| `--transition` | `#8b7cf6` | `#6e56cf` | state: around a scheduled open or close |
| `--stale` | `#f85149` | `#cf222e` | state: feed expected but silent |
| `--unknown` | `#3a3a3a` | `#d0d0d0` | state: cannot tell; session: closed |

These are starting values. Check each state colour against its surface for
contrast and colour-vision separation before shipping, and never use them for
anything but state. Positive and negative basis are distinguished by sign and
position, not by red and green, which are already taken by state.

Type: system UI font, 13px body, 11px for axis and table headers, tabular
numerals everywhere numbers line up. Radius 8px on cards, 2px on strips.
Spacing on a 4px grid; table rows 36px.

## Pages

### `/` list

A single table, widest absolute basis first by default, sortable by column.

| Column | Source | Notes |
|---|---|---|
| Perp | `coin` | link to detail; strip the `xyz:` prefix visually, keep it in the URL |
| State | `state` | chip in the state colour |
| Evidence | `confidence`, `calendarConflict` | text, muted; "calendar only" is muted further |
| Basis | `basisBp` | right-aligned, signed, one decimal |
| 24h | sparkline | basis over 24h; optional at first, see below |
| Funding / h | `fundingHourly` | percent, four decimals |
| OI | `openInterestUsd` | compact (`$81.0M`) |
| Age | `ageSeconds` | muted; warn above 60s |

Above the table: filter chips by state with counts, a search box, and the health
banner when needed. Below it: the last 24 hours of events from `/v1/events`.

The sparkline needs a series per row. `/v1/overview` does not carry one; calling
`/v1/coin/{coin}` 150 times is wasteful. Ship the table without it first and ask
for a batch endpoint when the rest is done.

### `/coin/[ticker]` detail

Top to bottom:

1. **Header.** Ticker, state chip, evidence, time since `stateSince`. To the
   right: basis, funding per hour, oracle, mark, open interest.
2. **Range control.** 6h / 24h / 3d / 7d, mapped to `hours` and an
   `intervalMinutes` that keeps the series under about 600 points
   (1, 5, 10, 30).
3. **Basis chart.** One line, zero baseline, markers for events.
4. **Scheduled session strip.** From `sessionSegments`. Hidden with a one-line
   explanation when `venue.id` is null.
5. **Inferred state strip.** From `stateSegments`, directly under the session
   strip so a late or early switch is visible as an offset between the two.
6. **Events table.** Time, kind, the headline number for that kind.
7. **Footer note.** State is inferred; hours are hand-compiled when
   `venue.verified` is false.

Times are shown in UTC with the venue's local time beside them when
`venue.timezone` is set.

## Chart notes (Lightweight Charts 5.3, checked in a prototype)

Verified against real `/v1/coin/SKHX` output:

- `chart.addSeries(BaselineSeries, { baseValue: { type: "price", price: 0 } })`
  gives the basis line with a zero baseline. Set top and bottom line colours to
  the same grey to keep it monochrome.
- `createSeriesMarkers(series, markers)` places event markers. A marker's `time`
  must equal a time present in the series, so floor the event time to the bucket.
- Times are seconds, not milliseconds: divide the API's `ts` by 1000.
- **The time axis is index-based.** Missing buckets collapse unless they are
  filled with whitespace points (`{ time }` with no value). Fill every bucket
  between the first and last point so the axis is linear in time.
- **Whitespace does not break the line.** The line is still drawn straight across
  a run of empty buckets, which would present a collector outage as data. Split
  the series into one series per contiguous run, or otherwise make the gap
  visible; do not leave it joined.
- **Strips are plain elements, not canvas.** Position each segment with
  `chart.timeScale().timeToCoordinate(t)` after clamping `t` to the first and
  last bucket and flooring it to a bucket. Redraw on
  `subscribeVisibleLogicalRangeChange` so strips follow pan and zoom. In the
  prototype every segment resolved to a coordinate this way.
- The strips start at the chart's left edge but the chart reserves space for the
  price scale on the right; give the strip row the same right padding.
- The library is Apache-2.0 and asks for attribution. The built-in logo
  (`layout.attributionLogo`, on by default) satisfies it; if it is turned off,
  add a visible link to TradingView elsewhere.
- Lightweight Charts touches `window`, so the chart component must be a Client
  Component and should be created in an effect and removed on unmount.

## States that need a design

| Situation | What the page shows |
|---|---|
| Collector stopped | banner, dimmed numbers, last update time |
| Detector stopped | banner; state chips marked "as of" their time |
| Unknown ticker (404) | not-found page with a link back to the list |
| No venue mapped | session strip replaced by a short note |
| No events in range | "No events in this range", not an empty table |
| Fewer than two points | message instead of an empty chart |

## Out of scope for the first version

Wallet connection, orders, accounts, alerts configuration, and anything that
writes. The API is read-only and the first version should be too.
