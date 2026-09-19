import { LIMITS } from '@iridium/contracts';

/** Thrown when the normalised text exceeds the hard cap (`NOTE_HARD_MAX_UTF16`). */
export class NoteOversizedError extends Error {
  readonly code = 'notes.oversized';
  readonly sizeChars: number;
  readonly max: number;

  constructor(sizeChars: number) {
    super(
      `the note text is ${String(sizeChars)} UTF-16 units, above the hard cap of ` +
        `${String(LIMITS.NOTE_HARD_MAX_UTF16)}; split it before creating or importing it.`,
    );
    this.name = 'NoteOversizedError';
    this.sizeChars = sizeChars;
    this.max = LIMITS.NOTE_HARD_MAX_UTF16;
  }
}
