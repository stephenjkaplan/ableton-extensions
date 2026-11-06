// Shapes shared by the measuring, role and plan code. Times are beats unless they say otherwise.
export type ClipKey = string; // `${trackIndex}:${slotIndex}`

export interface WarpMarker { beatTime: number; sampleTime: number } // sampleTime is seconds

export interface SessionClip {
  key: ClipKey;
  trackIndex: number;
  slotIndex: number;
  trackName: string;
  name: string;
  filePath: string;
  rawGain: number;
  warping: boolean;
  loopStart: number;
  loopEnd: number;
  warpMarkers: WarpMarker[];
}

export interface ArrangementClip { filePath: string; start: number; end: number }

export interface LiveScan {
  setPath: string;
  session: SessionClip[];
  arrangement: ArrangementClip[];
}

/** File level, before clip gain. Null means it couldn't be read. */
export interface Measure { loudestLufs: number | null; peakDb: number | null }
