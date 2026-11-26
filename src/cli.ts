#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Collector, defaults } from "./collector.ts";
import { Store } from "./db.ts";
import { perpCategories } from "./hl.ts";
import { sessionFor } from "./calendar.ts";
import { Runner, runnerDefaults } from "./runner.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string", default: defaults.dbPath },
    dex: { type: "string", default: defaults.dex },
    "poll-ms": { type: "string", default: String(defaults.pollMs) },
    "ws-top": { type: "string", default: String(defaults.wsTopN) },
    hours: { type: "string", default: "24" },
    "retention-days": { type: "string", default: String(defaults.retentionDays) },
    vacuum: { type: "boolean", default: false },
    follow: { type: "boolean", default: false },
    kind: { type: "string" },
    coin: { type: "string" },
  },
});
const cmd = positionals[0];
const iso = (ts: number) => new Date(ts).toISOString();

if (cmd === "collect") {
  const c = new Collector({
    ...defaults,
    dex: values.dex!,
    dbPath: values.db!,
    pollMs: Number(values["poll-ms"]),
    wsTopN: Number(values["ws-top"]),
    retentionDays: Number(values["retention-days"]),
  });
  const stop = () => {
    c.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await c.start();
} else if (cmd === "status") {
  const store = new Store(values.db!);
  const to = Date.now();
  const from = to - Number(values.hours) * 3_600_000;
  // A poll is "missed" once three intervals pass without one.
  const cov = store.coverage(values.dex!, from, to, Number(values["poll-ms"]) * 3);
  const span = (cov.to - cov.from) / 1000;
  console.log(`window     ${iso(cov.from)} .. ${iso(cov.to)}`);
  console.log(`polls      ${cov.polls}`);
  console.log(`ticks      ${cov.ticks} across ${cov.coins} coins`);
  console.log(`gaps       ${cov.gaps.length} totalling ${cov.gapSeconds}s` + (span > 0 ? ` (${((cov.gapSeconds / span) * 100).toFixed(2)}% of window)` : ""));
  for (const g of cov.gaps.slice(0, 20)) console.log(`  ${iso(g.from)} .. ${iso(g.to)}  ${g.seconds}s`);
  store.close();
} else if (cmd === "compact") {
  const store = new Store(values.db!);
  const day = 86_400_000;
  const r = store.compact(Date.now(), Number(values["retention-days"]) * day, defaults.pollRetentionDays * day);
  console.log(`cutoff     ${iso(r.cutoff)}`);
  console.log(`ticks      ${r.ticksRemoved} removed`);
  console.log(`bars       ${r.barsWritten} written`);
  console.log(`polls      ${r.pollsRemoved} removed`);
  if (values.vacuum) {
    store.vacuum();
    console.log("vacuumed");
  }
  store.close();
} else if (cmd === "detect") {
  // Replays the last --hours of ticks, then with --follow keeps evaluating new ones.
  const store = new Store(values.db!);
  const runner = new Runner(
    store,
    { ...runnerDefaults, dex: values.dex!, categories: await perpCategories() },
    Date.now() - Number(values.hours) * 3_600_000,
  );
  const print = (evs: { coin: string; ts: number; kind: string; detail: unknown }[]) => {
    for (const e of evs) console.log(`${iso(e.ts)} ${e.kind.padEnd(17)} ${e.coin.padEnd(14)} ${JSON.stringify(e.detail)}`);
  };
  print(runner.advance(Date.now()));
  const tally = new Map<string, number>();
  for (const s of runner.latest.values()) {
    const k = `${s.state}/${s.confidence}${s.conflict ? "/conflict" : ""}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const c = runner.counts;
  console.log(`replayed ${c.ticks} ticks, ${c.evals} evaluations, ${c.stateRows} state rows, ${c.events} events`);
  console.log(`current states: ${[...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join("  ")}`);
  if (values.follow) {
    const timer = setInterval(() => {
      runner.loadCaps();
      print(runner.advance(Date.now()));
    }, 10_000);
    const stop = () => {
      clearInterval(timer);
      store.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    store.close();
  }
} else if (cmd === "events") {
  const store = new Store(values.db!);
  const from = Date.now() - Number(values.hours) * 3_600_000;
  const rows = store.db
    .prepare(
      `SELECT coin, ts, kind, detail FROM events
       WHERE ts >= ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR coin = ?) ORDER BY ts`,
    )
    .all(from, values.kind ?? null, values.kind ?? null, values.coin ?? null, values.coin ?? null) as
    { coin: string; ts: number; kind: string; detail: string }[];
  for (const e of rows) console.log(`${iso(e.ts)} ${e.kind.padEnd(17)} ${e.coin.padEnd(14)} ${e.detail}`);
  console.log(`${rows.length} events`);
  store.close();
} else if (cmd === "states") {
  const store = new Store(values.db!);
  const rows = store.db
    .prepare(
      `SELECT s.coin, s.ts, s.state, s.confidence, s.calendar, s.behavior, s.conflict, s.metrics FROM states s
       JOIN (SELECT coin, max(ts) AS ts FROM states GROUP BY coin) m ON m.coin = s.coin AND m.ts = s.ts
       WHERE (? IS NULL OR s.coin = ?) ORDER BY s.state, s.coin`,
    )
    .all(values.coin ?? null, values.coin ?? null) as Record<string, string | number>[];
  for (const r of rows) {
    const m = JSON.parse(String(r.metrics)) as { basisBp: number; oracleUpdates: number; towardMark: number | null };
    console.log(
      `${String(r.coin).padEnd(14)} ${String(r.state).padEnd(10)} ${String(r.confidence).padEnd(8)} cal=${String(r.calendar).padEnd(8)} beh=${String(r.behavior).padEnd(12)} ${r.conflict ? "CONFLICT " : ""}basis=${m.basisBp}bp updates=${m.oracleUpdates} toward=${m.towardMark} since ${iso(Number(r.ts))}`,
    );
  }
  store.close();
} else if (cmd === "session") {
  const coin = positionals[1];
  if (!coin) throw new Error("usage: session <coin>, e.g. session xyz:NVDA");
  const cats = await perpCategories();
  const s = sessionFor(coin, Date.now(), cats.get(coin));
  console.log(JSON.stringify({ ...s, next: s.next && { ...s.next, at: iso(s.next.ts) } }, null, 2));
} else {
  console.log("usage: cli.ts <collect|status|compact|detect|events|states|session <coin>> [--db path] [--dex xyz] [--poll-ms 5000] [--ws-top 40] [--hours 24] [--retention-days 7] [--vacuum] [--follow] [--kind k] [--coin c]");
  process.exit(cmd ? 1 : 0);
}
