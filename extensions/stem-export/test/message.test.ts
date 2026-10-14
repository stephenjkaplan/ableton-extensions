import { describe, expect, it } from "vitest";
import { messagePage, messageUrl } from "../src/ui/message.js";

describe("message page", () => {
  const evil = `"><img src=x onerror=alert(1)><script>x</script>`;
  it("escapes the title, every line and every button", () => {
    const page = messagePage({ title: evil, lines: [evil, "  "], buttons: [{ id: evil, label: evil }] });
    const body = page.split("<script>")[0];   // everything before the page's own script
    expect(body).not.toMatch(/<img/);
    expect(body).not.toContain("<script>x");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body.match(/<p>/g)).toHaveLength(1);   // the blank line is skipped
  });
  it("defaults to one OK button, primary, and answers through close_and_send", () => {
    const page = messagePage({ title: "T", lines: [] });
    expect(page.match(/<button/g)).toHaveLength(1);
    expect(page).toContain('class="primary" data-id="ok">OK');
    expect(page).toContain("close_and_send");
  });
  it("is a data: URL that round-trips", () => {
    const url = messageUrl({ title: "A & B", lines: ["x"] });
    expect(url.startsWith("data:text/html,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:text/html,".length))).toContain("A &amp; B");
  });
});
