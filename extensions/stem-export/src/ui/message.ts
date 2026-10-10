// A small modal message page for the commands layer. Like mapping.html it is a data: URL, and it
// answers through `close_and_send` with the id of the button pressed. Every string is escaped.

export interface MessageButton { id: string; label: string }
export interface MessageSpec {
  title: string;
  /** One paragraph per entry. Blank strings are skipped. */
  lines: string[];
  /** Defaults to a single OK. The FIRST button is the primary one. */
  buttons?: MessageButton[];
}

export const OK: MessageButton = { id: "ok", label: "OK" };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function messagePage(m: MessageSpec): string {
  const buttons = m.buttons?.length ? m.buttons : [OK];
  const body = m.lines.filter((l) => l.trim() !== "").map((l) => `<p>${esc(l)}</p>`).join("");
  const btns = buttons
    .map((b, i) => `<button${i === 0 ? ' class="primary"' : ""} data-id="${esc(b.id)}">${esc(b.label)}</button>`)
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(m.title)}</title>
<style>
  body { font: 12px -apple-system, system-ui, sans-serif; margin: 0; padding: 14px 16px; background: #2b2b2b; color: #e6e6e6; }
  h1 { font-size: 13px; margin: 0 0 10px; }
  p { margin: 0 0 8px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; user-select: text; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  button { font: inherit; padding: 3px 14px; border: 1px solid #555; background: #3a3a3a; color: inherit; cursor: pointer; }
  button.primary { background: #ffad32; color: #1a1a1a; border-color: #ffad32; }
</style></head><body>
<h1>${esc(m.title)}</h1>${body}<div class="btns">${btns}</div>
<script>
  function send(id) {
    const msg = { method: "close_and_send", params: [id] };
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) window.webkit.messageHandlers.live.postMessage(msg);
    else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg);
  }
  document.querySelectorAll("button").forEach((b) => (b.onclick = () => send(b.dataset.id)));
</script></body></html>`;
}

export function messageUrl(m: MessageSpec): string {
  return "data:text/html," + encodeURIComponent(messagePage(m));
}
