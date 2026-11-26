import { createHash } from "node:crypto";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Store } from "./db.ts";
import { metaAndAssetCtxs, perpDexConfig, toTick, WS_URL, type RawCtx, type Tick } from "./hl.ts";

export interface CollectorOptions {
  dex: string;
  dbPath: string;
  pollMs: number;
  /** Number of coins, ranked by 24h notional volume, to follow over WebSocket. 0 disables the socket. */
  wsTopN: number;
  configPollMs: number;
  log: (msg: string) => void;
}

export const defaults: CollectorOptions = {
  dex: "xyz",
  dbPath: "oracle-watch.db",
  pollMs: 5_000,
  wsTopN: 40,
  configPollMs: 600_000,
  log: (m) => console.log(`${new Date().toISOString()} ${m}`),
};

/** A tick is worth storing only if one of the fields the detector reads has moved. */
export function changed(prev: Tick | undefined, next: Tick): boolean {
  if (!prev) return true;
  return (
    prev.oracle !== next.oracle ||
    prev.mark !== next.mark ||
    prev.mid !== next.mid ||
    prev.funding !== next.funding ||
    prev.openInterest !== next.openInterest
  );
}

export class Collector {
  private readonly store: Store;
  private readonly last = new Map<string, Tick>();
  private ws: WebSocket | null = null;
  private wsCoins: string[] = [];
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private stats = { polls: 0, pollErrors: 0, pollTicks: 0, wsTicks: 0, wsReconnects: 0 };

  constructor(private readonly opts: CollectorOptions) {
    this.store = new Store(opts.dbPath);
  }

  async start(): Promise<void> {
    const { log } = this.opts;
    await this.pollConfig();
    const ranked = await this.pollOnce();
    if (this.opts.wsTopN > 0 && ranked) {
      this.wsCoins = ranked.slice(0, this.opts.wsTopN);
      this.connectWs();
    }
    this.timers.push(setInterval(() => void this.pollOnce(), this.opts.pollMs));
    this.timers.push(setInterval(() => void this.pollConfig(), this.opts.configPollMs));
    this.timers.push(
      setInterval(() => {
        const s = this.stats;
        log(`polls=${s.polls} pollErrors=${s.pollErrors} pollTicks=${s.pollTicks} wsTicks=${s.wsTicks} wsReconnects=${s.wsReconnects}`);
      }, 60_000),
    );
    log(`collecting dex=${this.opts.dex} every ${this.opts.pollMs}ms, websocket coins=${this.wsCoins.length}`);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.ws?.terminate();
    this.store.close();
  }

  /** One full snapshot of the dex. Returns coins ranked by 24h notional volume, or null on failure. */
  private async pollOnce(): Promise<string[] | null> {
    if (this.stopped) return null;
    try {
      const { coins, ctxs } = await metaAndAssetCtxs(this.opts.dex);
      const ts = Date.now();
      const out: Tick[] = [];
      const vol: [string, number][] = [];
      coins.forEach((coin, i) => {
        const c = ctxs[i];
        if (!c) return;
        const t = toTick(coin, c, ts, "poll");
        if (!Number.isFinite(t.oracle) || !Number.isFinite(t.mark)) return;
        vol.push([coin, t.dayNtlVlm]);
        if (changed(this.last.get(coin), t)) {
          out.push(t);
          this.last.set(coin, t);
        }
      });
      if (this.stopped) return null;
      this.store.writeTicks(out);
      this.store.recordPoll(ts, this.opts.dex, coins.length, out.length);
      this.stats.polls++;
      this.stats.pollTicks += out.length;
      return vol.sort((a, b) => b[1] - a[1]).map(([c]) => c);
    } catch (e) {
      this.stats.pollErrors++;
      this.opts.log(`poll failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async pollConfig(): Promise<void> {
    if (this.stopped) return;
    try {
      const cfg = await perpDexConfig(this.opts.dex);
      if (!cfg || this.stopped) return;
      const body = JSON.stringify(cfg);
      const hash = createHash("sha256").update(body).digest("hex");
      if (this.store.recordDexConfig(Date.now(), this.opts.dex, hash, body)) {
        this.opts.log(`dex config changed (${hash.slice(0, 12)})`);
      }
    } catch (e) {
      this.opts.log(`config poll failed: ${(e as Error).message}`);
    }
  }

  private connectWs(): void {
    if (this.stopped) return;
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const ws = new WebSocket(WS_URL, proxy ? { agent: new HttpsProxyAgent(proxy) } : {});
    this.ws = ws;
    let ping: NodeJS.Timeout | undefined;
    let lastMsg = Date.now();

    ws.on("open", () => {
      this.store.recordWsEvent(Date.now(), "open");
      for (const coin of this.wsCoins) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin } }));
      }
      // The server drops idle sockets after 60s; it answers {"channel":"pong"}.
      ping = setInterval(() => {
        if (Date.now() - lastMsg > 60_000) return ws.terminate();
        ws.send(JSON.stringify({ method: "ping" }));
      }, 25_000);
    });

    ws.on("message", (raw) => {
      lastMsg = Date.now();
      let msg: { channel?: string; data?: { coin?: string; ctx?: RawCtx } };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.channel !== "activeAssetCtx" || !msg.data?.coin || !msg.data.ctx) return;
      const t = toTick(msg.data.coin, msg.data.ctx, lastMsg, "ws");
      if (!Number.isFinite(t.oracle) || !Number.isFinite(t.mark)) return;
      if (!changed(this.last.get(t.coin), t)) return;
      this.last.set(t.coin, t);
      this.store.writeTicks([t]);
      this.stats.wsTicks++;
    });

    ws.on("error", (e) => this.opts.log(`websocket error: ${e.message}`));

    ws.on("close", (code) => {
      clearInterval(ping);
      if (this.stopped) return;
      this.store.recordWsEvent(Date.now(), "close", String(code));
      this.stats.wsReconnects++;
      setTimeout(() => this.connectWs(), 3_000);
    });
  }
}
