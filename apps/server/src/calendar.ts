// Session calendar for the underlying markets. Pure functions over static data,
// so the detector can be replayed against history.

import venuesJson from "../data/venues.json" with { type: "json" };
import symbolsJson from "../data/symbols.json" with { type: "json" };

export type Phase = "regular" | "extended" | "closed";

export interface Venue {
  tz: string;
  /** Local "HH:MM-HH:MM" windows on trading days. May cross midnight only for `continuous` venues. */
  regular: string | null;
  extended: string[];
  /** Local dates (YYYY-MM-DD) with no session. */
  holidays: string[];
  /** Local dates mapped to an early regular close ("HH:MM"). */
  earlyClose: Record<string, string>;
  /**
   * Near-24h venues: open from weekOpen on Sunday to weekClose on Friday with an
   * optional daily break. If `regular` is also set it only labels the phase:
   * inside it is "regular", the rest of the open time is "extended".
   */
  continuous?: {
    weekOpen: string;
    weekClose: string;
    dailyBreak: string | null;
    /** On a holiday the venue is closed until this local time, then trades again (the next day's overnight session). */
    holidayReopen?: string;
  };
  /** False until a human has checked hours and holidays against the exchange's own notice. */
  verified: boolean;
}

export const venues = venuesJson.venues as unknown as Record<string, Venue>;
const overrides = symbolsJson.overrides as Record<string, string>;
const categoryDefault = symbolsJson.categoryDefault as Record<string, string>;

/** Venue id for a coin such as "xyz:NVDA", or null when the underlying market is not known. */
export function venueFor(coin: string, category?: string): string | null {
  const ticker = coin.includes(":") ? coin.slice(coin.indexOf(":") + 1) : coin;
  const v = overrides[ticker] ?? (category ? categoryDefault[category] : undefined);
  return v && v !== "unknown" ? v : null;
}

interface Local {
  date: string; // YYYY-MM-DD
  dow: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function toLocal(ts: number, tz: string): Local {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    fmtCache.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const hm = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return h! * 60 + m!;
};
const win = (s: string): [number, number] => {
  const [a, b] = s.split("-");
  return [hm(a!), hm(b!)];
};
const inside = (min: number, [a, b]: [number, number]): boolean => min >= a && min < b;

export function phaseAt(venueId: string, ts: number): Phase {
  const v = venues[venueId];
  if (!v) throw new Error(`unknown venue ${venueId}`);
  const l = toLocal(ts, v.tz);

  if (v.continuous) {
    const reopen = v.continuous.holidayReopen;
    if (v.holidays.includes(l.date) && !(reopen && l.minutes >= hm(reopen))) return "closed";
    const open = hm(v.continuous.weekOpen);
    const close = hm(v.continuous.weekClose);
    // Week runs Sunday weekOpen -> Friday weekClose, local time.
    if (l.dow === 6) return "closed";
    if (l.dow === 0 && l.minutes < open) return "closed";
    if (l.dow === 5 && l.minutes >= close) return "closed";
    if (v.continuous.dailyBreak && inside(l.minutes, win(v.continuous.dailyBreak))) return "closed";
    if (!v.regular || v.holidays.includes(l.date)) return v.regular ? "extended" : "regular";
    const [a, b] = win(v.regular);
    const early = v.earlyClose[l.date];
    return inside(l.minutes, [a, early ? hm(early) : b]) ? "regular" : "extended";
  }

  if (l.dow === 0 || l.dow === 6 || v.holidays.includes(l.date)) return "closed";
  if (v.regular) {
    const [a, b] = win(v.regular);
    const early = v.earlyClose[l.date];
    const end = early ? hm(early) : b;
    if (inside(l.minutes, [a, end])) return "regular";
    // On an early-close day there is no after-hours session to speak of.
    if (early && l.minutes >= end) return "closed";
  }
  return v.extended.some((w) => inside(l.minutes, win(w))) ? "extended" : "closed";
}

/** Next time the phase changes, searched minute by minute up to `horizonDays` ahead. */
export function nextChange(venueId: string, ts: number, horizonDays = 10): { ts: number; phase: Phase } | null {
  const start = phaseAt(venueId, ts);
  const step = 60_000;
  let t = Math.floor(ts / step) * step + step;
  const end = ts + horizonDays * 86_400_000;
  for (; t <= end; t += step) {
    const p = phaseAt(venueId, t);
    if (p !== start) return { ts: t, phase: p };
  }
  return null;
}

export interface SessionInfo {
  coin: string;
  venue: string | null;
  phase: Phase | "unknown";
  next: { ts: number; phase: Phase } | null;
  verified: boolean;
}

export function sessionFor(coin: string, ts: number, category?: string): SessionInfo {
  const venue = venueFor(coin, category);
  if (!venue) return { coin, venue: null, phase: "unknown", next: null, verified: false };
  return { coin, venue, phase: phaseAt(venue, ts), next: nextChange(venue, ts), verified: venues[venue]!.verified };
}
