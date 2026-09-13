/**
 * Spike S04 — the remedy under test: Iridium's own remote-selection plugin.
 *
 * `y-codemirror.next` 0.3.6 renders the remote caret with lib0's `dom.element`, which writes the
 * colour through `element.setAttribute('style', …)`. A `style` *content attribute* is governed by
 * `style-src-attr`, and a nonce cannot whitelist an attribute — so under
 * `style-src 'self' 'nonce-…'` the attribute is refused, a `securitypolicyviolation` is raised and
 * the remote user's colour is silently dropped.
 *
 * This module is a drop-in replacement built from the package's own public exports: the same
 * decorations, the same class names, the same `yRemoteSelectionsTheme`, and the same awareness
 * contract (`{ user: { name, color, colorLight }, cursor: { anchor, head } }`) — but every colour
 * is written through the CSSOM (`element.style.backgroundColor = …`), which CSP does not govern,
 * exactly as `@codemirror/view` already applies decoration `style` attributes
 * (`updateAttrs` assigns `dom.style.cssText`, never `setAttribute`).
 *
 * Composition at the call site is `yCollab(ytext, null, { undoManager })` — sync and undo, with
 * upstream's remote selections switched off, which is what passing `null` for the awareness does —
 * plus `yRemoteSelectionsTheme` and `iridiumRemoteSelections(ytext, awareness)`. The awareness is
 * passed in rather than read from `ySyncFacet`, because that facet's config is the one `yCollab`
 * built with a null awareness.
 */
/* eslint-disable typescript/no-explicit-any -- `y-protocols/awareness` ships no usable types for
   the awareness object, and this throwaway harness mirrors upstream's own untyped JavaScript. */
import { Annotation, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
// eslint-disable-next-line no-restricted-imports -- throwaway spike harness, not product code: A14 routes `yjs` through `@iridium/crdt` in `packages/*/src`, and this is the shape `@iridium/editor` adopts, where the import moves behind that package.
import * as Y from 'yjs';

const remoteSelectionsAnnotation = Annotation.define<number[]>();

class IridiumRemoteCaret extends WidgetType {
  readonly color: string;
  readonly name: string;

  // Explicit fields rather than constructor parameter properties: `erasableSyntaxOnly` is on
  // (tooling/tsconfig/base.json), and the product destination of this module compiles under it too.
  constructor(color: string, name: string) {
    super();
    this.color = color;
    this.name = name;
  }

  override eq(other: IridiumRemoteCaret): boolean {
    return other.color === this.color && other.name === this.name;
  }

  override toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'cm-ySelectionCaret';
    // The one line this spike exists for: CSSOM, never `setAttribute('style', …)`.
    caret.style.backgroundColor = this.color;
    caret.style.borderColor = this.color;
    caret.append(document.createTextNode('⁠'));
    const dot = document.createElement('div');
    dot.className = 'cm-ySelectionCaretDot';
    caret.append(dot, document.createTextNode('⁠'));
    const info = document.createElement('div');
    info.className = 'cm-ySelectionInfo';
    info.textContent = this.name;
    caret.append(info, document.createTextNode('⁠'));
    return caret;
  }

  override updateDOM(): boolean {
    return false;
  }

  override get estimatedHeight(): number {
    return -1;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class IridiumRemoteSelections {
  decorations: DecorationSet = Decoration.set([]);
  private readonly listener: () => void;
  private readonly ytext: Y.Text;
  private readonly awareness: any;

  constructor(view: EditorView, ytext: Y.Text, awareness: any) {
    this.ytext = ytext;
    this.awareness = awareness;
    this.listener = () => {
      view.dispatch({ annotations: [remoteSelectionsAnnotation.of([])] });
    };
    this.awareness.on('change', this.listener);
  }

  destroy(): void {
    this.awareness.off('change', this.listener);
    this.awareness.setLocalStateField('cursor', null);
  }

  update(update: ViewUpdate): void {
    const { awareness, ytext } = this;
    const ydoc = ytext.doc;
    if (ydoc === null) return;

    // Publish the local selection, exactly as upstream does.
    if (update.docChanged || update.selectionSet || update.focusChanged) {
      const local = awareness.getLocalState() ?? {};
      const hasFocus = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
      const selection = hasFocus ? update.state.selection.main : null;
      if (selection !== null) {
        awareness.setLocalStateField('cursor', {
          anchor: Y.createRelativePositionFromTypeIndex(ytext, selection.anchor),
          head: Y.createRelativePositionFromTypeIndex(ytext, selection.head),
        });
      } else if (local.cursor != null && hasFocus) {
        awareness.setLocalStateField('cursor', null);
      }
    }

    const decorations: { from: number; to: number; value: Decoration }[] = [];
    awareness.getStates().forEach((state: any, clientId: number) => {
      if (clientId === awareness.doc.clientID) return;
      const cursor = state.cursor;
      if (cursor == null || cursor.anchor == null || cursor.head == null) return;
      const anchor = Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc);
      const head = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
      if (anchor === null || head === null || anchor.type !== ytext || head.type !== ytext) return;

      const { color = '#30bced', name = 'Anonymous' } = state.user ?? {};
      const colorLight = state.user?.colorLight ?? `${color}33`;
      const start = Math.min(anchor.index, head.index);
      const end = Math.max(anchor.index, head.index);
      const startLine = update.view.state.doc.lineAt(start);
      const endLine = update.view.state.doc.lineAt(end);

      // `attributes: { style }` is safe: `@codemirror/view` applies it with `dom.style.cssText`.
      const mark = Decoration.mark({
        attributes: { style: `background-color: ${colorLight}` },
        class: 'cm-ySelection',
      });
      if (startLine.number === endLine.number) {
        decorations.push({ from: start, to: end, value: mark });
      } else {
        decorations.push({ from: start, to: startLine.from + startLine.length, value: mark });
        decorations.push({ from: endLine.from, to: end, value: mark });
        for (let i = startLine.number + 1; i < endLine.number; i += 1) {
          const linePos = update.view.state.doc.line(i).from;
          decorations.push({
            from: linePos,
            to: linePos,
            value: Decoration.line({
              attributes: { style: `background-color: ${colorLight}`, class: 'cm-yLineSelection' },
            }),
          });
        }
      }
      decorations.push({
        from: head.index,
        to: head.index,
        value: Decoration.widget({
          side: head.index - anchor.index > 0 ? -1 : 1,
          block: false,
          widget: new IridiumRemoteCaret(color, name),
        }),
      });
    });
    this.decorations = Decoration.set(decorations, true);
  }
}

export function iridiumRemoteSelections(ytext: Y.Text, awareness: unknown): Extension {
  return ViewPlugin.define((view) => new IridiumRemoteSelections(view, ytext, awareness), {
    decorations: (value) => value.decorations,
  });
}
