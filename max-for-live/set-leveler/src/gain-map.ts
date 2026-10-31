// Live's clip `gain` runs 0.0 to 1.0, not dB. This table is Live's own gain_display_string at each step,
// measured in the spike (docs/superpowers/notes/set-leveler-spike.md). 0.0 is -inf.
export const GAIN_TABLE: readonly (readonly [raw: number, db: number])[] = [
  [0.01, -57.4], [0.02, -48.4], [0.03, -42.9], [0.04, -41.0], [0.05, -39.2], [0.06, -37.4], [0.07, -35.6], [0.08, -33.9],
  [0.09, -32.2], [0.10, -30.6], [0.11, -29.0], [0.12, -27.4], [0.13, -25.9], [0.14, -24.4], [0.15, -23.0], [0.16, -21.6],
  [0.17, -20.2], [0.18, -18.9], [0.19, -17.6], [0.20, -16.4], [0.21, -15.2], [0.22, -14.0], [0.23, -12.9], [0.24, -11.8],
  [0.25, -10.8], [0.26, -9.8], [0.27, -8.84], [0.28, -7.92], [0.29, -7.04], [0.30, -6.2], [0.31, -5.4], [0.32, -4.64],
  [0.33, -3.92], [0.34, -3.24], [0.35, -2.6], [0.36, -2.0], [0.37, -1.44], [0.38, -0.92], [0.39, -0.44], [0.40, 0.0],
  [0.41, 0.4], [0.42, 0.8], [0.43, 1.2], [0.44, 1.6], [0.45, 2.0], [0.46, 2.4], [0.47, 2.8], [0.48, 3.2],
  [0.49, 3.6], [0.50, 4.0], [0.51, 4.4], [0.52, 4.8], [0.53, 5.2], [0.54, 5.6], [0.55, 6.0], [0.56, 6.4],
  [0.57, 6.8], [0.58, 7.2], [0.59, 7.6], [0.60, 8.0], [0.61, 8.4], [0.62, 8.8], [0.63, 9.2], [0.64, 9.6],
  [0.65, 10.0], [0.66, 10.4], [0.67, 10.8], [0.68, 11.2], [0.69, 11.6], [0.70, 12.0], [0.71, 12.4], [0.72, 12.8],
  [0.73, 13.2], [0.74, 13.6], [0.75, 14.0], [0.76, 14.4], [0.77, 14.8], [0.78, 15.2], [0.79, 15.6], [0.80, 16.0],
  [0.81, 16.4], [0.82, 16.8], [0.83, 17.2], [0.84, 17.6], [0.85, 18.0], [0.86, 18.4], [0.87, 18.8], [0.88, 19.2],
  [0.89, 19.6], [0.90, 20.0], [0.91, 20.4], [0.92, 20.8], [0.93, 21.2], [0.94, 21.6], [0.95, 22.0], [0.96, 22.4],
  [0.97, 22.8], [0.98, 23.2], [0.99, 23.6], [1.00, 24.0],
];

export const MAX_DB = 24;

export function rawToDb(raw: number): number {
  if (raw <= 0) return -Infinity;
  if (raw <= GAIN_TABLE[0][0]) return GAIN_TABLE[0][1];
  for (let i = 1; i < GAIN_TABLE.length; i++) {
    const [r1, d1] = GAIN_TABLE[i];
    if (raw <= r1) {
      const [r0, d0] = GAIN_TABLE[i - 1];
      return d0 + ((raw - r0) / (r1 - r0)) * (d1 - d0);
    }
  }
  return MAX_DB;
}

/** `clamped` means Live's gain can't go that far. The bottom stops at the lowest step, so a clip is never muted. */
export function dbToRaw(db: number): { raw: number; clamped: boolean } {
  if (db > MAX_DB) return { raw: 1, clamped: true };
  if (db < GAIN_TABLE[0][1]) return { raw: GAIN_TABLE[0][0], clamped: true };
  for (let i = 1; i < GAIN_TABLE.length; i++) {
    const [r1, d1] = GAIN_TABLE[i];
    if (db <= d1) {
      const [r0, d0] = GAIN_TABLE[i - 1];
      return { raw: r0 + ((db - d0) / (d1 - d0)) * (r1 - r0), clamped: false };
    }
  }
  return { raw: 1, clamped: false };
}
