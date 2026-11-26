// Read-only HTTP API and status page. Binds to localhost unless told otherwise.

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { NotFound, type Queries } from "./query.ts";

const page = readFileSync(new URL("../web/index.html", import.meta.url));

const num = (v: string | null): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RangeError(`not a number: ${v}`);
  return n;
};

export function route(q: Queries, method: string, rawUrl: string): { status: number; body: unknown } {
  if (method !== "GET") return { status: 405, body: { error: "read-only API" } };
  const url = new URL(rawUrl, "http://localhost");
  const p = url.searchParams;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] !== "v1") return { status: 404, body: { error: "not found" } };
    switch (parts[1]) {
      case "health": return { status: 200, body: q.health() };
      case "overview": return { status: 200, body: q.overview() };
      case "state": return { status: 200, body: q.oracleState(parts[2] ?? "") };
      case "dislocations": return { status: 200, body: q.dislocations(num(p.get("minBp")), p.get("state") ?? undefined, num(p.get("limit"))) };
      case "events": return { status: 200, body: q.events({ coin: p.get("coin") ?? undefined, kind: p.get("kind") ?? undefined, hours: num(p.get("hours")), limit: num(p.get("limit")) }) };
      case "basis": return { status: 200, body: q.basisHistory(parts[2] ?? "", num(p.get("hours")), num(p.get("intervalMinutes"))) };
      case "calendar": return { status: 200, body: q.sessionCalendar(parts[2] ?? "") };
      default: return { status: 404, body: { error: "not found" } };
    }
  } catch (e) {
    if (e instanceof NotFound) return { status: 404, body: { error: e.message } };
    if (e instanceof RangeError) return { status: 400, body: { error: e.message } };
    throw e;
  }
}

export function startHttp(q: Queries, port: number, host: string): Server {
  const server = createServer((req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        return void res.end(page);
      }
      const { status, body } = route(q, req.method ?? "GET", req.url ?? "/");
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
      console.error(e);
    }
  });
  server.listen(port, host);
  return server;
}
