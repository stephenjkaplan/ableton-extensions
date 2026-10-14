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
  :root { color-scheme: dark; }
  body { font: 13px "Avenir Next", "Avenir", "Nunito Sans", "Helvetica Neue", system-ui, sans-serif; font-weight: 500;
    -webkit-font-smoothing: antialiased; margin: 0; padding: 20px 22px; background: #17120d; color: #fffcf9; }
  h1 { font-size: 14px; margin: 0 0 14px; padding-left: 10px; border-left: 4px solid #f57825; line-height: 1.3; letter-spacing: .02em; }
  p { margin: 0 0 10px; line-height: 1.5; color: #e4d9cc; white-space: pre-wrap; word-break: break-word; user-select: text; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  button { font: inherit; font-weight: 600; height: 30px; padding: 0 1.3em; border: 1px solid #3d2f21; border-radius: 999px;
    background: #2e2216; color: inherit; cursor: pointer; }
  button:hover { background: #3a2c1d; }
  button.primary { background: #f57825; color: #1a1209; border-color: #f57825; font-weight: 700; }
  button.primary:hover { filter: brightness(1.1); }
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
