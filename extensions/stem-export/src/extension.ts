import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { watch, mkdirSync, type FSWatcher } from "node:fs";

let commandCount = 0;
let watcherEvents = 0;
let watcher: FSWatcher | null = null;

export const activate = (activation: ActivationContext) => {
  const context = initialize(activation, "1.0.0");
  const started = Date.now();
  console.log(`[spike] activate() at ${new Date(started).toISOString()}; pid=${process.pid}`);

  context.commands.registerCommand("stem-export.spike", async () => {
    commandCount += 1;
    const temp = context.environment.tempDirectory;
    console.log(
      `[spike] command #${commandCount}; pid=${process.pid}; ` +
        `${Math.round((Date.now() - started) / 1000)}s since activate; ` +
        `watcherEvents=${watcherEvents}; temp=${temp}`,
    );

    if (!watcher && temp) {
      try {
        mkdirSync(temp, { recursive: true });
        watcher = watch(temp, (event, filename) => {
          watcherEvents += 1;
          console.log(`[spike] watcher fired #${watcherEvents}: ${event} ${filename}`);
        });
        console.log(`[spike] watching ${temp} — now export audio there`);
      } catch (err) {
        watcher = null;
        console.log(`[spike] watcher FAILED to start for ${temp}: ${String(err)}`);
      }
    } else if (!temp) {
      console.log("[spike] tempDirectory is undefined; no watcher started");
    }
  });

  context.ui.registerContextMenuAction("AudioTrack", "Stem Export: spike", "stem-export.spike");
  context.ui.registerContextMenuAction("MidiTrack", "Stem Export: spike", "stem-export.spike");
};
