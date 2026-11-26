import { test } from "node:test";
import assert from "node:assert/strict";
import { nextChange, phaseAt, sessionFor, venueFor } from "../src/calendar.ts";

const at = (iso: string) => Date.parse(iso);

test("US equity regular, extended and closed phases", () => {
  assert.equal(phaseAt("us_equity", at("2026-11-24T15:00:00Z")), "regular"); // 10:00 ET Tue
  assert.equal(phaseAt("us_equity", at("2026-11-24T10:00:00Z")), "extended"); // 05:00 ET
  assert.equal(phaseAt("us_equity", at("2026-11-24T22:00:00Z")), "extended"); // 17:00 ET
  assert.equal(phaseAt("us_equity", at("2026-11-25T03:00:00Z")), "closed"); // 22:00 ET
  assert.equal(phaseAt("us_equity", at("2026-11-28T15:00:00Z")), "closed"); // Saturday
});

test("US holiday and early close", () => {
  assert.equal(phaseAt("us_equity", at("2026-11-26T15:00:00Z")), "closed"); // Thanksgiving
  assert.equal(phaseAt("us_equity", at("2026-11-27T17:00:00Z")), "regular"); // 12:00 ET
  assert.equal(phaseAt("us_equity", at("2026-11-27T19:00:00Z")), "closed"); // 14:00 ET, after 13:00 close
});

test("daylight saving shifts the UTC open", () => {
  assert.equal(phaseAt("us_equity", at("2026-07-07T13:45:00Z")), "regular"); // 09:45 EDT
  assert.equal(phaseAt("us_equity", at("2026-12-08T13:45:00Z")), "extended"); // 08:45 EST
});

test("KRX session in UTC terms", () => {
  assert.equal(phaseAt("krx", at("2026-11-26T00:30:00Z")), "regular"); // 09:30 KST
  assert.equal(phaseAt("krx", at("2026-11-26T07:00:00Z")), "closed"); // 16:00 KST
});

test("continuous venues close for the weekend and the daily break", () => {
  assert.equal(phaseAt("cme", at("2026-11-25T15:00:00Z")), "regular");
  assert.equal(phaseAt("cme", at("2026-11-25T22:30:00Z")), "closed"); // 16:30 CT break
  assert.equal(phaseAt("cme", at("2026-11-28T15:00:00Z")), "closed"); // Saturday
  assert.equal(phaseAt("fx", at("2026-11-29T23:00:00Z")), "regular"); // Sunday 18:00 ET
});

test("nextChange finds the following boundary", () => {
  const n = nextChange("us_equity", at("2026-11-24T15:00:00Z"));
  assert.deepEqual(n, { ts: at("2026-11-24T21:00:00Z"), phase: "extended" });
});

test("venue mapping and unknown tickers", () => {
  assert.equal(venueFor("xyz:NVDA", "stocks"), "us_equity");
  assert.equal(venueFor("xyz:SKHX", "stocks"), "krx");
  assert.equal(venueFor("xyz:ANT", "stocks"), null);
  assert.equal(venueFor("xyz:NEWLISTING"), null);
  assert.equal(sessionFor("xyz:ANT", Date.now(), "stocks").phase, "unknown");
});
