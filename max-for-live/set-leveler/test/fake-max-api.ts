// Stands in for Node for Max in tests: records what the device sends, and lets a test send messages in.
type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
export const sent: unknown[][] = [];
export const failOutlets = { on: false }; // Node for Max rejects an outlet that gets no reply within 3 s
export const deliver = (name: string, ...args: unknown[]) => handlers.get(name)?.(...args);

export default {
  addHandler(name: string, handler: Handler) { handlers.set(name, handler); },
  async outlet(...args: unknown[]) {
    sent.push(args);
    if (failOutlets.on) throw new Error("Max didn't reply in time");
  },
  post() {},
};
