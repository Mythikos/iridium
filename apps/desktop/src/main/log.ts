/**
 * Main-process logging (07-client-applications.md §7.4, hardening row H21).
 *
 * `electron-log` with redaction: note content, tokens and cookies are never logged. At M0 the only
 * thing that could leak is a credential-shaped string, so the hook below removes anything matching
 * the published credential format (`irid_<kind>_<id16><secret43><crc6>`, `@iridium/contracts`
 * `tokens.ts`) and the `Authorization`/`Cookie` header values. M5 replaces the pattern list with the
 * server's shared redaction list once `desktop.log-redaction.spec` exists to hold it honest.
 */
import log from 'electron-log/main';

/** The published scanner shape of every Iridium credential. */
const CREDENTIAL = /irid_[a-z]{3}_[A-Za-z0-9_-]{16,}/g;
const HEADER_SECRET = /\b(authorization|cookie|set-cookie)\b(\s*[:=]\s*)(\S+)/gi;

export function redact(value: string): string {
  return value
    .replaceAll(CREDENTIAL, 'irid_[redacted]')
    .replaceAll(HEADER_SECRET, '$1$2[redacted]');
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) {
    const copy = new Error(redact(value.message));
    copy.name = value.name;
    return copy;
  }
  return value;
}

let initialized = false;

export function initializeLogging(): void {
  if (initialized) return;
  initialized = true;
  log.initialize();
  log.hooks.push((message) => ({ ...message, data: message.data.map(redactUnknown) }));
}

export { log };
