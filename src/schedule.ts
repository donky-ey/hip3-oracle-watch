// Derives, from stored history, when each perp's oracle actually behaves like an
// external feed and when it switches. This is an empirical timetable: it reports
// what was observed, with how many days back it up, and never fills gaps from the
// calendar.

import type { Store } from "./db.ts";
import { phaseAt, toLocal, venueFor, venues } from "./calendar.ts";

export const BUCKET_MS = 5 * 60_000;
const SLOT_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

export type Regime = "external" | "internal";

export interface Bucket {
  coin: string;
  ts: number;
  updates: number;
  judged: number;
  toward: number;
}

/**
 * Regime of one five-minute bucket, or null when it cannot be told.
 * A short run of updates that all chase mark also counts as internal: once
 * internal pricing has caught up with mark it barely updates at all.
 */
export function bucketRegime(b: Pick<Bucket, "updates" | "judged" | "toward">): Regime | null {
  if (b.judged === 0 || b.judged * 2 < b.updates) return null;
  const share = b.toward / b.judged;
  if (b.judged >= 6 && share >= 0.9) return "internal";
  if (b.judged >= 3 && share === 1) return "internal";
  if (b.judged >= 6 && share <= 0.7) return "external";
  return null;
}

export function loadBuckets(store: Store, from: number, to: number): Bucket[] {
  const fromTicks = store.db
    .prepare(
      `WITH t AS (
         SELECT coin, ts, oracle,
                LAG(oracle) OVER (PARTITION BY coin ORDER BY ts) AS po,
                LAG(mark) OVER (PARTITION BY coin ORDER BY ts) AS pm
         FROM ticks WHERE ts >= ? AND ts < ?
       )
       SELECT coin, ts / ${BUCKET_MS} * ${BUCKET_MS} AS ts,
              sum(oracle <> po) AS updates,
              sum(oracle <> po AND pm <> po) AS judged,
              sum(oracle <> po AND (oracle - po) * (pm - po) > 0) AS toward
       FROM t WHERE po IS NOT NULL GROUP BY coin, 2`,
    )
    .all(from, to) as unknown as Bucket[];
  const fromBars = store.db
    .prepare(
      `SELECT coin, ts / ${BUCKET_MS} * ${BUCKET_MS} AS ts, sum(oracle_updates) AS updates,
              sum(judged_updates) AS judged, sum(toward_updates) AS toward
       FROM bars_1m WHERE ts >= ? AND ts < ? GROUP BY coin, 2`,
    )
    .all(from, to) as unknown as Bucket[];
  // A bucket can straddle the compaction cutoff, in which case both sources hold part of it.
  const merged = new Map<string, Bucket>();
  for (const b of [...fromBars, ...fromTicks]) {
    const k = `${b.coin}|${b.ts}`;
    const o = merged.get(k);
    merged.set(k, o ? { ...o, updates: o.updates + b.updates, judged: o.judged + b.judged, toward: o.toward + b.toward } : { ...b });
  }
  return [...merged.values()].sort((a, b) => a.coin.localeCompare(b.coin) || a.ts - b.ts);
}

export interface Switch {
  coin: string;
  ts: number;
  from: Regime;
  to: Regime;
}

/**
 * Switches within one coin's buckets. A switch needs `confirm` consecutive
 * conclusive buckets of the new regime, and the old regime must itself have
 * been established the same way. Buckets more than `maxGapMs` apart are not
 * joined, so a collector outage never produces a switch.
 */
export function findSwitches(buckets: Bucket[], confirm = 2, maxGapMs = 30 * 60_000): Switch[] {
  const out: Switch[] = [];
  let current: Regime | null = null;
  let run = null as { regime: Regime; start: number; n: number } | null;
  let lastTs: number | null = null;
  for (const b of buckets) {
    if (lastTs != null && b.ts - lastTs > maxGapMs) {
      current = null;
      run = null;
    }
    lastTs = b.ts;
    const r = bucketRegime(b);
    if (r == null) continue;
    if (run && run.regime === r) run.n++;
    else run = { regime: r, start: b.ts, n: 1 };
    if (run.n < confirm || run.regime === current) continue;
    if (current != null) out.push({ coin: b.coin, ts: run.start, from: current, to: run.regime });
    current = run.regime;
  }
  return out;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const utcMinutes = (ts: number) => Math.floor((ts % DAY_MS) / 60_000);
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const isWeekend = (ts: number) => [0, 6].includes(new Date(ts).getUTCDay());

export interface SwitchRow {
  coin: string;
  direction: string;
  utc: string;
  local: string | null;
  timezone: string | null;
  daysObserved: number;
  daysCovered: number;
  dates: string[];
  /** What the hand-compiled calendar expects at that moment, for comparison. */
  calendar: string;
}

export interface RegimeRow {
  coin: string;
  venue: string | null;
  external: string;
  internal: string;
  conclusiveBuckets: number;
  daysCovered: number;
}

export interface Schedule {
  from: string;
  to: string;
  coveredHours: number;
  daysCovered: number;
  switches: SwitchRow[];
  regimes: RegimeRow[];
  note: string;
}

/** Merges half-hour slots (minutes since UTC midnight) into "HH:MM-HH:MM" ranges. */
export function ranges(slots: number[]): string {
  const s = [...new Set(slots)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1]! - s[j]! === 30) j++;
    out.push(`${hhmm(s[i]!)}-${hhmm((s[j]! + 30) % 1440)}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function buildSchedule(store: Store, categories: Map<string, string>, from: number, to: number): Schedule {
  const buckets = loadBuckets(store, from, to);
  const byCoin = new Map<string, Bucket[]>();
  for (const b of buckets) (byCoin.get(b.coin) ?? byCoin.set(b.coin, []).get(b.coin)!).push(b);
  const polls = store.db.prepare("SELECT ts FROM polls WHERE ts >= ? AND ts < ? ORDER BY ts").all(from, to) as { ts: number }[];
  let coveredMs = 0;
  for (let i = 1; i < polls.length; i++) {
    const d = polls[i]!.ts - polls[i - 1]!.ts;
    if (d <= 60_000) coveredMs += d;
  }
  const allDays = new Set(buckets.map((b) => utcDay(b.ts)));

  const switches: SwitchRow[] = [];
  const regimes: RegimeRow[] = [];
  for (const [coin, bs] of byCoin) {
    const venue = venueFor(coin, categories.get(coin));
    const tz = venue ? venues[venue]!.tz : null;
    const days = new Set(bs.map((b) => utcDay(b.ts)));

    // The same switch on different days lands in the same five-minute slot.
    const groups = new Map<string, Switch[]>();
    for (const s of findSwitches(bs)) {
      const k = `${s.from}>${s.to}|${utcMinutes(s.ts)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
    }
    for (const g of groups.values()) {
      const s = g[0]!;
      switches.push({
        coin,
        direction: `${s.from} → ${s.to}`,
        utc: hhmm(utcMinutes(s.ts)),
        local: tz ? hhmm(toLocal(s.ts, tz).minutes) : null,
        timezone: tz,
        daysObserved: new Set(g.map((x) => utcDay(x.ts))).size,
        daysCovered: days.size,
        dates: [...new Set(g.map((x) => utcDay(x.ts)))],
        calendar: venue ? `${phaseAt(venue, s.ts - BUCKET_MS)} → ${phaseAt(venue, s.ts + BUCKET_MS)}` : "no venue mapped",
      });
    }

    // Weekday picture by half-hour slot: the regime seen in most conclusive buckets.
    const slots = new Map<number, { external: number; internal: number }>();
    let conclusive = 0;
    for (const b of bs) {
      const r = bucketRegime(b);
      if (r == null || isWeekend(b.ts)) continue;
      conclusive++;
      const slot = Math.floor((b.ts % DAY_MS) / SLOT_MS) * 30;
      const c = slots.get(slot) ?? slots.set(slot, { external: 0, internal: 0 }).get(slot)!;
      c[r]++;
    }
    const ext: number[] = [];
    const int: number[] = [];
    for (const [slot, c] of slots) (c.external >= c.internal ? ext : int).push(slot);
    regimes.push({ coin, venue, external: ranges(ext), internal: ranges(int), conclusiveBuckets: conclusive, daysCovered: days.size });
  }
  switches.sort((a, b) => b.daysObserved - a.daysObserved || a.utc.localeCompare(b.utc) || a.coin.localeCompare(b.coin));
  regimes.sort((a, b) => a.coin.localeCompare(b.coin));
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    coveredHours: Math.round((coveredMs / 3_600_000) * 10) / 10,
    daysCovered: allDays.size,
    switches,
    regimes,
    note:
      "Observed oracle behaviour only. A switch seen on one day is an observation, not a schedule. Slots with no conclusive data are left out rather than assumed. Weekends are excluded from the regime ranges.",
  };
}

export function toMarkdown(s: Schedule): string {
  const L: string[] = [];
  L.push("# Observed oracle timetable", "");
  L.push(`Window ${s.from.slice(0, 16)}Z to ${s.to.slice(0, 16)}Z. ${s.coveredHours} hour(s) of data across ${s.daysCovered} UTC day(s).`, "");
  L.push(s.note, "");
  L.push("## Switches", "");
  if (s.switches.length === 0) L.push("None observed in this window.", "");
  else {
    L.push("| Perp | Direction | UTC | Local | Seen on | Dates | Calendar expected |", "|---|---|---|---|---|---|---|");
    for (const r of s.switches) {
      L.push(`| ${r.coin} | ${r.direction} | ${r.utc} | ${r.local ? `${r.local} ${r.timezone}` : "n/a"} | ${r.daysObserved} of ${r.daysCovered} day(s) | ${r.dates.join(", ")} | ${r.calendar} |`);
    }
    L.push("");
  }
  L.push("## Regime by time of day (UTC, weekdays, half-hour slots)", "");
  L.push("| Perp | Venue mapped | Behaves external | Behaves internal | Conclusive buckets |", "|---|---|---|---|---|");
  for (const r of s.regimes) {
    if (r.conclusiveBuckets === 0) continue;
    L.push(`| ${r.coin} | ${r.venue ?? "none"} | ${r.external || "not seen"} | ${r.internal || "not seen"} | ${r.conclusiveBuckets} |`);
  }
  const silent = s.regimes.filter((r) => r.conclusiveBuckets === 0).length;
  if (silent) L.push("", `${silent} perp(s) had too few oracle updates to classify in this window and are not listed.`);
  return L.join("\n") + "\n";
}
