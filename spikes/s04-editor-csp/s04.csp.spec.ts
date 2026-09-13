import { expect, test, vi } from 'vitest';
// Spike S04 — the Vitest Browser Mode (chromium) host.
//
// The harness page is loaded in a same-origin iframe so that the measurement is the page's own
// policy and not the Vitest tester document's (the default tester template injects an inline
// `<style>` reset of its own, which would be indistinguishable noise). Typing is real trusted
// keyboard input: `userEvent.keyboard` drives Playwright's keyboard, which delivers to whatever
// holds focus — the CodeMirror `contenteditable` inside the frame.
/* eslint-disable typescript/no-explicit-any, typescript/no-unsafe-type-assertion -- the report is
   JSON produced by the page under test; asserting on its shape structurally is the whole point. */
import { userEvent } from 'vitest/browser';

const HOST = '/s04/index.html';

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  await vi
    .waitUntil(() => check() || undefined, { timeout: timeoutMs, interval: 50 })
    .catch(() => {
      throw new Error(`timed out waiting for ${label}`);
    });
}

test('S04 — strict style-src with a per-response nonce, Vitest Browser Mode host', async () => {
  // The document must be under the policy this spike is about, and the nonce must be per response.
  const first = await fetch(HOST, { cache: 'no-store' });
  const header = first.headers.get('content-security-policy') ?? '';
  const second = await fetch(HOST, { cache: 'no-store' });
  const secondHeader = second.headers.get('content-security-policy') ?? '';
  expect(header).toContain("style-src 'self' 'nonce-");
  expect(header).not.toContain('unsafe-inline');
  expect(secondHeader).not.toBe(header);

  const frame = document.createElement('iframe');
  frame.width = '1280';
  frame.height = '900';
  frame.src = HOST;
  document.body.append(frame);

  await new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => {
      resolve();
    });
    frame.addEventListener('error', () => {
      reject(new Error('iframe failed to load'));
    });
  });

  const win = frame.contentWindow;
  if (win === null) throw new Error('no contentWindow');

  await waitFor(() => win.s04?.awaitInput ?? false, 60_000, 'the editor to ask for input');

  // Real typed input into the focused CodeMirror instance inside the frame.
  await userEvent.keyboard('typed by the host');
  await userEvent.keyboard('{Enter}');
  await userEvent.keyboard('second line');
  win.s04.inputDone = true;

  await waitFor(() => win.s04.report !== undefined, 120_000, 'the harness report');
  const report = win.s04.report as Record<string, any>;

  await fetch('/s04/__report', {
    method: 'POST',
    body: JSON.stringify({ host: 'vitest-browser-mode', cspHeader: header, report }, null, 2),
  });

  // Evidence that the policy is actually enforcing in this document, not merely declared.
  expect(report.control.enforcing).toBe(true);
  expect(report.control.styleElementBlocked).toBe(true);
  expect(report.control.styleAttributeBlocked).toBe(true);

  // Everything the register's method names actually ran.
  expect(report.nonce.present).toBe(true);
  expect(report.externalInputObserved).toBe(true);
  expect(report.docsConverged).toBe(true);
  expect(report.editorStyling.mounted).toBe(true);
  expect(report.remoteCursor.caretRendered).toBe(true);
  expect(report.popover.opened).toBe(true);
  expect(report.tooltip.opened).toBe(true);
  expect(report.palette.listOpened).toBe(true);
  expect(report.select.opened).toBe(true);
  expect(report.preview.hljsSpans).toBeGreaterThan(0);
  expect(report.preview.elementsWithStyleAttribute).toBe(0);

  // `EditorView.cspNonce` is load-bearing: the same editor without the facet has its generated
  // <style> refused outright (no sheet, no rules, unstyled content).
  expect(report.facetControl.withNonce.sheetsApplied).toEqual([true]);
  expect(report.facetControl.withNonce.violations).toEqual([]);
  expect(report.facetControl.withoutNonce.sheetsApplied).toEqual([false]);
  expect(report.facetControl.withoutNonce.violations.length).toBeGreaterThan(0);

  // CodeMirror's and Base UI's generated <style> elements both carry the page nonce and applied.
  for (const element of report.styleElements) {
    expect(element.nonceMatches).toBe(true);
    expect(element.ruleCount).toBeGreaterThan(0);
  }
  expect(report.select.baseUiStyleElement).toEqual({
    hasNonce: true,
    nonceMatches: true,
    applied: true,
  });

  // The register's pass criterion is NOT met, and this is the exact shape of the failure:
  // one `style-src-attr` refusal, raised while the remote caret is rendered, because
  // `y-codemirror.next` 0.3.6 writes the remote user's colour with
  // `element.setAttribute('style', …)` — an inline style *attribute*, which no nonce can allow.
  // The blocked attribute is still in the DOM but parses to zero declarations, so the remote
  // presence colour is silently lost.
  expect(report.violations.map((v: any) => `${v.effectiveDirective}@${v.phase}`)).toEqual([
    'style-src-attr@remote-cursor',
  ]);
  expect(report.remoteCursor.caretStyleAttribute).toBe(
    'background-color: #ee6352; border-color: #ee6352',
  );
  expect(report.remoteCursor.caretInlineDeclarationCount).toBe(0);
  expect(report.remoteCursor.caretComputedBackground).toBe('rgba(0, 0, 0, 0)');
  // The decoration `style` attributes CodeMirror itself applies are unaffected: `updateAttrs`
  // assigns `dom.style.cssText`, a CSSOM write, which CSP does not govern.
  expect(report.remoteCursor.selectionMarkComputedBackground).toBe('rgba(238, 99, 82, 0.2)');

  // The executed fallback: the same stack with Iridium's own remote-selection plugin in place of
  // upstream's. Zero violations, and the remote colour survives.
  expect(report.remedy.violations).toEqual([]);
  expect(report.remedy.caretComputedBackground).toBe('rgb(238, 99, 82)');
  expect(report.remedy.caretInlineDeclarationCount).toBe(5);
});
