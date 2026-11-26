// Delivers detector events to webhooks and Telegram. Runs as its own process so
// a slow or failing endpoint never holds up collection or detection.
//
// Delivery is tracked per event per sink. An event is retried until it is sent
// or grows older than maxAgeMs, so a restart neither repeats nor drops alerts,
// and replaying old history does not flood a channel.

import { readFileSync } from "node:fs";
import type { Store } from "./db.ts";
import type { EventKind } from "./detector.ts";

export interface SinkConfig {
  name: string;
  type: "webhook" | "telegram";
  /** Webhook URL. Prefer urlEnv when the URL itself is a secret. */
  url?: string;
  /** Name of an environment variable holding the webhook URL. */
  urlEnv?: string;
  /** Telegram chat id. The bot token is read from tokenEnv, never from this file. */
  chatId?: string;
  tokenEnv?: string;
  /** Only these event kinds. Omit for all. */
  kinds?: EventKind[];
  /** Only these perps, e.g. "xyz:SKHX". Omit for all. */
  coins?: string[];
}

export interface AlertConfig {
  sinks: SinkConfig[];
}

export interface AlertEvent {
  coin: string;
  ts: number;
  kind: string;
  detail: Record<string, unknown>;
}

const NAME = /^[a-z0-9_-]{1,40}$/;

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as AlertConfig;
  if (!Array.isArray(cfg.sinks) || cfg.sinks.length === 0) throw new Error("alert config needs at least one sink");
  const seen = new Set<string>();
  for (const s of cfg.sinks) {
    if (!NAME.test(s.name ?? "")) throw new Error(`sink name must match ${NAME}: ${String(s.name)}`);
    if (seen.has(s.name)) throw new Error(`duplicate sink name ${s.name}`);
    seen.add(s.name);
    if (s.type === "webhook") {
      if (!s.url && !(s.urlEnv && env[s.urlEnv])) throw new Error(`sink ${s.name}: set url, or urlEnv naming a variable that is set`);
    } else if (s.type === "telegram") {
      if (!s.chatId) throw new Error(`sink ${s.name}: chatId is required`);
      if (!env[s.tokenEnv ?? "TELEGRAM_BOT_TOKEN"]) throw new Error(`sink ${s.name}: ${s.tokenEnv ?? "TELEGRAM_BOT_TOKEN"} is not set`);
    } else {
      throw new Error(`sink ${s.name}: unknown type`);
    }
  }
  return cfg;
}

export const wants = (s: SinkConfig, e: AlertEvent): boolean =>
  (!s.kinds || s.kinds.includes(e.kind as EventKind)) && (!s.coins || s.coins.includes(e.coin));

const fmt = (v: unknown): string => (typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v));

/** One line a person can act on, then the raw fields. */
export function formatText(e: AlertEvent): string {
  const d = e.detail;
  const headline: Record<string, () => string> = {
    mode_switch: () => `oracle switched ${fmt(d.from)} → ${fmt(d.to)} (evidence: ${fmt(d.confidence)}), basis ${fmt(d.basisBp)} bp`,
    basis_breach: () => `mark is ${fmt(d.basisBp)} bp from oracle, ${fmt(d.z)} sigma from its usual level`,
    oracle_jump: () => `oracle moved ${fmt(d.stepBp)} bp in one update (${fmt(d.from)} → ${fmt(d.to)})`,
    oracle_stale: () => `oracle has not updated for ${fmt(d.seconds)} s while mark kept moving`,
    funding_extreme: () => `hourly funding ${fmt(Number(d.funding1h) * 100)}%, basis ${fmt(d.basisBp)} bp`,
    oi_cap_near: () => `open interest at ${fmt(Number(d.usage) * 100)}% of the deployer's cap`,
    calendar_conflict: () => `oracle behaves ${fmt(d.behavior)} while the calendar says ${fmt(d.calendar)}`,
  };
  const line = headline[e.kind]?.() ?? Object.entries(d).map(([k, v]) => `${k} ${fmt(v)}`).join(", ");
  return `${e.coin} · ${e.kind.replace(/_/g, " ")}\n${line}\n${new Date(e.ts).toISOString()} · inferred from public data, not investment advice`;
}

type Fetch = typeof fetch;

async function send(s: SinkConfig, e: AlertEvent, env: NodeJS.ProcessEnv, doFetch: Fetch): Promise<void> {
  let url: string;
  let body: unknown;
  if (s.type === "webhook") {
    url = s.url ?? env[s.urlEnv!]!;
    // `text` and `content` make the same payload readable by Slack- and Discord-style webhooks.
    const text = formatText(e);
    body = { text, content: text, event: { ...e, at: new Date(e.ts).toISOString() } };
  } else {
    url = `https://api.telegram.org/bot${env[s.tokenEnv ?? "TELEGRAM_BOT_TOKEN"]}/sendMessage`;
    body = { chat_id: s.chatId, text: formatText(e), disable_web_page_preview: true };
  }
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  // The URL may embed a token, so errors name the sink and status only.
  if (!res.ok) throw new Error(`sink ${s.name}: HTTP ${res.status}`);
}

export interface DispatchOptions {
  /** Events older than this are marked expired instead of sent. */
  maxAgeMs: number;
  /** At most this many sends per sink per pass, so a burst cannot trip a rate limit. */
  maxPerPass: number;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  log?: (msg: string) => void;
}

export const dispatchDefaults: DispatchOptions = { maxAgeMs: 30 * 60_000, maxPerPass: 20 };

/** One pass: send every wanted, undelivered, recent event to each sink. */
export async function dispatch(
  store: Store, cfg: AlertConfig, now: number, opts: DispatchOptions = dispatchDefaults,
): Promise<{ sent: number; failed: number; expired: number }> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const out = { sent: 0, failed: 0, expired: 0 };
  const pending = store.db.prepare(
    `SELECT e.coin, e.ts, e.kind, e.detail FROM events e
     WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.sink = ? AND d.coin = e.coin AND d.kind = e.kind AND d.ts = e.ts)
     ORDER BY e.ts`,
  );
  const mark = store.db.prepare("INSERT OR REPLACE INTO deliveries (sink, coin, kind, ts, at, outcome) VALUES (?, ?, ?, ?, ?, ?)");
  for (const s of cfg.sinks) {
    let sends = 0;
    for (const r of pending.all(s.name) as { coin: string; ts: number; kind: string; detail: string }[]) {
      const e: AlertEvent = { coin: r.coin, ts: r.ts, kind: r.kind, detail: JSON.parse(r.detail) as Record<string, unknown> };
      if (!wants(s, e)) {
        mark.run(s.name, e.coin, e.kind, e.ts, now, "filtered");
      } else if (now - e.ts > opts.maxAgeMs) {
        mark.run(s.name, e.coin, e.kind, e.ts, now, "expired");
        out.expired++;
      } else if (sends < opts.maxPerPass) {
        sends++;
        try {
          await send(s, e, env, doFetch);
          mark.run(s.name, e.coin, e.kind, e.ts, now, "sent");
          out.sent++;
        } catch (err) {
          // Left unmarked so the next pass retries it, until it expires.
          out.failed++;
          opts.log?.(`alert not delivered, will retry: ${(err as Error).message}`);
        }
      }
    }
  }
  return out;
}
