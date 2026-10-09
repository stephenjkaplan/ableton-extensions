import type { Registry } from "./registry.js";

export const DEFAULT_REGISTRY: Registry = {
  instruments: [
    { name: "Guitar",   variants: ["Played", "Backing"] },
    { name: "Sub37",    variants: ["Played", "Played ONLY SUB", "Played Rev2-able", "Backing"] },
    { name: "Rev2",     variants: ["Played", "Backing"] },
    { name: "Organ",    variants: ["Played", "Backing"] },
    { name: "Rhodes",   variants: ["Played", "Backing"] },
    { name: "Clavinet", variants: ["Played", "Backing"] },
    { name: "Pianet",   variants: ["Played", "Backing"] },
    { name: "Piano",    variants: ["Played", "Backing"] },
    { name: "Keys",     variants: ["Played", "Backing"] },
    { name: "Arturia",  variants: ["Played", "Backing"] },
    { name: "Serum",    variants: ["Played", "Backing"] },
    { name: "Vibes",    variants: ["Played", "Backing"] },
    { name: "Talkbox",  variants: ["Played", "Backing"] },
    { name: "Vocals",   variants: ["Played", "Backing"] },
    { name: "Samples",  variants: ["Played", "Backing"] },
  ],
  fixedStems: ["Drums", "Vocals", "Samples", "Vocal Samples", "Backing"],
  instrumentSlotsPerDeck: 8,
  extrasDir: "Extras",
};
