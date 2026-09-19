/**
 * Credential shapes the suites need that `mintToken()` deliberately cannot mint: a well-formed
 * credential carrying a real token id with a *different* secret, so a test reaches the store's
 * constant-time comparison rather than stopping at the CRC.
 */
import {
  crc6,
  DISPLAY_PREFIX_LENGTH,
  TOKEN_CRC_LENGTH,
  TOKEN_SECRET_LENGTH,
} from '@iridium/contracts';

/** The same prefix and id as `raw`, a secret of the same length that differs in every position, and a valid CRC. */
export function withOtherSecret(raw: string): string {
  const prefix = raw.slice(0, DISPLAY_PREFIX_LENGTH);
  const secret = raw.slice(DISPLAY_PREFIX_LENGTH, raw.length - TOKEN_CRC_LENGTH);
  const other = Array.from(secret, (character) => (character === 'A' ? 'B' : 'A')).join('');
  if (other.length !== TOKEN_SECRET_LENGTH) throw new Error('not a credential');
  const body = `${prefix}${other}`;
  return `${body}${crc6(body)}`;
}
