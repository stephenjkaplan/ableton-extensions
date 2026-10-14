import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY as R } from "../src/default-registry.js";
import { instrumentOf, isKnown, stemNames, suggest } from "../src/registry.js";

describe("registry", () => {
  it("expands instrument variants", () => {
    const n = stemNames(R);
    expect(n.has("Sub37 - Rev2 Playable")).toBe(true);
    expect(n.has("Sub37 - Played")).toBe(true);
    expect(n.has("Clavinet - Played")).toBe(true);
    expect(n.has("Rhodes - Backing")).toBe(true);
  });

  it("includes fixed stems", () => {
    for (const s of ["Drums", "Backing", "Vocal Samples"]) expect(isKnown(R, s)).toBe(true);
  });

  it("rejects the real typos from the library", () => {
    expect(isKnown(R, "Organ - Playedl")).toBe(false);
    expect(isKnown(R, "Sub37- Played")).toBe(false);
  });

  it("suggests the nearest legal name", () => {
    expect(suggest(R, "Organ - Playedl")).toBe("Organ - Played");
    expect(suggest(R, "Sub37- Played")).toBe("Sub37 - Played");
  });

  it("returns null when nothing is close", () => {
    expect(suggest(R, "Didgeridoo Orchestra")).toBeNull();
  });

  it("accepts distance 2 but rejects distance 3", () => {
    expect(suggest(R, "Organ - Playedd")).toBe("Organ - Played");  // distance 1
    expect(suggest(R, "Organ - Playeddd")).toBe("Organ - Played"); // distance 2
    expect(suggest(R, "Organ - Playedddd")).toBeNull();            // distance 3, rejected
  });

  it("maps a stem back to its instrument", () => {
    expect(instrumentOf(R, "Rhodes - Backing")).toBe("Rhodes");
    expect(instrumentOf(R, "Drums")).toBeNull();
  });
});
