import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { dispatch, formatText, loadConfig, wants, type AlertConfig } from "../src/alerts.ts";

const NOW = 1_800_000_000_000;
const M = 60_000;

function storeWith(events: [string, number, string, object][]) {
  const s = new Store(":memory:");
  const ins = s.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)");
  for (const [coin, ts, kind, detail] of events) ins.run(coin, ts, kind, JSON.stringify(detail));
  return s;
}
const sw = { from: "external", to: "internal", confidence: "both", basisBp: -117.29 };

test("formatText leads with what happened", () => {
  const t = formatText({ coin: "xyz:SKHX", ts: NOW, kind: "mode_switch", detail: sw });
  assert.match(t, /^xyz:SKHX · mode switch\noracle switched external → internal \(evidence: both\), basis -117\.29 bp\n/);
  assert.match(formatText({ coin: "c", ts: NOW, kind: "funding_extreme", detail: { funding1h: -0.0008, basisBp: -131 } }), /hourly funding -0\.08%/);
  assert.match(formatText({ coin: "c", ts: NOW, kind: "future_kind", detail: { a: 1 } }), /a 1/);
});

test("sink filters by kind and coin", () => {
  const e = { coin: "xyz:SKHX", ts: NOW, kind: "mode_switch", detail: {} };
  assert.equal(wants({ name: "a", type: "webhook" }, e), true);
  assert.equal(wants({ name: "a", type: "webhook", kinds: ["oracle_jump"] }, e), false);
  assert.equal(wants({ name: "a", type: "webhook", coins: ["xyz:SKHX"] }, e), true);
  assert.equal(wants({ name: "a", type: "webhook", coins: ["xyz:NVDA"] }, e), false);
});

test("dispatch sends each event once per sink, skips old and filtered ones, and retries failures", async () => {
  const store = storeWith([
    ["xyz:SKHX", NOW - 2 * M, "mode_switch", sw],
    ["xyz:NVDA", NOW - 1 * M, "funding_extreme", { funding1h: 0.0006, basisBp: 30 }],
    ["xyz:SKHX", NOW - 90 * M, "mode_switch", sw], // too old to be worth an alert
  ]);
  const cfg: AlertConfig = { sinks: [
    { name: "all", type: "webhook", url: "http://hook.test/a" },
    { name: "tg", type: "telegram", chatId: "42", kinds: ["mode_switch"] },
  ] };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let failTelegram = true;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: JSON.parse(String(init!.body)) as Record<string, unknown> });
    return new Response("", { status: u.includes("telegram") && failTelegram ? 500 : 200 });
  }) as typeof fetch;
  const logs: string[] = [];
  const opts = { maxAgeMs: 30 * M, maxPerPass: 20, env: { TELEGRAM_BOT_TOKEN: "SECRET" }, fetch: fake, log: (m: string) => logs.push(m) };

  const r1 = await dispatch(store, cfg, NOW, opts);
  assert.deepEqual(r1, { sent: 2, failed: 1, expired: 2 });
  assert.equal(calls.filter((c) => c.url === "http://hook.test/a").length, 2);
  assert.match(String(calls[0]!.body.text), /xyz:SKHX · mode switch/);
  assert.equal((calls[0]!.body.event as { coin: string }).coin, "xyz:SKHX");
  assert.ok(logs.every((l) => !l.includes("SECRET")), "token must not reach the log");

  failTelegram = false;
  const r2 = await dispatch(store, cfg, NOW + 10_000, opts);
  assert.deepEqual(r2, { sent: 1, failed: 0, expired: 0 }); // only the telegram retry
  const tg = calls.at(-1)!;
  assert.equal(tg.url, "https://api.telegram.org/botSECRET/sendMessage");
  assert.equal(tg.body.chat_id, "42");

  const r3 = await dispatch(store, cfg, NOW + 20_000, opts);
  assert.deepEqual(r3, { sent: 0, failed: 0, expired: 0 });
  store.close();
});

test("a burst is spread over passes", async () => {
  const store = storeWith(Array.from({ length: 5 }, (_, i) => [`xyz:C${i}`, NOW - 1000 - i, "oracle_jump", { stepBp: 150 }] as [string, number, string, object]));
  const cfg: AlertConfig = { sinks: [{ name: "all", type: "webhook", url: "http://hook.test/a" }] };
  const ok = (async () => new Response("")) as unknown as typeof fetch;
  const opts = { maxAgeMs: 30 * M, maxPerPass: 2, fetch: ok };
  assert.equal((await dispatch(store, cfg, NOW, opts)).sent, 2);
  assert.equal((await dispatch(store, cfg, NOW, opts)).sent, 2);
  assert.equal((await dispatch(store, cfg, NOW, opts)).sent, 1);
  store.close();
});

test("webhook delivery over a real socket", async () => {
  const got: string[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { got.push(b); res.end("ok"); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const store = storeWith([["xyz:SKHX", NOW - M, "mode_switch", sw]]);
  const r = await dispatch(store, { sinks: [{ name: "local", type: "webhook", url: `http://127.0.0.1:${port}/hook` }] }, NOW);
  assert.equal(r.sent, 1);
  assert.equal((JSON.parse(got[0]!) as { event: { kind: string } }).event.kind, "mode_switch");
  server.close();
  store.close();
});

test("config validation names the problem and keeps secrets in the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "alerts-"));
  const write = (o: unknown) => { const p = join(dir, "a.json"); writeFileSync(p, JSON.stringify(o)); return p; };
  assert.throws(() => loadConfig(write({ sinks: [] })), /at least one sink/);
  assert.throws(() => loadConfig(write({ sinks: [{ name: "Bad Name", type: "webhook", url: "http://x" }] })), /sink name/);
  assert.throws(() => loadConfig(write({ sinks: [{ name: "a", type: "webhook", urlEnv: "MISSING_URL" }] }), {}), /urlEnv/);
  assert.throws(() => loadConfig(write({ sinks: [{ name: "a", type: "telegram", chatId: "1" }] }), {}), /TELEGRAM_BOT_TOKEN is not set/);
  assert.throws(() => loadConfig(write({ sinks: [{ name: "a", type: "webhook", url: "http://x" }, { name: "a", type: "webhook", url: "http://y" }] })), /duplicate/);
  const ok = loadConfig(write({ sinks: [{ name: "a", type: "telegram", chatId: "1" }, { name: "b", type: "webhook", urlEnv: "U" }] }), { TELEGRAM_BOT_TOKEN: "t", U: "http://x" });
  assert.equal(ok.sinks.length, 2);
});
