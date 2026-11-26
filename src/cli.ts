#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Collector, defaults } from "./collector.ts";
import { Store } from "./db.ts";
import { perpCategories } from "./hl.ts";
import { sessionFor } from "./calendar.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string", default: defaults.dbPath },
    dex: { type: "string", default: defaults.dex },
    "poll-ms": { type: "string", default: String(defaults.pollMs) },
    "ws-top": { type: "string", default: String(defaults.wsTopN) },
    hours: { type: "string", default: "24" },
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
} else if (cmd === "session") {
  const coin = positionals[1];
  if (!coin) throw new Error("usage: session <coin>, e.g. session xyz:NVDA");
  const cats = await perpCategories();
  const s = sessionFor(coin, Date.now(), cats.get(coin));
  console.log(JSON.stringify({ ...s, next: s.next && { ...s.next, at: iso(s.next.ts) } }, null, 2));
} else {
  console.log("usage: cli.ts <collect|status|session <coin>> [--db path] [--dex xyz] [--poll-ms 5000] [--ws-top 40] [--hours 24]");
  process.exit(cmd ? 1 : 0);
}
