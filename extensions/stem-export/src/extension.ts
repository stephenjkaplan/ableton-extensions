import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { Commands } from "./commands.js";
import { hostFromContext, showMessage } from "./live.js";

type Context = ReturnType<typeof initialize<"1.0.0">>;

const SCOPES = ["AudioTrack", "MidiTrack"] as const;

const COMMANDS = [
  { id: "stem-export.configure", title: "Stem Export…", run: (c: Commands) => c.configure() },
  { id: "stem-export.next", title: "Stem Export: Next Pass", run: (c: Commands) => c.next() },
  { id: "stem-export.finish", title: "Stem Export: Finish", run: (c: Commands) => c.finish() },
  { id: "stem-export.abort", title: "Stem Export: Abort", run: (c: Commands) => c.abort() },
] as const;

/** Registers the four commands, each on both track scopes. Split out from `activate` so it is testable. */
export function registerAll(context: Context): void {
  let commands: Commands | null = null;
  // Built on first use, so a missing storage/temp directory is reported when a command runs.
  const get = () => (commands ??= new Commands(hostFromContext(context)));

  for (const cmd of COMMANDS) {
    context.commands.registerCommand(cmd.id, async () => {
      try {
        await cmd.run(get());
      } catch (err) {
        // Never swallow: a failed command must say so, and the log keeps the stack.
        console.error(`[stem-export] ${cmd.id} failed:`, err);
        const text = err instanceof Error ? err.message : String(err);
        try {
          await showMessage(context, { title: `${cmd.title} failed`, lines: [text] });
        } catch { /* the dialog itself is unavailable; the log above is all there is */ }
      }
    });
    for (const scope of SCOPES) {
      context.ui.registerContextMenuAction(scope, cmd.title, cmd.id)
        .catch((err: unknown) => console.error(`[stem-export] could not register ${cmd.id} on ${scope}:`, err));
    }
  }
}

export const activate = (activation: ActivationContext) => {
  registerAll(initialize(activation, "1.0.0"));
};
