import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { watch } from "node:fs";
import { mkdirSync } from "node:fs";

let commandCount = 0;
let watcherEvents = 0;

export const activate = (activation: ActivationContext) => {
  const context = initialize(activation, "1.0.0");
  const started = Date.now();
  console.log(`[spike] activate() at ${new Date(started).toISOString()}`);

  context.commands.registerCommand("stem-export.spike", async () => {
    commandCount += 1;
    const temp = context.environment.tempDirectory;
    console.log(
      `[spike] command #${commandCount}; ` +
        `${Math.round((Date.now() - started) / 1000)}s since activate; ` +
        `watcherEvents=${watcherEvents}; temp=${temp}`,
    );

    if (commandCount === 1 && temp) {
      mkdirSync(temp, { recursive: true });
      watch(temp, (event, filename) => {
        watcherEvents += 1;
        console.log(`[spike] watcher fired #${watcherEvents}: ${event} ${filename}`);
      });
      console.log(`[spike] watching ${temp} — now export audio there`);
    }
  });

  context.ui.registerContextMenuAction("AudioTrack", "Stem Export: spike", "stem-export.spike");
  context.ui.registerContextMenuAction("MidiTrack", "Stem Export: spike", "stem-export.spike");
};
