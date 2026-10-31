// Stands in for Node for Max in tests: records what the device sends, and lets a test send messages in.
type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
export const sent: unknown[][] = [];
export const deliver = (name: string, ...args: unknown[]) => handlers.get(name)?.(...args);

export default {
  addHandler(name: string, handler: Handler) { handlers.set(name, handler); },
  async outlet(...args: unknown[]) { sent.push(args); },
  post() {},
};
