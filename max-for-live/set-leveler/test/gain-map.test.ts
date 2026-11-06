import { describe, expect, it } from "vitest";
import { dbToRaw, GAIN_TABLE, MAX_DB, rawToDb } from "../src/gain-map.js";

describe("gain map", () => {
  it("knows the values Live reported", () => {
    expect(rawToDb(0.4)).toBeCloseTo(0, 6);
    expect(rawToDb(1)).toBeCloseTo(24, 6);
    expect(rawToDb(0.2)).toBeCloseTo(-16.4, 6);
    expect(rawToDb(0.01)).toBeCloseTo(-57.4, 6);
    expect(rawToDb(0)).toBe(-Infinity);
  });

  it("reads Live's stored float for 0 dB as 0 dB", () => {
    expect(rawToDb(0.4000000059604645)).toBeCloseTo(0, 3);
  });

  it("round-trips every entry", () => {
    for (const [, db] of GAIN_TABLE) expect(rawToDb(dbToRaw(db).raw)).toBeCloseTo(db, 1);
  });

  it("round-trips between entries", () => {
    expect(rawToDb(dbToRaw(-11.3).raw)).toBeCloseTo(-11.3, 2);
    expect(dbToRaw(4).raw).toBeCloseTo(0.5, 6);
  });

  it("clamps above the top of the range", () => {
    expect(dbToRaw(MAX_DB + 6)).toEqual({ raw: 1, clamped: true });
  });

  it("clamps below the bottom of the range without muting the clip", () => {
    const r = dbToRaw(-90);
    expect(r.clamped).toBe(true);
    expect(r.raw).toBeGreaterThan(0);
  });

  it("doesn't flag a value in range", () => expect(dbToRaw(-3).clamped).toBe(false));
});
