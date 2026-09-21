/** Stable authenticated identity used for cursors and budgets, never as a metrics label. */
import type { Principal } from '@iridium/contracts';

/** The rate-limit and cursor binding key of 09 section 1.8. */
export function principalKeyOf(principal: Principal): string | null {
  if (principal.kind === 'user') return `ses:${principal.sessionId}`;
  if (principal.kind === 'token')
    return `${principal.tokenKind === 'pat' ? 'pat' : 'oat'}:${principal.tokenId}`;
  return null;
}
