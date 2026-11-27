// Minimal Hyperliquid info client. Read-only; no signing, no orders.

export const INFO_URL = "https://api.hyperliquid.xyz/info";
export const WS_URL = "wss://api.hyperliquid.xyz/ws";

/** Raw per-asset context as returned by metaAndAssetCtxs and activeAssetCtx. */
export interface RawCtx {
  funding: string;
  openInterest: string;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: [string, string] | null;
  premium: string | null;
  dayNtlVlm: string;
}

export interface Tick {
  coin: string;
  ts: number; // ms since epoch, local receive time
  oracle: number;
  mark: number;
  mid: number | null;
  impactBid: number | null;
  impactAsk: number | null;
  funding: number;
  openInterest: number;
  dayNtlVlm: number;
  src: "poll" | "ws";
}

export function toTick(coin: string, c: RawCtx, ts: number, src: Tick["src"]): Tick {
  return {
    coin,
    ts,
    oracle: Number(c.oraclePx),
    mark: Number(c.markPx),
    mid: c.midPx == null ? null : Number(c.midPx),
    impactBid: c.impactPxs ? Number(c.impactPxs[0]) : null,
    impactAsk: c.impactPxs ? Number(c.impactPxs[1]) : null,
    funding: Number(c.funding),
    openInterest: Number(c.openInterest),
    dayNtlVlm: Number(c.dayNtlVlm),
    src,
  };
}

export async function info<T>(body: Record<string, unknown>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(INFO_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`info ${String(body.type)}: HTTP ${res.status}`);
      const json = (await res.json()) as T | null;
      // The API occasionally answers 200 with a null body under load.
      if (json == null) throw new Error(`info ${String(body.type)}: null body`);
      return json;
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

export interface AssetMeta {
  name: string;
  isDelisted?: boolean;
}

export async function metaAndAssetCtxs(dex: string): Promise<{ coins: string[]; ctxs: RawCtx[] }> {
  const [meta, ctxs] = await info<[{ universe: AssetMeta[] }, RawCtx[]]>({ type: "metaAndAssetCtxs", dex });
  return { coins: meta.universe.map((u) => u.name), ctxs };
}

export async function perpDexConfig(dex: string): Promise<Record<string, unknown> | null> {
  const all = await info<(Record<string, unknown> | null)[]>({ type: "perpDexs" });
  return all.find((d) => d?.name === dex) ?? null;
}

export async function perpCategories(): Promise<Map<string, string>> {
  return new Map(await info<[string, string][]>({ type: "perpCategories" }));
}
