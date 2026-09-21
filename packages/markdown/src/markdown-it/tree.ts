/** Converts syntax tokens directly to mdast; raw Markdown is never serialized or rewritten. */
import type { Env, Token, TokenEngine as MarkdownIt } from 'markdown-it/parser';
import type { Nodes, Parents, PhrasingContent, Root, RootContent, Table, TableRow } from 'mdast';

import { lineOf, lineStartsOf } from '../body-text.ts';
import { identifier as labelIdentifier } from './footnotes.ts';
import { inlineOffsets, tokenSpan, type TokenSpan } from './positions.ts';
import { splitTableRow } from './tables.ts';

type Position = NonNullable<Root['position']>;

/** An unsupported upstream token is an adapter defect, never silently discarded source. */
export class MarkdownTokenError extends Error {
  constructor(type: string) {
    super(`Unsupported Markdown syntax token: ${type}`);
    this.name = 'MarkdownTokenError';
  }
}

function children(parent: Parents): Nodes[] {
  return parent.children;
}

function attribute(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null ? null : String(value);
}

function tokenLabel(token: Token): string {
  const label = token.meta?.label;
  if (label === undefined) return '';
  if (typeof label !== 'string') throw new MarkdownTokenError(`${token.type}: label is not text`);
  return label;
}

function headingDepth(tag: string): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (tag) {
    case 'h1':
      return 1;
    case 'h2':
      return 2;
    case 'h3':
      return 3;
    case 'h4':
      return 4;
    case 'h5':
      return 5;
    case 'h6':
      return 6;
    default:
      throw new MarkdownTokenError(`heading: ${tag}`);
  }
}

class Source {
  readonly starts: Int32Array;
  readonly text: string;

  constructor(text: string) {
    this.text = text;
    this.starts = lineStartsOf(text);
  }

  position(start: number, end: number): Position {
    const startLine = lineOf(this.starts, start);
    const endLine = lineOf(this.starts, end);
    return {
      start: {
        line: startLine,
        column: start - (this.starts[startLine - 1] ?? 0) + 1,
        offset: start,
      },
      end: { line: endLine, column: end - (this.starts[endLine - 1] ?? 0) + 1, offset: end },
    };
  }

  block(token: Token): Position {
    const span = tokenSpan(token);
    if (span !== undefined) return this.position(span.start, span.end);
    const first = token.map?.[0] ?? 0;
    const last = token.map?.[1] ?? first + 1;
    const start = this.starts[first] ?? 0;
    const end = Math.max(start, (this.starts[last] ?? this.text.length + 1) - 1);
    return this.position(start, Math.min(end, this.text.length));
  }

  inline(span: TokenSpan, offsets: Int32Array): Position {
    const start = offsets[span.start] ?? offsets.at(-1) ?? 0;
    const end = span.end > span.start ? (offsets[span.end - 1] ?? start) + 1 : start;
    return this.position(start, end);
  }
}

function referenceFields(
  normalized: unknown,
  raw: string,
  decode: (text: string) => string,
): {
  label: string;
  identifier: string;
  referenceType: 'full' | 'collapsed' | 'shortcut';
} {
  const prefix = raw.startsWith('![') ? 2 : 1;
  let lastOpen = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\\') index += 1;
    else if (raw[index] === '[') lastOpen = index;
  }
  const full = lastOpen >= prefix && raw[lastOpen - 1] === ']';
  const collapsed = lastOpen + 2 === raw.length;
  const label =
    full && !collapsed ? raw.slice(lastOpen + 1, -1) : raw.slice(prefix, full ? lastOpen - 1 : -1);
  return {
    label: decode(label),
    identifier: labelIdentifier(typeof normalized === 'string' ? normalized : label),
    referenceType: full ? (collapsed ? 'collapsed' : 'full') : 'shortcut',
  };
}

function imageAlt(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
      if (token.children !== null) return imageAlt(token.children);
      return ['text', 'text_special', 'html_inline', 'code_inline'].includes(token.type)
        ? token.content
        : '';
    })
    .join('');
}

function inlineTree(
  tokens: readonly Token[],
  offsets: Int32Array,
  source: Source,
  parser: MarkdownIt,
): PhrasingContent[] {
  const root: { children: PhrasingContent[] } = { children: [] };
  const stack: Array<{ children: PhrasingContent[]; position?: Position | undefined }> = [root];
  for (const token of tokens) {
    const rawSpan = tokenSpan(token) ?? { start: 0, end: token.content.length };
    const span = { ...rawSpan };
    if (token.type === 'strong_open') span.start = Math.max(0, span.start - 1);
    if (token.type === 'strong_close') span.end += 1;
    const position = source.inline(span, offsets);
    const parent = stack.at(-1) ?? root;
    if (token.nesting < 0) {
      const closed = stack.pop();
      if (closed?.position !== undefined) closed.position.end = position.end;
      continue;
    }
    if (token.nesting > 0) {
      if (token.type === 'link_open') {
        const link =
          token.meta?.label === undefined
            ? {
                type: 'link' as const,
                title: attribute(token, 'title'),
                url: attribute(token, 'href') ?? '',
                children: [] as PhrasingContent[],
                position,
              }
            : {
                type: 'linkReference' as const,
                children: [] as PhrasingContent[],
                position,
                ...referenceFields(token.meta?.label, '', parser.utils.unescapeAll),
              };
        parent.children.push(link);
        stack.push(link);
      } else {
        const type =
          token.type === 'strong_open'
            ? 'strong'
            : token.type === 'em_open'
              ? 'emphasis'
              : token.type === 's_open'
                ? 'delete'
                : null;
        if (type === null) throw new MarkdownTokenError(token.type);
        const node: Extract<PhrasingContent, { type: 'strong' | 'emphasis' | 'delete' }> = {
          type,
          children: [],
          position,
        };
        parent.children.push(node);
        stack.push(node);
      }
      continue;
    }
    if (token.type === 'text' || token.type === 'text_special' || token.type === 'softbreak') {
      const value = token.type === 'softbreak' ? '\n' : token.content;
      if (value === '') continue;
      const previous = parent.children.at(-1);
      if (previous?.type === 'text') {
        previous.value += value;
        if (previous.position !== undefined) previous.position.end = position.end;
      } else parent.children.push({ type: 'text', value, position });
    } else if (token.type === 'hardbreak') parent.children.push({ type: 'break', position });
    else if (token.type === 'code_inline')
      parent.children.push({
        type: 'inlineCode',
        value: rawSpan.codeValue ?? token.content,
        position,
      });
    else if (token.type === 'html_inline')
      parent.children.push({ type: 'html', value: token.content, position });
    else if (token.type === 'iridium_footnote_ref') {
      const label = tokenLabel(token);
      parent.children.push({
        type: 'footnoteReference',
        identifier: labelIdentifier(label),
        label: parser.utils.unescapeAll(label),
        position,
      });
    } else if (token.type === 'image') {
      const alt = imageAlt(token.children ?? []);
      if (token.meta?.label === undefined)
        parent.children.push({
          type: 'image',
          title: attribute(token, 'title'),
          url: attribute(token, 'src') ?? '',
          alt,
          position,
        });
      else
        parent.children.push({
          type: 'imageReference',
          alt,
          position,
          ...referenceFields(
            token.meta?.label,
            source.text.slice(position.start.offset, position.end.offset),
            parser.utils.unescapeAll,
          ),
        });
    } else throw new MarkdownTokenError(token.type);
  }
  function completeReferences(node: PhrasingContent): void {
    if (node.type === 'linkReference' && node.position !== undefined) {
      const raw = source.text.slice(node.position.start.offset, node.position.end.offset);
      const fields = referenceFields(node.identifier, raw, parser.utils.unescapeAll);
      node.label = fields.label;
      node.referenceType = fields.referenceType;
    }
    if ('children' in node) for (const child of node.children) completeReferences(child);
  }
  for (const node of root.children) completeReferences(node);
  return root.children;
}

/** Pipe boundaries are syntax delimiters even inside inline code unless escaped (GFM). */
function tableCells(source: Source, row: TableRow): Array<[number, number]> {
  const start = row.position?.start.offset ?? 0;
  const end = row.position?.end.offset ?? start;
  return splitTableRow(source.text.slice(start, end)).map(({ from, to }) => [
    start + from,
    start + to,
  ]);
}

function definition(
  token: Token,
  position: Position,
  source: Source,
  env: Env,
  parser: MarkdownIt,
): RootContent {
  const raw = source.text.slice(position.start.offset, position.end.offset);
  const close = raw.indexOf(']:');
  const label = close < 0 ? tokenLabel(token) : raw.slice(1, close);
  const key = tokenLabel(token);
  let offset = close + 2;
  while (/[\t\n\r ]/.test(raw[offset] ?? '') && offset < raw.length) offset += 1;
  const destination = parser.helpers.parseLinkDestination(raw, offset, raw.length);
  let url = env.references?.[key]?.href ?? '';
  let title: string | null = env.references?.[key]?.title || null;
  if (destination.ok) {
    url = destination.str;
    offset = destination.pos;
    while (/[\t\n\r ]/.test(raw[offset] ?? '') && offset < raw.length) offset += 1;
    const parsedTitle = parser.helpers.parseLinkTitle(raw, offset, raw.length);
    title = parsedTitle.ok ? parsedTitle.str : null;
  }
  return {
    type: 'definition',
    identifier: labelIdentifier(label),
    label: parser.utils.unescapeAll(label),
    title,
    url,
    position,
  };
}

function closeContainer(node: Parents, source: Source): void {
  if (node.type === 'paragraph') {
    const first = node.children[0]?.position?.start;
    if (first !== undefined && node.position !== undefined) node.position.start = first;
  }
  if (node.type === 'listItem') {
    const last = node.children.at(-1)?.position;
    if (last !== undefined && node.position !== undefined) node.position.end = last.end;
    node.spread = node.children.some(
      (child, index) =>
        index > 0 &&
        (child.position?.start.line ?? 0) - (node.children[index - 1]?.position?.end.line ?? 0) > 1,
    );
    const paragraph = node.children[0];
    const text = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
    if (paragraph?.type === 'paragraph' && text?.type === 'text') {
      const marker = /^\[([ xX])\][\t ]/.exec(text.value);
      if (marker !== null) {
        node.checked = marker[1]?.toLowerCase() === 'x';
        text.value = text.value.slice(marker[0].length);
        if (text.position !== undefined) {
          const from = (text.position.start.offset ?? 0) + marker[0].length;
          text.position.start = source.position(from, from).start;
          if (text.value !== '' && paragraph.position !== undefined)
            paragraph.position.start = text.position.start;
        }
        if (text.value === '') paragraph.children.shift();
      }
    }
  }
  if (node.type === 'list')
    node.spread = node.children.some(
      (child, index) =>
        index > 0 &&
        (child.position?.start.line ?? 0) - (node.children[index - 1]?.position?.end.line ?? 0) > 1,
    );
}

/** Converts one complete token stream while preserving all source-addressable node types. */
export function tokensToMdast(
  tokens: readonly Token[],
  text: string,
  env: Env,
  parser: MarkdownIt,
): Root {
  const source = new Source(text);
  const root: Root = { type: 'root', children: [], position: source.position(0, text.length) };
  const stack: Parents[] = [root];
  let currentTable: Table | undefined;
  let currentRow: TableRow | undefined;
  let cellRanges: Array<[number, number]> = [];
  let cellIndex = 0;
  let cellBounds: [number, number] | undefined;
  for (const token of tokens) {
    if (
      token.type === 'thead_open' ||
      token.type === 'thead_close' ||
      token.type === 'tbody_open' ||
      token.type === 'tbody_close'
    )
      continue;
    const parent = stack.at(-1) ?? root;
    if (token.nesting < 0) {
      const closing = stack.pop();
      if (closing !== undefined) closeContainer(closing, source);
      continue;
    }
    if (token.type === 'inline') {
      const span = tokenSpan(token);
      const offsets =
        span?.offsets ??
        inlineOffsets(token.content, text, [
          cellBounds ?? [span?.start ?? 0, span?.end ?? text.length],
        ]);
      children(parent).push(...inlineTree(token.children ?? [], offsets, source, parser));
      continue;
    }
    const position = source.block(token);
    let node: RootContent | PhrasingContent | TableRow | Extract<Nodes, { type: 'tableCell' }>;
    switch (token.type) {
      case 'paragraph_open':
        node = { type: 'paragraph', children: [], position };
        break;
      case 'heading_open':
        node = { type: 'heading', depth: headingDepth(token.tag), children: [], position };
        if (token.markup === '=' || token.markup === '-') {
          for (const previous of children(parent).toReversed()) {
            if (
              previous.type !== 'definition' ||
              previous.position === undefined ||
              previous.position.end.line + 1 !== position.start.line
            )
              break;
            position.start = previous.position.start;
          }
        }
        break;
      case 'blockquote_open':
        node = { type: 'blockquote', children: [], position };
        break;
      case 'bullet_list_open':
      case 'ordered_list_open':
        node = {
          type: 'list',
          ordered: token.type === 'ordered_list_open',
          start: token.type === 'ordered_list_open' ? Number(token.attrGet('start') ?? 1) : null,
          spread: false,
          children: [],
          position,
        };
        break;
      case 'list_item_open':
        node = { type: 'listItem', spread: false, checked: null, children: [], position };
        break;
      case 'footnote_reference_open': {
        const label = tokenLabel(token);
        node = {
          type: 'footnoteDefinition',
          identifier: labelIdentifier(label),
          label: parser.utils.unescapeAll(label),
          children: [],
          position,
        };
        break;
      }
      case 'table_open':
        currentTable = { type: 'table', align: [], children: [], position };
        node = currentTable;
        break;
      case 'tr_open':
        currentRow = { type: 'tableRow', children: [], position };
        cellRanges = tableCells(source, currentRow);
        cellIndex = 0;
        node = currentRow;
        break;
      case 'th_open':
      case 'td_open':
        cellBounds = cellRanges[cellIndex++];
        node = {
          type: 'tableCell',
          children: [],
          position: source.position(
            ...(cellBounds ?? [position.start.offset ?? 0, position.end.offset ?? 0]),
          ),
        };
        if (token.type === 'th_open' && currentTable !== undefined) {
          const alignment = /(?:^|:)\s*(left|center|right)\s*$/.exec(
            attribute(token, 'style') ?? '',
          )?.[1];
          currentTable.align?.push(
            alignment === 'left' || alignment === 'center' || alignment === 'right'
              ? alignment
              : null,
          );
        }
        break;
      case 'fence':
      case 'code_block': {
        const info = parser.utils.unescapeAll(token.info).trim();
        const firstSpace = info.search(/\s/);
        node = {
          type: 'code',
          lang: info === '' ? null : firstSpace < 0 ? info : info.slice(0, firstSpace),
          meta: firstSpace < 0 ? null : info.slice(firstSpace).trim() || null,
          value: token.content.replace(/\n$/, ''),
          position,
        };
        break;
      }
      case 'html_block':
        node = {
          type: 'html',
          value:
            position.end.offset === text.length ? token.content : token.content.replace(/\n$/, ''),
          position,
        };
        break;
      case 'iridium_yaml':
        node = { type: 'yaml', value: token.content, position };
        break;
      case 'hr':
        node = { type: 'thematicBreak', position };
        break;
      case 'reference_definition':
        node = definition(token, position, source, env, parser);
        break;
      default:
        throw new MarkdownTokenError(token.type);
    }
    children(parent).push(node);
    if ('children' in node && token.nesting > 0) stack.push(node);
  }
  return root;
}
