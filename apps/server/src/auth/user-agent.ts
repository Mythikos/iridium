/**
 * The recorded form of a `User-Agent` header (03-data-model.md section 3, `sessions.user_agent
 * VARCHAR(255)`; 04-auth-and-access-control.md section 11.1, `context.user_agent` "truncated to
 * 255 bytes").
 *
 * Both columns hold at most 255 bytes of an untrusted header. The value is cut at a UTF-8 boundary
 * so a multi-byte character is dropped whole rather than split, and every writer — the session
 * issuer and the audit context builders — goes through this one function, so the two columns can
 * never disagree about what they keep. Nothing is refused: a longer header is recorded shorter.
 */

/**
 * Bytes of `sessions.user_agent` and of `audit_events.context.user_agent`. A column width, not a
 * product limit: it bounds what the server records from an untrusted header and refuses nothing,
 * which is why it is registered in `limits.single-source.allowlist.json` rather than in `LIMITS`.
 */
const USER_AGENT_MAX_BYTES = 255;

/** The header as the two columns store it: at most 255 UTF-8 bytes, cut on a character boundary. */
export function truncateUserAgent(userAgent: string | undefined | null): string | null {
  if (userAgent === undefined || userAgent === null) return null;
  // Inspect at most the retained prefix plus one code point. An attacker-controlled suffix must
  // not make audit context construction proportional to the header's length, let alone quadratic.
  let bytes = 0;
  let end = 0;
  for (const character of userAgent) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > USER_AGENT_MAX_BYTES) break;
    bytes += width;
    end += character.length;
  }
  return userAgent.slice(0, end);
}
