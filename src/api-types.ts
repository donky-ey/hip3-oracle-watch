// Response shapes of the HTTP API that a front end is expected to consume.
// This file imports nothing, so it can be copied into a client project as is.
// The server's own return types are checked against it at compile time.

export type OracleStateName = "external" | "internal" | "transition" | "stale" | "unknown";
export type Confidence = "both" | "behavior" | "calendar" | "none";
export type SessionPhase = "regular" | "extended" | "closed" | "unknown";
export type EventKind =
  | "mode_switch" | "basis_breach" | "oracle_jump" | "oracle_stale"
  | "funding_extreme" | "oi_cap_near" | "calendar_conflict";

export interface Health {
  /** ISO 8601 */
  now: string;
  collectorLastPoll: string | null;
  collectorRunning: boolean;
  detectorLastRun: string | null;
  detectorRunning: boolean;
}

/** One perp as of its latest tick. Used by /v1/overview and inside /v1/coin/{coin}. */
export interface CoinSnapshot {
  /** e.g. "xyz:SKHX" */
  coin: string;
  /** Inferred, not published by the deployer. */
  state: OracleStateName | string;
  confidence: Confidence | string;
  /** ISO 8601, or null before the detector has seen the coin. */
  stateSince: string | null;
  calendarPhase: SessionPhase | string;
  behavior: "external" | "internal" | "inconclusive" | string;
  calendarConflict: boolean;
  oraclePx: number;
  markPx: number;
  midPx: number | null;
  /** (mark / oracle - 1) * 10000 */
  basisBp: number;
  /** Fraction per hour; 0.0005 is 0.05%. */
  fundingHourly: number;
  fundingAnnualizedPct: number;
  openInterestUsd: number;
  /** ISO 8601 time of the tick these numbers come from. */
  observed: string;
  ageSeconds: number;
}

export interface Overview {
  coins: CoinSnapshot[];
  note: string;
  source: string;
  health: Health;
}

export interface CoinList {
  coins: { coin: string; category: string | null; venue: string | null }[];
}

/** One bucket of the basis chart. Times are epoch milliseconds, ready for a chart library. */
export interface SeriesPoint {
  ts: number;
  /** Basis at bucket close, in basis points. */
  basisBp: number;
  basisMinBp: number;
  basisMaxBp: number;
  oraclePx: number;
  markPx: number;
  fundingHourly: number;
}

/** A stretch during which the inferred oracle state did not change. Draw as a band behind the chart. */
export interface StateSegment {
  from: number;
  to: number;
  state: OracleStateName | string;
  /** Confidence when the stretch began. */
  confidence: Confidence | string;
  conflict: boolean;
}

/** A stretch of one scheduled session phase of the underlying market. */
export interface SessionSegment {
  from: number;
  to: number;
  phase: SessionPhase;
}

export interface CoinEvent {
  ts: number;
  kind: EventKind | string;
  detail: Record<string, number | string | null>;
}

export interface CoinDetail {
  coin: string;
  category: string | null;
  current: CoinSnapshot;
  venue: {
    id: string | null;
    timezone: string | null;
    /** False until hours and holidays have been checked against the exchange. */
    verified: boolean;
    nextScheduledChange: { ts: number; phase: SessionPhase } | null;
  };
  window: { from: number; to: number; intervalMinutes: number };
  series: SeriesPoint[];
  stateSegments: StateSegment[];
  /** Empty when the reference market has not been identified. */
  sessionSegments: SessionSegment[];
  events: CoinEvent[];
  note: string;
  source: string;
  health: Health;
}

export interface ApiError {
  error: string;
}
