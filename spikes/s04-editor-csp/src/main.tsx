/**
 * Spike S04 — the harness page. One artefact, three hosts.
 *
 * The same built bundle is served by the Vitest Browser Mode host (strict CSP header from a Vite
 * middleware), by the `@fastify/helmet` `enableCSPNonces` host, and by the Electron shell through
 * the product's own `app://iridium` `protocol.handle`. The page mounts everything the register's
 * pass criterion names, records every `securitypolicyviolation` event per phase, and publishes a
 * JSON report on `window.s04.report`.
 */

// Must be first: the collector has to be listening before any other module runs. `oxfmt-ignore`
// holds it there — the import sorter would otherwise move every relative import below the packages,
// and a violation raised while a package evaluates would go unrecorded.
// oxfmt-ignore
import { getViolations, setPhase, type ViolationRecord } from './collector.ts';

import { Autocomplete } from '@base-ui/react/autocomplete';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { Select } from '@base-ui/react/select';
import { Tooltip } from '@base-ui/react/tooltip';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, Prec } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import rehypeHighlight from 'rehype-highlight';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { yCollab, yRemoteSelectionsTheme, yUndoManagerKeymap } from 'y-codemirror.next';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
// eslint-disable-next-line no-restricted-imports -- throwaway spike harness, not product code: A14 routes `yjs` through `@iridium/crdt` in `packages/*/src`, and this is the shape `@iridium/editor` adopts, where the import moves behind that package.
import * as Y from 'yjs';

import { iridiumRemoteSelections } from './remote-selections.ts';

const NONCE = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? '';

const SAMPLE_MARKDOWN = [
  '# S04 harness',
  '',
  'A paragraph with `inline code`, **bold** and a [link](https://example.invalid).',
  '',
  '```ts',
  'export function collide(a: number, b: number): number {',
  '  return a + b; // highlighted by rehype-highlight',
  '}',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
].join('\n');

// -------------------------------------------------------------------------------------------
// Yjs: two in-memory documents wired to each other, as two clients of one note.
// -------------------------------------------------------------------------------------------
const docLocal = new Y.Doc();
const docRemote = new Y.Doc();
const textLocal = docLocal.getText('note');
const textRemote = docRemote.getText('note');

docLocal.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin !== 'relay') Y.applyUpdate(docRemote, update, 'relay');
});
docRemote.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin !== 'relay') Y.applyUpdate(docLocal, update, 'relay');
});

const awarenessLocal = new Awareness(docLocal);
const awarenessRemote = new Awareness(docRemote);
awarenessLocal.setLocalStateField('user', {
  name: 'Local',
  color: '#30bced',
  colorLight: '#30bced33',
});

function relayRemoteAwareness(): void {
  const update = encodeAwarenessUpdate(awarenessRemote, [awarenessRemote.clientID]);
  applyAwarenessUpdate(awarenessLocal, update, 'relay');
}

textLocal.insert(0, SAMPLE_MARKDOWN);

// -------------------------------------------------------------------------------------------
// The editor. `EditorView.cspNonce` is the facet under test.
// -------------------------------------------------------------------------------------------
const undoManager = new Y.UndoManager(textLocal);

/** A theme that is unique to this harness, so CodeMirror must generate and mount a fresh
 *  `StyleModule` — this is the `<style>` element the nonce has to reach. */
const iridiumTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, monospace', caretColor: '#7cc5ff' },
    '.cm-gutters': { backgroundColor: '#17171a', color: '#6b6b74', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#1d1d21' },
  },
  { dark: true },
);

let view: EditorView | null = null;

function mountEditor(parent: HTMLElement): EditorView {
  const state = EditorState.create({
    doc: textLocal.toJSON(),
    extensions: [
      EditorView.cspNonce.of(NONCE),
      Prec.high(keymap.of(yUndoManagerKeymap)),
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      highlightSelectionMatches(),
      search(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown(),
      yCollab(textLocal, awarenessLocal, { undoManager }),
      keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
      iridiumTheme,
    ],
  });
  return new EditorView({ state, parent });
}

// -------------------------------------------------------------------------------------------
// The Markdown preview: remark -> rehype -> rehype-highlight -> React, never an HTML string.
// -------------------------------------------------------------------------------------------
const processor = unified().use(remarkParse).use(remarkRehype).use(rehypeHighlight);

function Preview(): React.ReactNode {
  const tree = processor.runSync(processor.parse(SAMPLE_MARKDOWN));
  return toJsxRuntime(tree, { Fragment, jsx, jsxs });
}

// -------------------------------------------------------------------------------------------
// Base UI: a popover, a tooltip and a command palette (dialog + autocomplete).
// -------------------------------------------------------------------------------------------
const COMMANDS = [
  'Toggle bold',
  'Toggle italic',
  'Insert table',
  'Open note',
  'Rename note',
  'Move note',
];

/** `Select.Root` takes `{ label, value }` pairs (or a record); `Autocomplete.Root` takes the list. */
const COMMAND_ITEMS = COMMANDS.map((value) => ({ label: value, value }));

function Harness(): React.ReactElement {
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteListOpen, setPaletteListOpen] = React.useState(false);
  const [selectOpen, setSelectOpen] = React.useState(false);

  React.useEffect(() => {
    if (editorRef.current !== null && view === null) view = mountEditor(editorRef.current);
  }, []);

  React.useEffect(() => {
    window.s04.setTooltip = setTooltipOpen;
    window.s04.setPalette = setPaletteOpen;
    window.s04.setPaletteList = setPaletteListOpen;
    window.s04.setSelect = setSelectOpen;
  }, []);

  return (
    <CSPProvider nonce={NONCE}>
      <div className="s04-bar">
        <Popover.Root>
          <Popover.Trigger data-testid="popover-trigger">Popover</Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={8} data-testid="popover-positioner">
              <Popover.Popup className="s04-popup" data-testid="popover-popup">
                <Popover.Title>Share</Popover.Title>
                <Popover.Description>Positioned by Base UI through the CSSOM.</Popover.Description>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>

        <Tooltip.Provider>
          <Tooltip.Root open={tooltipOpen} onOpenChange={setTooltipOpen}>
            <Tooltip.Trigger data-testid="tooltip-trigger">Tooltip</Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Positioner sideOffset={8} data-testid="tooltip-positioner">
                <Tooltip.Popup className="s04-popup" data-testid="tooltip-popup">
                  Saved 2 seconds ago
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>

        <Select.Root open={selectOpen} onOpenChange={setSelectOpen} items={COMMAND_ITEMS}>
          <Select.Trigger data-testid="select-trigger">
            <Select.Value />
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner sideOffset={8} data-testid="select-positioner">
              <Select.Popup className="s04-popup" data-testid="select-popup">
                <Select.List>
                  {COMMANDS.map((item) => (
                    <Select.Item key={item} value={item}>
                      <Select.ItemText>{item}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>

        <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
          <Dialog.Portal>
            <Dialog.Backdrop className="s04-backdrop" />
            <Dialog.Popup className="s04-palette" data-testid="palette-popup">
              <Dialog.Title>Command palette</Dialog.Title>
              <Autocomplete.Root
                items={COMMANDS}
                open={paletteListOpen}
                onOpenChange={setPaletteListOpen}
                openOnInputClick
              >
                <Autocomplete.Input data-testid="palette-input" placeholder="Type a command" />
                <Autocomplete.Portal>
                  <Autocomplete.Positioner sideOffset={4} data-testid="palette-positioner">
                    <Autocomplete.Popup className="s04-popup" data-testid="palette-list">
                      <Autocomplete.Empty>No command</Autocomplete.Empty>
                      <Autocomplete.List>
                        {(item: string) => (
                          <Autocomplete.Item key={item} value={item}>
                            {item}
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.List>
                    </Autocomplete.Popup>
                  </Autocomplete.Positioner>
                </Autocomplete.Portal>
              </Autocomplete.Root>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <div className="s04-editor" ref={editorRef} data-testid="editor" />
      <div className="s04-preview" data-testid="preview">
        <Preview />
      </div>
    </CSPProvider>
  );
}

// -------------------------------------------------------------------------------------------
// The run.
// -------------------------------------------------------------------------------------------
/** The only global the page exposes; every host drives the run through it. */
export interface S04Bridge {
  /** Set by the page when the editor is mounted and focused and the host may type. */
  awaitInput: boolean;
  /** Set by the host when it has finished typing. */
  inputDone: boolean;
  /** Set by the page when every phase has run. */
  report?: Record<string, unknown>;
  setTooltip?: (open: boolean) => void;
  setPalette?: (open: boolean) => void;
  setPaletteList?: (open: boolean) => void;
  setSelect?: (open: boolean) => void;
}

declare global {
  interface Window {
    s04: S04Bridge;
  }
}

window.s04 = { awaitInput: false, inputDone: false };

const raf = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function styleElementReport(): unknown[] {
  return [...document.querySelectorAll('style')].map((element) => ({
    // `nonce` is hidden from `getAttribute` by Chromium; the IDL attribute is the readable one.
    hasNonce: element.nonce !== '',
    nonceMatches: element.nonce === NONCE,
    ruleCount: (() => {
      try {
        return element.sheet?.cssRules.length ?? -1;
      } catch {
        return -2;
      }
    })(),
    firstRule: (() => {
      try {
        return element.sheet?.cssRules[0]?.cssText.slice(0, 80) ?? '';
      } catch {
        return '';
      }
    })(),
  }));
}

/**
 * A field-by-field copy of one record. The collector hands back its live array, and the report is
 * serialised to JSON long after the phase that produced it, so every slice of it is snapshotted into
 * plain objects that cannot alias the collector's state.
 */
function copyViolation(v: ViolationRecord): ViolationRecord {
  return {
    effectiveDirective: v.effectiveDirective,
    violatedDirective: v.violatedDirective,
    blockedURI: v.blockedURI,
    disposition: v.disposition,
    sourceFile: v.sourceFile,
    lineNumber: v.lineNumber,
    columnNumber: v.columnNumber,
    sample: v.sample,
    originalPolicy: v.originalPolicy,
    phase: v.phase,
  };
}

function inlineStyleAttributeReport(): unknown[] {
  const out: unknown[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('[style]')) {
    out.push({
      selector: `${element.tagName.toLowerCase()}.${element.className.split(' ').join('.')}`,
      styleAttribute: element.getAttribute('style')?.slice(0, 120) ?? '',
      inlineDeclarationCount: element.style.length,
    });
  }
  return out;
}

async function run(): Promise<void> {
  const report: Record<string, unknown> = {
    nonce: { present: NONCE !== '', length: NONCE.length },
    userAgent: navigator.userAgent,
  };

  setPhase('mount');
  const container = document.getElementById('root');
  if (container === null) throw new Error('no #root');
  createRoot(container).render(<Harness />);
  await raf();
  await wait(120);
  await raf();

  // ---- typing -------------------------------------------------------------------------------
  setPhase('type');
  view?.focus();
  window.s04.awaitInput = true;
  const deadline = Date.now() + 8000;
  // oxlint-disable-next-line no-await-in-loop -- polls until the host sets `inputDone`.
  while (!window.s04.inputDone && Date.now() < deadline) await wait(50);
  window.s04.awaitInput = false;
  report.externalInputObserved = window.s04.inputDone;

  // Programmatic edits as well, so the phase is meaningful even without a driving host.
  for (let i = 0; i < 12; i += 1) {
    view?.dispatch({ changes: { from: 0, insert: `programmatic line ${i}\n` } });
    // oxlint-disable-next-line no-await-in-loop -- yields a frame so CodeMirror measures.
    if (i % 4 === 0) await raf();
  }
  await raf();
  report.docLength = textLocal.length;
  report.remoteDocLength = textRemote.length;
  report.docsConverged = textLocal.toJSON() === textRemote.toJSON();

  // ---- remote cursor ------------------------------------------------------------------------
  setPhase('remote-cursor');
  awarenessRemote.setLocalStateField('user', {
    name: 'Remote',
    color: '#ee6352',
    colorLight: '#ee635233',
  });
  awarenessRemote.setLocalStateField('cursor', {
    anchor: Y.createRelativePositionFromTypeIndex(textRemote, 4),
    head: Y.createRelativePositionFromTypeIndex(textRemote, 30),
  });
  relayRemoteAwareness();
  await raf();
  await wait(80);
  await raf();

  const caret = document.querySelector<HTMLElement>('.cm-ySelectionCaret');
  const selectionMark = document.querySelector<HTMLElement>('.cm-ySelection');
  report.remoteCursor = {
    caretRendered: caret !== null,
    selectionMarkRendered: selectionMark !== null,
    // What the register actually cares about: did the colour survive the policy?
    caretStyleAttribute: caret?.getAttribute('style') ?? null,
    caretInlineDeclarationCount: caret?.style.length ?? -1,
    caretComputedBackground: caret === null ? null : getComputedStyle(caret).backgroundColor,
    caretComputedBorderLeft: caret === null ? null : getComputedStyle(caret).borderLeftColor,
    selectionMarkStyleAttribute: selectionMark?.getAttribute('style') ?? null,
    selectionMarkInlineDeclarationCount: selectionMark?.style.length ?? -1,
    selectionMarkComputedBackground:
      selectionMark === null ? null : getComputedStyle(selectionMark).backgroundColor,
    awarenessStates: awarenessLocal.getStates().size,
  };

  // ---- preview ------------------------------------------------------------------------------
  setPhase('preview');
  await raf();
  const preview = document.querySelector('[data-testid="preview"]');
  report.preview = {
    hljsSpans: preview?.querySelectorAll('code.hljs span[class^="hljs-"]').length ?? 0,
    codeBlocks: preview?.querySelectorAll('pre code').length ?? 0,
    elementsWithStyleAttribute: preview?.querySelectorAll('[style]').length ?? -1,
    highlightColourApplied: (() => {
      const token = preview?.querySelector('span.hljs-keyword');
      return token === null || token === undefined ? null : getComputedStyle(token).color;
    })(),
  };

  // ---- popover ------------------------------------------------------------------------------
  setPhase('popover');
  document.querySelector<HTMLElement>('[data-testid="popover-trigger"]')?.click();
  await raf();
  await wait(120);
  await raf();
  const popoverPositioner = document.querySelector<HTMLElement>(
    '[data-testid="popover-positioner"]',
  );
  const popoverPopup = document.querySelector<HTMLElement>('[data-testid="popover-popup"]');
  report.popover = {
    opened: popoverPopup !== null,
    positionerStyleAttribute: popoverPositioner?.getAttribute('style')?.slice(0, 200) ?? null,
    positionerInlineDeclarationCount: popoverPositioner?.style.length ?? -1,
    rect: popoverPopup === null ? null : rect(popoverPopup),
    positioned:
      popoverPositioner !== null &&
      getComputedStyle(popoverPositioner).position !== 'static' &&
      rect(popoverPositioner).width > 0,
  };

  // ---- tooltip ------------------------------------------------------------------------------
  setPhase('tooltip');
  window.s04.setTooltip?.(true);
  await raf();
  await wait(150);
  await raf();
  const tooltipPositioner = document.querySelector<HTMLElement>(
    '[data-testid="tooltip-positioner"]',
  );
  const tooltipPopup = document.querySelector<HTMLElement>('[data-testid="tooltip-popup"]');
  report.tooltip = {
    opened: tooltipPopup !== null,
    positionerInlineDeclarationCount: tooltipPositioner?.style.length ?? -1,
    rect: tooltipPopup === null ? null : rect(tooltipPopup),
  };

  // ---- command palette ----------------------------------------------------------------------
  setPhase('palette');
  window.s04.setPalette?.(true);
  await raf();
  await wait(150);
  await raf();
  const paletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]');
  paletteInput?.focus();
  paletteInput?.click();
  window.s04.setPaletteList?.(true);
  await raf();
  await wait(250);
  await raf();
  const paletteList = document.querySelector<HTMLElement>('[data-testid="palette-list"]');
  const palettePositioner = document.querySelector<HTMLElement>(
    '[data-testid="palette-positioner"]',
  );
  report.palette = {
    dialogOpened: document.querySelector('[data-testid="palette-popup"]') !== null,
    listOpened: paletteList !== null,
    items: paletteList?.querySelectorAll('[role="option"]').length ?? 0,
    positionerInlineDeclarationCount: palettePositioner?.style.length ?? -1,
    rect: paletteList === null ? null : rect(paletteList),
  };

  // ---- select (the one Base UI part that injects its own <style>) -----------------------------
  setPhase('select');
  window.s04.setSelect?.(true);
  await raf();
  await wait(250);
  await raf();
  const selectPopup = document.querySelector<HTMLElement>('[data-testid="select-popup"]');
  const selectPositioner = document.querySelector<HTMLElement>('[data-testid="select-positioner"]');
  report.select = {
    opened: selectPopup !== null,
    items: selectPopup?.querySelectorAll('[role="option"]').length ?? 0,
    positionerInlineDeclarationCount: selectPositioner?.style.length ?? -1,
    rect: selectPopup === null ? null : rect(selectPopup),
    // Base UI injects `styleDisableScrollbar` as a React 19 hoisted <style nonce={...}> taken from
    // `CSPProvider`; this is the element the nonce has to reach on the Base UI side.
    baseUiStyleElement: (() => {
      const element = [...document.querySelectorAll('style')].find((candidate) =>
        candidate.textContent?.includes('base-ui-disable-scrollbar'),
      );
      return element === undefined
        ? null
        : {
            hasNonce: element.nonce !== '',
            nonceMatches: element.nonce === NONCE,
            applied: element.sheet !== null,
          };
    })(),
  };

  // ---- measurements -------------------------------------------------------------------------
  setPhase('measure');
  const content = document.querySelector<HTMLElement>('.cm-content');
  const gutters = document.querySelector<HTMLElement>('.cm-gutters');
  report.editorStyling = {
    mounted: content !== null,
    // From CodeMirror's own baseTheme: proof the generated <style> was accepted, not just present.
    contentWhiteSpace: content === null ? null : getComputedStyle(content).whiteSpace,
    // From `iridiumTheme`: proof the *application's* generated theme was accepted.
    contentFontFamily: content === null ? null : getComputedStyle(content).fontFamily,
    guttersBackground: gutters === null ? null : getComputedStyle(gutters).backgroundColor,
    caretColor: content === null ? null : getComputedStyle(content).caretColor,
  };
  report.styleElements = styleElementReport();
  report.styleSheetCount = document.styleSheets.length;
  report.inlineStyleAttributes = inlineStyleAttributeReport();

  const measured: ViolationRecord[] = getViolations().map(copyViolation);
  report.violations = measured;
  report.violationCount = measured.length;

  // ---- remedy -------------------------------------------------------------------------------
  // The same stack with upstream's remote selections switched off and Iridium's own
  // CSSOM-only replacement in their place. This is the fallback this spike executes, measured in
  // the same document and under the same policy as the failure above.
  setPhase('remedy');
  const remedyHost = document.createElement('div');
  remedyHost.className = 's04-editor';
  remedyHost.style.height = '260px';
  document.body.append(remedyHost);
  const remedyView = new EditorView({
    state: EditorState.create({
      doc: textLocal.toJSON(),
      extensions: [
        EditorView.cspNonce.of(NONCE),
        lineNumbers(),
        drawSelection(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown(),
        // `null` awareness: sync only, so upstream's `yRemoteSelections` is never installed.
        yCollab(textLocal, null, { undoManager: false }),
        yRemoteSelectionsTheme,
        iridiumRemoteSelections(textLocal, awarenessLocal),
        iridiumTheme,
      ],
    }),
    parent: remedyHost,
  });
  // Re-publish the remote cursor so the freshly mounted plugin renders it.
  awarenessRemote.setLocalStateField('cursor', {
    anchor: Y.createRelativePositionFromTypeIndex(textRemote, 6),
    head: Y.createRelativePositionFromTypeIndex(textRemote, 32),
  });
  relayRemoteAwareness();
  await raf();
  await wait(150);
  await raf();
  const remedyCaret = remedyHost.querySelector<HTMLElement>('.cm-ySelectionCaret');
  const remedyMark = remedyHost.querySelector<HTMLElement>('.cm-ySelection');
  report.remedy = {
    caretRendered: remedyCaret !== null,
    selectionMarkRendered: remedyMark !== null,
    caretHasStyleAttribute: remedyCaret?.hasAttribute('style') ?? null,
    caretInlineDeclarationCount: remedyCaret?.style.length ?? -1,
    caretComputedBackground:
      remedyCaret === null ? null : getComputedStyle(remedyCaret).backgroundColor,
    caretComputedBorderLeft:
      remedyCaret === null ? null : getComputedStyle(remedyCaret).borderLeftColor,
    selectionMarkComputedBackground:
      remedyMark === null ? null : getComputedStyle(remedyMark).backgroundColor,
    violations: getViolations()
      .filter((v) => v.phase === 'remedy')
      .map(copyViolation),
  };
  remedyView.destroy();
  remedyHost.remove();

  // ---- facet control ------------------------------------------------------------------------
  // Does `EditorView.cspNonce` carry the result, or would the policy have accepted CodeMirror's
  // <style> anyway? Two identical editors in two same-origin `about:blank` iframes, which inherit
  // this document's policy and give `style-mod` a fresh `Document` root each. (`style-mod` keys its
  // style element by root, and only creates a `<style>` element when the root has a `head`: in a
  // ShadowRoot it uses `adoptedStyleSheets`, which CSP does not govern at all.)
  const facetReport = (
    withNonce: boolean,
  ): { out: Record<string, unknown>; finish: () => Record<string, unknown> } => {
    const frame = document.createElement('iframe');
    frame.width = '320';
    frame.height = '120';
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    if (frameDocument === null || frameWindow === null) throw new Error('no frame document');
    const frameViolations: unknown[] = [];
    frameWindow.addEventListener(
      'securitypolicyviolation',
      (e) => {
        frameViolations.push({
          effectiveDirective: e.effectiveDirective,
          blockedURI: e.blockedURI,
        });
      },
      true,
    );
    const host = frameDocument.createElement('div');
    frameDocument.body.append(host);
    const editor = new EditorView({
      state: EditorState.create({
        doc: 'facet control',
        extensions: withNonce
          ? [EditorView.cspNonce.of(NONCE), lineNumbers(), iridiumTheme]
          : [lineNumbers(), iridiumTheme],
      }),
      parent: host,
      root: frameDocument,
    });
    const styles = [...frameDocument.querySelectorAll('style')];
    const frameContent = frameDocument.querySelector('.cm-content');
    const out = {
      styleElements: styles.length,
      hasNonce: styles.map((element) => element.nonce !== ''),
      // A refused <style> element parses to no sheet at all.
      sheetsApplied: styles.map((element) => element.sheet !== null),
      ruleCounts: styles.map((element) => {
        try {
          return element.sheet?.cssRules.length ?? -1;
        } catch {
          return -2;
        }
      }),
      contentFontFamily:
        frameContent === null ? null : frameWindow.getComputedStyle(frameContent).fontFamily,
      violations: frameViolations,
    };
    return {
      out,
      // Violation events are queued, so the frame has to survive one turn before they are counted.
      finish: () => {
        editor.destroy();
        frame.remove();
        return out;
      },
    };
  };
  setPhase('facet-with-nonce');
  const facetWithNonce = facetReport(true);
  await wait(120);
  setPhase('facet-without-nonce');
  const facetWithoutNonce = facetReport(false);
  await wait(120);
  report.facetControl = {
    withNonce: facetWithNonce.finish(),
    withoutNonce: facetWithoutNonce.finish(),
  };

  // ---- control ------------------------------------------------------------------------------
  // Deliberately mount a style element without the nonce. A zero-violation result above is only
  // evidence if the policy is proven to be enforcing in this document.
  setPhase('control');
  const control = document.createElement('style');
  control.textContent = '.s04-control{color:#ff00ff}';
  document.head.append(control);
  const controlAttr = document.createElement('div');
  controlAttr.setAttribute('style', 'color: rgb(1, 2, 3)');
  document.body.append(controlAttr);
  await raf();
  await wait(120);
  const controlViolations = getViolations()
    .filter((v) => v.phase === 'control')
    .map(copyViolation);
  report.control = {
    violations: controlViolations,
    styleElementBlocked: control.sheet === null,
    styleAttributeBlocked: getComputedStyle(controlAttr).color !== 'rgb(1, 2, 3)',
    enforcing: controlViolations.length > 0,
  };
  control.remove();
  controlAttr.remove();
  // The exact policy string this document received, straight from the violation event — the only
  // way a page can read back the header it was served with.
  report.observedPolicy =
    getViolations().find((v) => v.originalPolicy !== '')?.originalPolicy ?? null;

  window.s04.report = report;
}

/** A named shape rather than a record, so `noUncheckedIndexedAccess` does not make `width` optional. */
interface MeasuredRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rect(element: Element): MeasuredRect {
  const r = element.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

run().catch((error: unknown) => {
  window.s04.report = {
    failed: true,
    error:
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error),
    violations: getViolations(),
  };
});
