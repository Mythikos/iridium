/**
 * Spike S04 — the CSP violation collector.
 *
 * Imported first, before any other module, so that every `securitypolicyviolation` event raised
 * while the page boots is recorded. Violations are captured on `window` in the capture phase
 * because the event is fired at the element that owns the blocked resource and bubbles to the
 * document; capturing on `window` sees both element-scoped and document-scoped violations.
 */

export interface ViolationRecord {
  readonly effectiveDirective: string;
  readonly violatedDirective: string;
  readonly blockedURI: string;
  readonly disposition: string;
  readonly sourceFile: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly sample: string;
  readonly originalPolicy: string;
  readonly phase: string;
}

const violations: ViolationRecord[] = [];
let phase = 'boot';

export function setPhase(next: string): void {
  phase = next;
}

export function getViolations(): ViolationRecord[] {
  return violations;
}

window.addEventListener(
  'securitypolicyviolation',
  (e) => {
    violations.push({
      effectiveDirective: e.effectiveDirective,
      violatedDirective: e.violatedDirective,
      blockedURI: e.blockedURI,
      disposition: e.disposition,
      sourceFile: e.sourceFile,
      lineNumber: e.lineNumber,
      columnNumber: e.columnNumber,
      sample: e.sample,
      originalPolicy: e.originalPolicy,
      phase,
    });
  },
  true,
);
