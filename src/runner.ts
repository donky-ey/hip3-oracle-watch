// Drives the pure detector from the tick store. Replay and live follow share one
// path: ticks are streamed in time order and every coin is evaluated on a fixed
// grid of evaluation times.

import type { Store } from "./db.ts";
import { phaseAt, venueFor } from "./calendar.ts";
import {
  defaultConfig, evaluate, newMemory, observe, resetAfterGap,
  type CoinMemory, type DetectorConfig, type DetectorEvent, type OracleState, type SessionInput,
} from "./detector.ts";

export interface RunnerOptions {
  dex: string;
  evalMs: number;
  /** Margin around a scheduled open or close that counts as a transition. */
  boundaryMs: number;
  /** Ticks newer than this are left for the next pass, so a write in progress is never half-read. */
  settleMs: number;
  /** No tick from any coin for this long means the collector was down; nothing is evaluated across the hole. */
  gapMs: number;
  categories: Map<string, string>;
  config: DetectorConfig;
}

export const runnerDefaults: Omit<RunnerOptions, "categories"> = {
  dex: "xyz",
  evalMs: 30_000,
  boundaryMs: 10 * 60_000,
  settleMs: 2_000,
  gapMs: 120_000,
  config: defaultConfig,
};

interface Row {
  coin: string;
  ts: number;
  oracle: number;
  mark: number;
  funding: number;
  open_interest: number;
}

export class Runner {
  private readonly mem = new Map<string, CoinMemory>();
  private readonly lastKey = new Map<string, string>();
  private readonly venue = new Map<string, string | null>();
  private caps = new Map<string, number>();
  private cursor: number;
  private nextEval: number;
  private lastTickTs: number | null = null;
  readonly counts = { ticks: 0, evals: 0, stateRows: 0, events: 0 };
  readonly latest = new Map<string, OracleState>();

  constructor(private readonly store: Store, private readonly opts: RunnerOptions, from: number) {
    this.cursor = from;
    this.nextEval = Math.ceil(from / opts.evalMs) * opts.evalMs + opts.evalMs;
    this.loadCaps();
  }

  loadCaps(): void {
    const cfg = this.store.latestDexConfig(this.opts.dex);
    const raw = cfg?.assetToStreamingOiCap;
    if (Array.isArray(raw)) this.caps = new Map((raw as [string, string][]).map(([c, v]) => [c, Number(v)]));
  }

  private session(coin: string, ts: number): SessionInput {
    let v = this.venue.get(coin);
    if (v === undefined) {
      v = venueFor(coin, this.opts.categories.get(coin));
      this.venue.set(coin, v);
    }
    if (!v) return { phase: "unknown", nearBoundary: false };
    const b = this.opts.boundaryMs;
    return { phase: phaseAt(v, ts), nearBoundary: phaseAt(v, ts - b) !== phaseAt(v, ts + b) };
  }

  private evalAll(now: number, sink: { states: OracleState[]; events: DetectorEvent[] }): void {
    for (const [coin, mem] of this.mem) {
      const { state, events } = evaluate(
        mem, { coin, now, session: this.session(coin, now), oiCapUsd: this.caps.get(coin) }, this.opts.config,
      );
      this.counts.evals++;
      this.latest.set(coin, state);
      const key = `${state.state}|${state.confidence}|${state.conflict}`;
      if (this.lastKey.get(coin) !== key) {
        this.lastKey.set(coin, key);
        sink.states.push(state);
      }
      sink.events.push(...events);
    }
  }

  /** Process every settled tick up to `now`. Returns the events found in this pass. */
  advance(now: number): DetectorEvent[] {
    const until = now - this.opts.settleMs;
    const sink = { states: [] as OracleState[], events: [] as DetectorEvent[] };
    const stmt = this.store.db.prepare(
      "SELECT coin, ts, oracle, mark, funding, open_interest FROM ticks WHERE ts > ? AND ts <= ? ORDER BY ts",
    );
    for (const r of stmt.iterate(this.cursor, until) as Iterable<Row>) {
      if (this.lastTickTs != null && r.ts - this.lastTickTs > this.opts.gapMs) {
        for (const m of this.mem.values()) resetAfterGap(m);
        this.nextEval = Math.ceil(r.ts / this.opts.evalMs) * this.opts.evalMs + this.opts.evalMs;
      }
      this.lastTickTs = r.ts;
      while (r.ts > this.nextEval) {
        this.evalAll(this.nextEval, sink);
        this.nextEval += this.opts.evalMs;
      }
      let mem = this.mem.get(r.coin);
      if (!mem) this.mem.set(r.coin, (mem = newMemory()));
      observe(mem, r.coin, { ts: r.ts, oracle: r.oracle, mark: r.mark, funding: r.funding, openInterest: r.open_interest }, this.opts.config);
      this.counts.ticks++;
    }
    // Never evaluate past the data: with no fresh ticks there is nothing to judge.
    const dataEnd = Math.min(until, (this.lastTickTs ?? 0) + this.opts.evalMs);
    while (this.nextEval <= dataEnd) {
      this.evalAll(this.nextEval, sink);
      this.nextEval += this.opts.evalMs;
    }
    this.cursor = Math.max(this.cursor, until);
    this.persist(sink);
    return sink.events;
  }

  private persist(sink: { states: OracleState[]; events: DetectorEvent[] }): void {
    if (sink.states.length === 0 && sink.events.length === 0) return;
    const db = this.store.db;
    // OR IGNORE keeps a re-run over the same history from duplicating rows.
    const insS = db.prepare(
      "INSERT OR IGNORE INTO states (coin, ts, state, confidence, calendar, behavior, conflict, metrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insE = db.prepare("INSERT OR IGNORE INTO events (coin, ts, kind, detail) VALUES (?, ?, ?, ?)");
    db.exec("BEGIN");
    try {
      for (const s of sink.states) {
        this.counts.stateRows += Number(
          insS.run(s.coin, s.ts, s.state, s.confidence, s.calendar, s.behavior, s.conflict ? 1 : 0, JSON.stringify(s.metrics)).changes,
        );
      }
      for (const e of sink.events) {
        this.counts.events += Number(insE.run(e.coin, e.ts, e.kind, JSON.stringify(e.detail)).changes);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
