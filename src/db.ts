import { DatabaseSync } from "node:sqlite";
import type { Tick } from "./hl.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticks (
  coin TEXT NOT NULL,
  ts INTEGER NOT NULL,
  oracle REAL NOT NULL,
  mark REAL NOT NULL,
  mid REAL,
  impact_bid REAL,
  impact_ask REAL,
  funding REAL NOT NULL,
  open_interest REAL NOT NULL,
  day_ntl_vlm REAL NOT NULL,
  src TEXT NOT NULL,
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;

-- One row per successful full poll. Coverage is measured from this table,
-- not from ticks, because ticks are only written when a value changes.
CREATE TABLE IF NOT EXISTS polls (
  ts INTEGER PRIMARY KEY,
  dex TEXT NOT NULL,
  coins INTEGER NOT NULL,
  written INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dex_config (
  ts INTEGER NOT NULL,
  dex TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (dex, ts)
);

CREATE TABLE IF NOT EXISTS ws_events (
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
`;

export interface Coverage {
  from: number;
  to: number;
  polls: number;
  gaps: { from: number; to: number; seconds: number }[];
  gapSeconds: number;
  ticks: number;
  coins: number;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly insTick;
  private readonly insPoll;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this.insTick = this.db.prepare(
      `INSERT OR IGNORE INTO ticks
       (coin, ts, oracle, mark, mid, impact_bid, impact_ask, funding, open_interest, day_ntl_vlm, src)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insPoll = this.db.prepare("INSERT OR REPLACE INTO polls (ts, dex, coins, written) VALUES (?, ?, ?, ?)");
  }

  writeTicks(ticks: Tick[]): void {
    if (ticks.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const t of ticks) {
        this.insTick.run(
          t.coin, t.ts, t.oracle, t.mark, t.mid, t.impactBid, t.impactAsk,
          t.funding, t.openInterest, t.dayNtlVlm, t.src,
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  recordPoll(ts: number, dex: string, coins: number, written: number): void {
    this.insPoll.run(ts, dex, coins, written);
  }

  /** Stores the dex config only when it differs from the last stored one. Returns true if it changed. */
  recordDexConfig(ts: number, dex: string, hash: string, body: string): boolean {
    const last = this.db
      .prepare("SELECT hash FROM dex_config WHERE dex = ? ORDER BY ts DESC LIMIT 1")
      .get(dex) as { hash: string } | undefined;
    if (last?.hash === hash) return false;
    this.db.prepare("INSERT INTO dex_config (ts, dex, hash, body) VALUES (?, ?, ?, ?)").run(ts, dex, hash, body);
    return last !== undefined;
  }

  recordWsEvent(ts: number, kind: string, detail?: string): void {
    this.db.prepare("INSERT INTO ws_events (ts, kind, detail) VALUES (?, ?, ?)").run(ts, kind, detail ?? null);
  }

  /** A gap is any stretch between consecutive successful polls longer than maxGapMs. */
  coverage(dex: string, from: number, to: number, maxGapMs: number): Coverage {
    const rows = this.db
      .prepare("SELECT ts FROM polls WHERE dex = ? AND ts BETWEEN ? AND ? ORDER BY ts")
      .all(dex, from, to) as { ts: number }[];
    const gaps: Coverage["gaps"] = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!.ts;
      const b = rows[i]!.ts;
      if (b - a > maxGapMs) gaps.push({ from: a, to: b, seconds: Math.round((b - a) / 1000) });
    }
    const agg = this.db
      .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT coin) AS c FROM ticks WHERE ts BETWEEN ? AND ?")
      .get(from, to) as { n: number; c: number };
    return {
      from: rows[0]?.ts ?? from,
      to: rows.at(-1)?.ts ?? to,
      polls: rows.length,
      gaps,
      gapSeconds: gaps.reduce((s, g) => s + g.seconds, 0),
      ticks: agg.n,
      coins: agg.c,
    };
  }

  close(): void {
    this.db.close();
  }
}
