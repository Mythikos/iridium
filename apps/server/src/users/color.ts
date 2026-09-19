/**
 * `users.color_hue` (03-data-model.md §3, the column table).
 *
 * The presence colour is assigned once at creation as `(ordinal × 137.508) mod 360`, where `ordinal`
 * is the number of users that already exist. The golden angle is what makes consecutive users
 * visually distinct without a palette to run out of, and deriving the hue from a *counter* rather
 * than from the id is what makes the first five users of a fixture five obviously different colours
 * instead of five arbitrary ones.
 *
 * Clients derive every presence colour from this value through the `participants` message and never
 * from awareness (A25/F6), so the hue is server-assigned data and not a preference.
 */

/** The golden angle in degrees: the rotation that spreads a sequence of hues most evenly. */
const GOLDEN_ANGLE_DEGREES = 137.508;

/** Degrees in a full turn — the modulus of the hue wheel, not a product cap. */
const HUE_WHEEL_DEGREES = 360;

/** The hue the next user takes, given how many users already exist. */
export function colorHueForOrdinal(ordinal: number): number {
  return Math.round((ordinal * GOLDEN_ANGLE_DEGREES) % HUE_WHEEL_DEGREES);
}
