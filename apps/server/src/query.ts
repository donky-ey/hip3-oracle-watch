// Read-only views over the store, shared by the MCP server and the HTTP API.
// Every answer says when it was observed and where it came from, and marks
// inferred fields as such.

import type { Store } from "./db.ts";
import { nextChange, phaseAt, venueFor, venues, type Phase } from "./calendar.ts";
import type { CoinDetail, CoinList, CoinSnapshot, Health, Overview, SeriesPoint, SessionSegment, StateSegment } from "@hip3-oracle-watch/api-types";

const SOURCE = "Hyperliquid info API (metaAndAssetCtxs, activeAssetCtx), collected by hip3-oracle-watch";
const STATE_NOTE =
  "state is inferred from the session calendar and from how the oracle has been moving; the deployer does not publish it";
const MIN = 60_000;

interface TickRow {
  coin: string;
  ts: number;
  oracle: number;
  mark: number;
  mid: number | null;
  funding: number;
  open_interest: number;
}
interface StateRow {
  coin: string;
  ts: number;
  state: string;
  confidence: string;
  calendar: string;
  behavior: string;
  conflict: number;
}

const bp = (mark: number, oracle: number) => Math.round((mark / oracle - 1) * 1e6) / 100;
const iso = (ts: number) => new Date(ts).toISOString();

export class NotFound extends Error {}

export class Queries {
  private cache: { at: number; rows: Map<string, TickRow> } | null = null;

  constructor(
    private readonly store: Store,
    private readonly categories: Map<string, string>,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Latest tick per coin. Looks back six hours because a quiet coin writes no rows. */
  private latestTicks(): Map<string, TickRow> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < 2_000) return this.cache.rows;
    const rows = this.store.db
      .prepare(
        `SELECT coin, max(ts) AS ts, oracle, mark, mid, funding, open_interest
         FROM ticks WHERE ts > ? GROUP BY coin`,
      )
      .all(now - 6 * 3_600_000) as unknown as TickRow[];
    this.cache = { at: now, rows: new Map(rows.map((r) => [r.coin, { ...r }])) };
    return this.cache.rows;
  }

  private latestStates(): Map<string, StateRow> {
    const rows = this.store.db
      .prepare(
        `SELECT s.coin, s.ts, s.state, s.confidence, s.calendar, s.behavior, s.conflict FROM states s
         JOIN (SELECT coin, max(ts) AS ts FROM states GROUP BY coin) m ON m.coin = s.coin AND m.ts = s.ts`,
      )
      .all() as unknown as StateRow[];
    return new Map(rows.map((r) => [r.coin, { ...r }]));
  }

  health(): Health {
    const now = this.clock();
    const lastPoll = (this.store.db.prepare("SELECT max(ts) AS t FROM polls").get() as { t: number | null }).t;
    const lastRun = Number(this.store.getKv("detector_last_run") ?? 0) || null;
    return {
      now: iso(now),
      collectorLastPoll: lastPoll ? iso(lastPoll) : null,
      collectorRunning: lastPoll != null && now - lastPoll < 60_000,
      detectorLastRun: lastRun ? iso(lastRun) : null,
      detectorRunning: lastRun != null && now - lastRun < 120_000,
    };
  }

  private resolve(coin: string): string {
    const ticks = this.latestTicks();
    if (ticks.has(coin)) return coin;
    const hit = [...ticks.keys()].find((c) => c.toLowerCase() === coin.toLowerCase() || c.split(":")[1]?.toLowerCase() === coin.toLowerCase());
    if (!hit) throw new NotFound(`no recent data for "${coin}"; use a name such as xyz:NVDA`);
    return hit;
  }

  private view(t: TickRow, s: StateRow | undefined): CoinSnapshot {
    const now = this.clock();
    return {
      coin: t.coin,
      state: s?.state ?? "unknown",
      confidence: s?.confidence ?? "none",
      stateSince: s ? iso(s.ts) : null,
      calendarPhase: s?.calendar ?? "unknown",
      behavior: s?.behavior ?? "inconclusive",
      calendarConflict: Boolean(s?.conflict),
      oraclePx: t.oracle,
      markPx: t.mark,
      midPx: t.mid,
      basisBp: bp(t.mark, t.oracle),
      fundingHourly: t.funding,
      fundingAnnualizedPct: Math.round(t.funding * 24 * 365 * 10_000) / 100,
      openInterestUsd: Math.round(t.open_interest * t.mark),
      observed: iso(t.ts),
      ageSeconds: Math.round((now - t.ts) / 1000),
    };
  }

  oracleState(coinArg: string) {
    const coin = this.resolve(coinArg);
    const v = this.view(this.latestTicks().get(coin)!, this.latestStates().get(coin));
    const venue = venueFor(coin, this.categories.get(coin));
    const next = venue ? nextChange(venue, this.clock()) : null;
    return {
      ...v,
      venue,
      nextScheduledChange: next ? { at: iso(next.ts), phase: next.phase } : null,
      calendarVerified: venue ? venues[venue]!.verified : false,
      units: { basisBp: "basis points, (mark / oracle - 1) * 10000", fundingHourly: "fraction per hour" },
      note: STATE_NOTE,
      source: SOURCE,
      health: this.health(),
    };
  }

  overview(): Overview {
    const states = this.latestStates();
    const rows = [...this.latestTicks().values()].map((t) => this.view(t, states.get(t.coin)));
    rows.sort((a, b) => Math.abs(b.basisBp) - Math.abs(a.basisBp));
    return { coins: rows, note: STATE_NOTE, source: SOURCE, health: this.health() };
  }

  dislocations(minBp = 20, state?: string, limit = 25) {
    const all = this.overview();
    const coins = all.coins.filter((c) => Math.abs(c.basisBp) >= minBp && (!state || c.state === state)).slice(0, limit);
    return { minBp, state: state ?? null, count: coins.length, coins, note: STATE_NOTE, source: SOURCE, health: all.health };
  }

  events(opts: { coin?: string; kind?: string; hours?: number; limit?: number }) {
    const now = this.clock();
    const coin = opts.coin ? this.resolve(opts.coin) : null;
    const kind = opts.kind ?? null;
    const rows = this.store.db
      .prepare(
        `SELECT coin, ts, kind, detail FROM events
         WHERE ts >= ? AND (? IS NULL OR coin = ?) AND (? IS NULL OR kind = ?)
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(now - (opts.hours ?? 24) * 3_600_000, coin, coin, kind, kind, Math.min(opts.limit ?? 100, 500)) as
      { coin: string; ts: number; kind: string; detail: string }[];
    return {
      count: rows.length,
      events: rows.map((r) => ({ at: iso(r.ts), coin: r.coin, kind: r.kind, detail: JSON.parse(r.detail) as unknown })),
      source: "hip3-oracle-watch detector",
      health: this.health(),
    };
  }

  /** Basis and funding series. Recent buckets come from raw ticks, older ones from one-minute bars. */
  basisHistory(coinArg: string, hours = 6, intervalMinutes = 5) {
    const coin = this.resolve(coinArg);
    const now = this.clock();
    const step = Math.max(1, Math.round(intervalMinutes)) * MIN;
    const from = Math.floor((now - hours * 3_600_000) / step) * step;
    if ((now - from) / step > 2_000) throw new RangeError("too many points; raise intervalMinutes or lower hours");
    const fromTicks = this.store.db
      .prepare(
        // step is inlined: a bound number arrives as a float and would turn this into float division.
        `SELECT ts / ${step} * ${step} AS b, min((mark / oracle - 1) * 10000) AS lo, max((mark / oracle - 1) * 10000) AS hi,
                max(ts) AS last_ts, oracle, mark, funding
         FROM ticks WHERE coin = ? AND ts >= ? AND oracle > 0 GROUP BY b`,
      )
      .all(coin, from) as { b: number; lo: number; hi: number; oracle: number; mark: number; funding: number }[];
    const fromBars = this.store.db
      .prepare(
        `SELECT ts / ${step} * ${step} AS b, min(basis_min_bp) AS lo, max(basis_max_bp) AS hi,
                max(ts) AS last_ts, oracle_close AS oracle, mark_close AS mark, funding_close AS funding
         FROM bars_1m WHERE coin = ? AND ts >= ? GROUP BY b`,
      )
      .all(coin, from) as { b: number; lo: number; hi: number; oracle: number; mark: number; funding: number }[];
    const merged = new Map<number, (typeof fromTicks)[number]>();
    for (const r of fromBars) merged.set(r.b, r);
    for (const r of fromTicks) {
      const o = merged.get(r.b);
      // A bucket can straddle the compaction cutoff; ticks are later, so they supply the close.
      merged.set(r.b, o ? { ...r, lo: Math.min(o.lo, r.lo), hi: Math.max(o.hi, r.hi) } : r);
    }
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const points = [...merged.values()].sort((a, b) => a.b - b.b).map((r) => ({
      t: iso(r.b), basisBp: bp(r.mark, r.oracle), basisMinBp: r2(r.lo), basisMaxBp: r2(r.hi),
      oraclePx: r.oracle, markPx: r.mark, fundingHourly: r.funding,
    }));
    return {
      coin, intervalMinutes: step / MIN, from: iso(from), count: points.length, points,
      units: { basisBp: "basis points at bucket close", fundingHourly: "fraction per hour at bucket close" },
      source: SOURCE,
    };
  }

  /** Every perp with recent data, for building routes or a picker. */
  coinList(): CoinList {
    const coins = [...this.latestTicks().keys()].sort().map((coin) => ({
      coin,
      category: this.categories.get(coin) ?? null,
      venue: venueFor(coin, this.categories.get(coin)),
    }));
    return { coins };
  }

  /**
   * Everything a detail page needs for one perp in a single response: the current
   * snapshot, the basis series, the state and session bands to draw behind it,
   * and the events to mark on it. Times are epoch milliseconds.
   */
  coinDetail(coinArg: string, hours = 24, intervalMinutes = 5): CoinDetail {
    const coin = this.resolve(coinArg);
    const now = this.clock();
    const hist = this.basisHistory(coin, hours, intervalMinutes);
    const from = Date.parse(hist.from);
    const series: SeriesPoint[] = hist.points.map((p) => ({
      ts: Date.parse(p.t), basisBp: p.basisBp, basisMinBp: p.basisMinBp, basisMaxBp: p.basisMaxBp,
      oraclePx: p.oraclePx, markPx: p.markPx, fundingHourly: p.fundingHourly,
    }));

    // The state in force at `from` is the last change before it.
    const rows = this.store.db
      .prepare(
        `SELECT ts, state, confidence, conflict FROM (
           SELECT ts, state, confidence, conflict FROM states WHERE coin = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
         ) UNION ALL
         SELECT ts, state, confidence, conflict FROM states WHERE coin = ? AND ts > ? AND ts <= ? ORDER BY ts`,
      )
      .all(coin, from, coin, from, now) as { ts: number; state: string; confidence: string; conflict: number }[];
    const stateSegments: StateSegment[] = [];
    for (const r of rows) {
      const start = Math.max(r.ts, from);
      const last = stateSegments.at(-1);
      if (last) last.to = start;
      // Consecutive rows can differ only in the conflict flag; keep those as separate bands.
      stateSegments.push({ from: start, to: now, state: r.state, confidence: r.confidence, conflict: Boolean(r.conflict) });
    }

    const venue = venueFor(coin, this.categories.get(coin));
    const sessionSegments: SessionSegment[] = [];
    if (venue) {
      let t = from;
      while (t < now) {
        const n = nextChange(venue, t);
        const end = n ? Math.min(n.ts, now) : now;
        sessionSegments.push({ from: t, to: end, phase: phaseAt(venue, t) });
        if (!n) break;
        t = n.ts;
      }
    }
    const next = venue ? nextChange(venue, now) : null;

    const events = (this.store.db
      .prepare("SELECT ts, kind, detail FROM events WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts")
      .all(coin, from, now) as { ts: number; kind: string; detail: string }[])
      .map((e) => ({ ts: e.ts, kind: e.kind, detail: JSON.parse(e.detail) as Record<string, number | string | null> }));

    return {
      coin,
      category: this.categories.get(coin) ?? null,
      current: this.view(this.latestTicks().get(coin)!, this.latestStates().get(coin)),
      venue: {
        id: venue,
        timezone: venue ? venues[venue]!.tz : null,
        verified: venue ? venues[venue]!.verified : false,
        nextScheduledChange: next,
      },
      window: { from, to: now, intervalMinutes: hist.intervalMinutes },
      series,
      stateSegments,
      sessionSegments,
      events,
      note: STATE_NOTE,
      source: SOURCE,
      health: this.health(),
    };
  }

  sessionCalendar(coinArg: string) {
    // The calendar is static, so this works for any ticker, with or without data.
    const coin = coinArg.includes(":") ? coinArg : `xyz:${coinArg.toUpperCase()}`;
    const venue = venueFor(coin, this.categories.get(coin));
    if (!venue) {
      return { coin, venue: null, phase: "unknown" as const, upcoming: [], verified: false, note: "the reference market for this ticker has not been identified" };
    }
    const v = venues[venue]!;
    const now = this.clock();
    const upcoming: { at: string; phase: Phase }[] = [];
    let t = now;
    for (let i = 0; i < 4; i++) {
      const n = nextChange(venue, t);
      if (!n) break;
      upcoming.push({ at: iso(n.ts), phase: n.phase });
      t = n.ts;
    }
    return {
      coin, venue, timezone: v.tz, phase: phaseAt(venue, now), upcoming,
      regularHoursLocal: v.regular, extendedHoursLocal: v.extended,
      continuous: v.continuous ?? null, verified: v.verified,
      note: v.verified ? null : "hours and holidays are hand-compiled and not yet checked against the exchange",
    };
  }
}
