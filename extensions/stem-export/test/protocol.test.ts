import { describe, expect, it } from "vitest";
import { encodeRequest, parseResponse, type MappingRequest } from "../src/ui/protocol.js";

const req: MappingRequest = {
  song: "Learning to Feel", tempDirectory: "/tmp/x",
  tracks: [{ key: "Drums/Kick", name: "Kick", depth: 1, isGroup: false, muted: false, devices: [] }],
  stemNames: ["Drums", "Backing"],
  current: { assignments: { "Drums/Kick": "Drums" }, extras: [] },
  findings: [], outputPreview: [],
};

describe("mapping protocol", () => {
  it("encodes to something embeddable in a data URL", () => {
    const s = encodeRequest(req);
    expect(() => new URL(`data:text/html,${s}`)).not.toThrow();
    expect(decodeURIComponent(s)).toContain("Learning to Feel");
  });

  it("survives names with quotes and ampersands", () => {
    const tricky = { ...req, song: `AC/DC "Live" & Loud` };
    expect(decodeURIComponent(encodeRequest(tricky))).toContain(`AC/DC "Live" & Loud`);
  });

  it("parses a cancelled response", () => {
    expect(parseResponse(JSON.stringify({ cancelled: true })).cancelled).toBe(true);
  });

  it("parses assignments and extras", () => {
    const r = parseResponse(JSON.stringify({
      cancelled: false, assignments: { "Drums/Kick": "Drums" },
      extras: [{ name: "Kick & Snare", trackKeys: ["Drums/Kick"] }],
    }));
    expect(r.assignments["Drums/Kick"]).toBe("Drums");
    expect(r.extras[0].name).toBe("Kick & Snare");
  });

  it("throws on malformed input rather than returning a half-built mapping", () => {
    expect(() => parseResponse("not json")).toThrow();
    expect(() => parseResponse(JSON.stringify({ assignments: "nope" }))).toThrow();
  });
});

describe("mapping protocol: injection safety", () => {
  it("cannot be broken out of the script tag by a hostile track name", () => {
    const hostile = { ...req, song: `</script><script>alert(1)</script>` };
    const page = decodeURIComponent(encodeRequest(hostile));
    expect(page).not.toContain("</script><script>alert(1)");
    expect(page).toContain("\\u003c/script>");
  });

  it("does not expand $-sequences in the request JSON", () => {
    const page = decodeURIComponent(encodeRequest({ ...req, song: "Cost $& $1 $$" }));
    expect(page).toContain("Cost $& $1 $$");
  });
});
