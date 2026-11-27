import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/db.ts";
import { Queries } from "../src/query.ts";
import { route } from "../src/http.ts";
import { buildServer } from "../src/mcp.ts";
import { toTick } from "../src/hl.ts";

const NOW = Date.parse("2026-11-24T15:00:00Z"); // Tuesday 10:00 New York
const M = 60_000;

function fixture() {
  const store = new Store(":memory:");
  const t = (coin: string, ts: number, oracle: number, mark: number, funding = "0.00001") =>
    toTick(coin, { funding, openInterest: "1000", oraclePx: String(oracle), markPx: String(mark), midPx: String(mark), impactPxs: null, premium: null, dayNtlVlm: "1" }, ts, "poll");
  store.writeTicks([
    t("xyz:NVDA", NOW - 20 * M, 100, 100.1),
    t("xyz:NVDA", NOW - 9 * M, 100, 100.4),
    t("xyz:NVDA", NOW - 10_000, 100, 100.2),
    t("xyz:SKHX", NOW - 5_000, 800, 790, "-0.0008"),
    t("xyz:GOLD", NOW - 5_000, 3500, 3500.35),
  ]);
  store.db.prepare(
    `INSERT INTO bars_1m VALUES ('xyz:NVDA', ?, 99, 99.5, 98.9, 99.2, 99.3, 99.9, 99.1, 99.4, 99.4, -5, 40, 12, 0.00002, 900, 30, 0, 0, 0)`,
  ).run(NOW - 60 * M);
  const st = store.db.prepare("INSERT INTO states VALUES (?, ?, ?, ?, ?, ?, ?, '{}')");
  st.run("xyz:NVDA", NOW - 30 * M, "external", "both", "regular", "external", 0);
  st.run("xyz:SKHX", NOW - 50 * M, "external", "behavior", "closed", "external", 1);
  st.run("xyz:SKHX", NOW - 4 * M, "internal", "both", "closed", "internal", 0);
  store.db.prepare("INSERT INTO events VALUES ('xyz:SKHX', ?, 'mode_switch', ?)").run(NOW - 4 * M, JSON.stringify({ from: "external", to: "internal" }));
  store.db.prepare("INSERT INTO events VALUES ('xyz:SKHX', ?, 'funding_extreme', '{}')").run(NOW - 40 * M);
  store.recordPoll(NOW - 5_000, "xyz", 3, 2);
  store.setKv("detector_last_run", String(NOW - 10 * M));
  return { store, q: new Queries(store, new Map([["xyz:NVDA", "stocks"], ["xyz:SKHX", "stocks"], ["xyz:GOLD", "commodities"]]), () => NOW) };
}

test("oracle state joins the latest tick, the latest state row and the calendar", () => {
  const { q, store } = fixture();
  const s = q.oracleState("xyz:SKHX");
  assert.equal(s.state, "internal");
  assert.equal(s.confidence, "both");
  assert.equal(s.basisBp, -125);
  assert.equal(s.venue, "krx");
  assert.equal(s.openInterestUsd, 790_000);
  assert.equal(s.ageSeconds, 5);
  assert.equal(s.health.collectorRunning, true);
  assert.equal(s.health.detectorRunning, false); // last run ten minutes ago
  assert.equal(q.oracleState("nvda").coin, "xyz:NVDA"); // bare ticker, any case
  assert.throws(() => q.oracleState("xyz:NOPE"), /no recent data/);
  assert.equal(q.oracleState("xyz:GOLD").state, "unknown"); // no detector row yet
  store.close();
});

test("dislocations are ranked by absolute basis and can be filtered", () => {
  const { q, store } = fixture();
  assert.deepEqual(q.dislocations(10).coins.map((c) => c.coin), ["xyz:SKHX", "xyz:NVDA"]);
  assert.deepEqual(q.dislocations(10, "external").coins.map((c) => c.coin), ["xyz:NVDA"]);
  assert.equal(q.dislocations(500).count, 0);
  store.close();
});

test("events are newest first and filterable", () => {
  const { q, store } = fixture();
  assert.deepEqual(q.events({}).events.map((e) => e.kind), ["mode_switch", "funding_extreme"]);
  assert.equal(q.events({ kind: "mode_switch" }).count, 1);
  assert.equal(q.events({ hours: 0.5 }).count, 1);
  assert.equal(q.events({ coin: "GOLD" }).count, 0);
  store.close();
});

test("basis history merges one-minute bars with raw ticks", () => {
  const { q, store } = fixture();
  const h = q.basisHistory("xyz:NVDA", 2, 10);
  assert.deepEqual(h.points.map((p) => p.t.slice(11, 16)), ["14:00", "14:40", "14:50"]);
  assert.equal(h.points[0]!.basisMaxBp, 40); // from the bar
  assert.equal(h.points[2]!.basisBp, 20); // close of the last bucket
  assert.equal(h.points[2]!.basisMaxBp, 40); // 100.4 inside that bucket
  assert.throws(() => q.basisHistory("xyz:NVDA", 2000, 1), RangeError);
  store.close();
});

test("session calendar works without data and admits what it does not know", () => {
  const { q, store } = fixture();
  const nvda = q.sessionCalendar("nvda");
  assert.equal(nvda.coin, "xyz:NVDA");
  assert.equal(nvda.venue, "us_equity");
  assert.equal(nvda.phase, "regular");
  assert.equal(nvda.upcoming[0]!.at, "2026-11-24T21:00:00.000Z");
  assert.equal(nvda.verified, false);
  const other = q.sessionCalendar("xyz:SKHY");
  assert.equal(other.phase, "unknown");
  assert.equal(other.venue, null);
  store.close();
});

test("HTTP routes map to queries and errors to status codes", () => {
  const { q, store } = fixture();
  assert.equal(route(q, "GET", "/v1/state/xyz%3ASKHX").status, 200);
  assert.equal((route(q, "GET", "/v1/overview").body as { coins: unknown[] }).coins.length, 3);
  assert.equal(route(q, "GET", "/v1/state/xyz:NOPE").status, 404);
  assert.equal(route(q, "GET", "/v1/dislocations?minBp=abc").status, 400);
  assert.equal(route(q, "POST", "/v1/overview").status, 405);
  assert.equal(route(q, "GET", "/v2/overview").status, 404);
  store.close();
});

test("MCP server lists five read-only tools and answers a call", async () => {
  const { q, store } = fixture();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer(q);
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_basis_history", "get_events", "get_oracle_state", "get_session_calendar", "list_dislocations"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  const ok = await client.callTool({ name: "get_oracle_state", arguments: { coin: "SKHX" } });
  const body = JSON.parse((ok.content as { text: string }[])[0]!.text) as { state: string; basisBp: number };
  assert.equal(body.state, "internal");
  assert.equal(body.basisBp, -125);
  const bad = await client.callTool({ name: "get_oracle_state", arguments: { coin: "NOPE" } });
  assert.equal(bad.isError, true);
  const d = await client.callTool({ name: "list_dislocations", arguments: {} });
  assert.equal((JSON.parse((d.content as { text: string }[])[0]!.text) as { count: number }).count, 2);
  await client.close();
  store.close();
});

test("coin detail bundles snapshot, series, state bands, session bands and events", () => {
  const { q, store } = fixture();
  const d = q.coinDetail("SKHX", 2, 10);
  assert.equal(d.coin, "xyz:SKHX");
  assert.equal(d.current.state, "internal");
  assert.equal(d.window.to, NOW);
  assert.equal(d.window.from, NOW - 120 * M);
  assert.equal(d.venue.id, "krx");
  assert.equal(d.venue.timezone, "Asia/Seoul");
  assert.equal(typeof d.series[0]!.ts, "number");
  assert.equal(d.series.at(-1)!.basisBp, -125);
  // external since before the window, internal for the last four minutes
  assert.deepEqual(d.stateSegments.map((s) => [s.state, s.from, s.to, s.conflict]), [
    ["external", NOW - 50 * M, NOW - 4 * M, true],
    ["internal", NOW - 4 * M, NOW, false],
  ]);
  // 2026-11-24 15:00 UTC is midnight in Seoul: closed for the whole window
  assert.deepEqual(d.sessionSegments, [{ from: NOW - 120 * M, to: NOW, phase: "closed" }]);
  assert.deepEqual(d.events.map((e) => [e.kind, e.ts]), [["funding_extreme", NOW - 40 * M], ["mode_switch", NOW - 4 * M]]);
  assert.equal(d.venue.nextScheduledChange!.phase, "extended");

  const nv = q.coinDetail("xyz:NVDA", 0.5, 10);
  assert.deepEqual(nv.stateSegments.map((s) => [s.state, s.from]), [["external", NOW - 30 * M]]); // clipped to the window start
  assert.equal(q.coinDetail("xyz:GOLD", 1).stateSegments.length, 0); // detector has not seen it
  assert.equal(route(q, "GET", "/v1/coin/SKHX?hours=2&intervalMinutes=10").status, 200);
  assert.equal(route(q, "GET", "/v1/coin/NOPE").status, 404);
  assert.deepEqual((route(q, "GET", "/v1/coins").body as { coins: { coin: string; venue: string | null }[] }).coins.map((c) => [c.coin, c.venue]),
    [["xyz:GOLD", "cme"], ["xyz:NVDA", "us_equity"], ["xyz:SKHX", "krx"]]);
  store.close();
});

test("CORS headers are sent, and preflight is answered", async () => {
  const { q, store } = fixture();
  const { startHttp } = await import("../src/http.ts");
  const server = startHttp(q, 0, "127.0.0.1", "http://localhost:3000");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/coins`);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(res.status, 200);
  const pre = await fetch(`http://127.0.0.1:${port}/v1/coins`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  server.close();
  store.close();
});
