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

-- One-minute bars built from raw ticks once they age past the retention window.
-- Basis is (mark / oracle - 1) in basis points. oracle_max_step_bp is the largest
-- single oracle update inside the minute, which is what the jump detector reads.
CREATE TABLE IF NOT EXISTS bars_1m (
  coin TEXT NOT NULL,
  ts INTEGER NOT NULL,
  oracle_open REAL NOT NULL,
  oracle_high REAL NOT NULL,
  oracle_low REAL NOT NULL,
  oracle_close REAL NOT NULL,
  mark_open REAL NOT NULL,
  mark_high REAL NOT NULL,
  mark_low REAL NOT NULL,
  mark_close REAL NOT NULL,
  mid_close REAL,
  basis_min_bp REAL NOT NULL,
  basis_max_bp REAL NOT NULL,
  oracle_max_step_bp REAL,
  funding_close REAL NOT NULL,
  open_interest_close REAL NOT NULL,
  ticks INTEGER NOT NULL,
  -- Oracle updates in the minute, how many happened while mark differed from
  -- oracle, and how many of those moved toward mark. Kept so the regime can
  -- still be read from history after the raw ticks are gone.
  oracle_updates INTEGER NOT NULL DEFAULT 0,
  judged_updates INTEGER NOT NULL DEFAULT 0,
  toward_updates INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ticks_ts ON ticks (ts);

-- Detector output. states holds one row per change of state or conflict flag;
-- confidence and metrics are as of that change.
CREATE TABLE IF NOT EXISTS states (
  coin TEXT NOT NULL,
  ts INTEGER NOT NULL,
  state TEXT NOT NULL,
  confidence TEXT NOT NULL,
  calendar TEXT NOT NULL,
  behavior TEXT NOT NULL,
  conflict INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events (
  coin TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (coin, kind, ts)
) WITHOUT ROWID;

-- One row per event per sink once it has been sent or deliberately skipped.
CREATE TABLE IF NOT EXISTS deliveries (
  sink TEXT NOT NULL,
  coin TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (sink, coin, kind, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

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

export interface CompactResult {
  ticksRemoved: number;
  barsWritten: number;
  pollsRemoved: number;
  cutoff: number;
}

const MINUTE = 60_000;

// Rows are ranked inside each (coin, minute) so open and close can be picked
// without a self-join. The step is taken against the previous tick of the same
// coin within the chunk, so the first tick of a chunk has no step.
const COMPACT_SQL = `
INSERT OR REPLACE INTO bars_1m
WITH t AS (
  SELECT coin, ts, oracle, mark, mid, funding, open_interest,
         ts / ${MINUTE} * ${MINUTE} AS m,
         (mark / oracle - 1) * 10000 AS basis,
         abs(oracle / LAG(oracle) OVER (PARTITION BY coin ORDER BY ts) - 1) * 10000 AS step,
         LAG(oracle) OVER (PARTITION BY coin ORDER BY ts) AS po,
         LAG(mark) OVER (PARTITION BY coin ORDER BY ts) AS pm,
         ROW_NUMBER() OVER (PARTITION BY coin, ts / ${MINUTE} ORDER BY ts) AS first,
         ROW_NUMBER() OVER (PARTITION BY coin, ts / ${MINUTE} ORDER BY ts DESC) AS last
  FROM ticks WHERE ts >= ? AND ts < ? AND oracle > 0
)
SELECT coin, m,
       max(CASE WHEN first = 1 THEN oracle END), max(oracle), min(oracle), max(CASE WHEN last = 1 THEN oracle END),
       max(CASE WHEN first = 1 THEN mark END), max(mark), min(mark), max(CASE WHEN last = 1 THEN mark END),
       max(CASE WHEN last = 1 THEN mid END),
       min(basis), max(basis), max(step),
       max(CASE WHEN last = 1 THEN funding END),
       max(CASE WHEN last = 1 THEN open_interest END),
       count(*),
       coalesce(sum(oracle <> po), 0),
       coalesce(sum(oracle <> po AND pm <> po), 0),
       coalesce(sum(oracle <> po AND (oracle - po) * (pm - po) > 0), 0)
FROM t GROUP BY coin, m`;

export class Store {
  readonly db: DatabaseSync;
  private readonly insTick;
  private readonly insPoll;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    // Databases created before the update counters existed gain them here.
    const cols = (this.db.prepare("PRAGMA table_info(bars_1m)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["oracle_updates", "judged_updates", "toward_updates"]) {
      if (!cols.includes(c)) this.db.exec(`ALTER TABLE bars_1m ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
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

  /**
   * Folds raw ticks older than `retentionMs` into one-minute bars and deletes them.
   * Works in `chunkMs` slices, each in its own transaction, so a first run over a
   * large backlog neither holds one huge transaction nor loses progress if stopped.
   * The cutoff is minute-aligned, so a minute is never split across two runs.
   */
  compact(now: number, retentionMs: number, pollRetentionMs: number, chunkMs = 6 * 3_600_000): CompactResult {
    const cutoff = Math.floor((now - retentionMs) / MINUTE) * MINUTE;
    const res: CompactResult = { ticksRemoved: 0, barsWritten: 0, pollsRemoved: 0, cutoff };
    const oldest = (this.db.prepare("SELECT min(ts) AS t FROM ticks").get() as { t: number | null }).t;
    if (oldest != null && oldest < cutoff) {
      const ins = this.db.prepare(COMPACT_SQL);
      const del = this.db.prepare("DELETE FROM ticks WHERE ts >= ? AND ts < ?");
      for (let from = Math.floor(oldest / MINUTE) * MINUTE; from < cutoff; from += chunkMs) {
        const to = Math.min(from + chunkMs, cutoff);
        this.db.exec("BEGIN");
        try {
          res.barsWritten += Number(ins.run(from, to).changes);
          res.ticksRemoved += Number(del.run(from, to).changes);
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      }
    }
    res.pollsRemoved = Number(this.db.prepare("DELETE FROM polls WHERE ts < ?").run(now - pollRetentionMs).changes);
    return res;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }

  getKv(key: string): string | null {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  /** Latest stored dex config body, parsed, or null. */
  latestDexConfig(dex: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT body FROM dex_config WHERE dex = ? ORDER BY ts DESC LIMIT 1")
      .get(dex) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Record<string, unknown>) : null;
  }

  /** Returns freed pages to the filesystem. Rewrites the whole file, so run it rarely. */
  vacuum(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  }

  close(): void {
    this.db.close();
  }
}
