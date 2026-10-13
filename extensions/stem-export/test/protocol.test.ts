import { describe, expect, it } from "vitest";
import template from "../src/ui/mapping.html";
import { encodeRequest, parseResponse, type MappingRequest } from "../src/ui/protocol.js";
import { buildRequest } from "./page-fixtures.js";

const req: MappingRequest = buildRequest({
  song: "Learning to Feel", tempDirectory: "/tmp/x",
  tracks: [{ key: "Drums/Kick", name: "Kick", depth: 1, isGroup: false, muted: false, devices: [] }],
  stemNames: ["Drums", "Backing"],
  current: { assignments: { "Drums/Kick": "Drums" }, extras: [] },
  outputPreview: [],
});

const decodePage = (r: MappingRequest) => decodeURIComponent(encodeRequest(r));

/** The request the page actually receives: the `window.__REQUEST__=...;` payload, parsed back from the generated page. */
function payloadOf(page: string): MappingRequest {
  const m = /window\.__REQUEST__=(.*?);<\/script>/s.exec(page);
  if (!m) throw new Error("no __REQUEST__ payload in generated page");
  return JSON.parse(m[1]) as MappingRequest;
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("mapping protocol", () => {
  it("encodes to something embeddable in a data URL", () => {
    const s = encodeRequest(req);
    expect(() => new URL(`data:text/html,${s}`)).not.toThrow();
    expect(payloadOf(decodeURIComponent(s)).song).toBe("Learning to Feel");
  });

  it("survives names with quotes and ampersands", () => {
    const tricky = { ...req, song: `AC/DC "Live" & Loud` };
    expect(payloadOf(decodePage(tricky)).song).toBe(tricky.song);
  });

  it("parses a cancelled response", () => {
    expect(parseResponse(JSON.stringify({ cancelled: true })).cancelled).toBe(true);
  });

  it("parses assignments and extras", () => {
    const r = parseResponse(JSON.stringify({
      cancelled: false, song: "  My Song ", assignments: { "Drums/Kick": "Drums" },
      extras: [{ name: "Kick & Snare", trackKeys: ["Drums/Kick"] }],
    }));
    expect(r.song).toBe("My Song");
    expect(r.assignments["Drums/Kick"]).toBe("Drums");
    expect(r.extras[0].name).toBe("Kick & Snare");
  });

  it("treats an empty reply (window closed with no result) as a cancel, not an error", () => {
    for (const raw of ["", "  \n"]) expect(parseResponse(raw).cancelled).toBe(true);
  });

  it("requires a non-empty song when not cancelled", () => {
    const body = { cancelled: false, assignments: {}, extras: [] };
    expect(() => parseResponse(JSON.stringify(body))).toThrow(/song/);
    expect(() => parseResponse(JSON.stringify({ ...body, song: "  " }))).toThrow(/song/);
  });

  it("throws on malformed input rather than returning a half-built mapping", () => {
    expect(() => parseResponse("not json")).toThrow();
    expect(() => parseResponse(JSON.stringify({ assignments: "nope" }))).toThrow();
  });
});

describe("mapping protocol: injection safety", () => {
  it("cannot be broken out of the script tag by a hostile song name", () => {
    const hostile = { ...req, song: `</script><script>alert(1)</script>` };
    const page = decodePage(hostile);
    expect(payloadOf(page).song).toBe(hostile.song);
    // The template's own </script> tags plus the single one that closes the injected payload; none from the data.
    expect(count(page, "</script>")).toBe(count(template, "</script>") + 1);
    expect(count(page, "<script>")).toBe(count(template, "<script>") + 1);
    expect(page).not.toContain("<script>alert(1)");
  });

  it("does not expand $-sequences in the request JSON", () => {
    const tricky = { ...req, song: "Cost $& $1 $$ $` $'" };
    const page = decodePage(tricky);
    expect(payloadOf(page).song).toBe(tricky.song);
    // A string replacement would have spliced the marker or the page text into the payload.
    expect(count(page, "window.__REQUEST__=")).toBe(1);
    expect(page).not.toContain("<!--REQUEST-->");
  });

  it("round-trips line separators and HTML comment openers in any field", () => {
    const tricky = { ...req, song: "a\u2028b\u2029c <!-- d", snapshot: { ...req.snapshot, tracks: [{ ...req.snapshot.tracks[0], name: "<!--", devices: ["</SCRIPT>"] }] } };
    const page = decodePage(tricky);
    expect(payloadOf(page)).toEqual(tricky);
    expect(page).not.toContain("\u2028");
  });

  it("has no second injection surface: the song appears in the page only inside the payload", () => {
    const page = decodePage({ ...req, song: "UNIQUE-SONG-MARKER" });
    expect(count(page, "UNIQUE-SONG-MARKER")).toBe(1);
  });
});
