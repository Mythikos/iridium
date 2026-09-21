/** The last preview stage is an explicit deny-by-default hast schema (08 §2.8). */
import { defaultSchema, type Schema } from 'hast-util-sanitize';

const ID = /^user-content-[^\s"'<>&]+$/;

/** The exact navigation hints consumed by the future React overrides; no data wildcard. */
export const PREVIEW_DATA_ATTRIBUTES: readonly string[] = Object.freeze([
  'dataLine',
  'dataOffset',
  'dataEndOffset',
  'dataLinkKind',
  'dataNoteId',
  'dataAttachmentId',
  'dataFragment',
  'dataCandidates',
]);

/** Safe tags, attributes, URL schemes and required disabled checkbox properties. */
export const iridiumSanitizeSchema: Schema & {
  tagNames: NonNullable<Schema['tagNames']>;
  attributes: NonNullable<Schema['attributes']>;
} = {
  ...defaultSchema,
  clobberPrefix: '',
  clobber: ['id', 'name', 'ariaDescribedBy', 'ariaLabelledBy'],
  strip: ['script'],
  allowComments: false,
  allowDoctypes: false,
  tagNames: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'input',
    'li',
    'ol',
    'p',
    'pre',
    'section',
    'span',
    'strong',
    'sup',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  attributes: {
    '*': [...PREVIEW_DATA_ATTRIBUTES],
    a: [
      'href',
      'title',
      ['id', ID],
      ['ariaDescribedBy', ID],
      'ariaLabel',
      'dataFootnoteRef',
      'dataFootnoteBackref',
      ['className', 'data-footnote-backref'],
    ],
    img: ['src', 'alt', 'title'],
    input: [['type', 'checkbox'], ['disabled', true], 'checked'],
    code: [['className', /^language-[\w+#.-]{1,32}$/, 'hljs']],
    span: [['className', /^hljs-[\w-]{1,40}$/]],
    h1: [['id', ID]],
    h2: [
      ['id', ID],
      ['className', 'sr-only'],
    ],
    h3: [['id', ID]],
    h4: [['id', ID]],
    h5: [['id', ID]],
    h6: [['id', ID]],
    li: [
      ['id', ID],
      ['className', 'task-list-item'],
    ],
    ul: [['className', 'contains-task-list']],
    ol: ['start', ['className', 'contains-task-list']],
    td: [['align', 'left', 'center', 'right']],
    th: [['align', 'left', 'center', 'right']],
    section: ['dataFootnotes', ['className', 'footnotes']],
  },
  protocols: { href: ['http', 'https', 'mailto'], src: ['http', 'https'] },
  ancestors: {
    li: ['ol', 'ul'],
    tbody: ['table'],
    td: ['table'],
    th: ['table'],
    thead: ['table'],
    tr: ['table'],
  },
  required: { input: { type: 'checkbox', disabled: true } },
};

/** A flavor may add presentation tags/attributes, but never weaken the security policy. */
export class UnsafeSanitizeExtensionError extends Error {
  constructor(key: string) {
    super(
      `sanitize/schema.ts: flavor extension '${key}' is unsafe; use presentation-only tags and attributes.`,
    );
    this.name = 'UnsafeSanitizeExtensionError';
  }
}

/** Merges only additive tags and safe attributes; all protocol and clobber policy remains owned here. */
export function mergeSanitizeSchema(extension: Partial<Schema>): Schema {
  for (const key of Object.keys(extension)) {
    if (key !== 'tagNames' && key !== 'attributes') throw new UnsafeSanitizeExtensionError(key);
  }
  const tags = [...iridiumSanitizeSchema.tagNames];
  const permitted = new Set([...tags, 'details', 'summary', 'mark', 'div']);
  for (const tag of extension.tagNames ?? []) {
    if (!permitted.has(tag)) throw new UnsafeSanitizeExtensionError(tag);
    if (!tags.includes(tag)) tags.push(tag);
  }
  const attributes: NonNullable<Schema['attributes']> = {};
  for (const [tag, rules] of Object.entries(iridiumSanitizeSchema.attributes))
    attributes[tag] = [...rules];
  for (const [tag, rules] of Object.entries(extension.attributes ?? {})) {
    for (const rule of rules) {
      const name = typeof rule === 'string' ? rule : rule[0];
      if (
        /^(?:on|style$|name$|target$|rel$|srcset$|id$|ariaDescribedBy$|ariaLabelledBy$|href$|src$|data\*$)/i.test(
          name,
        )
      ) {
        throw new UnsafeSanitizeExtensionError(name);
      }
    }
    attributes[tag] = [...(attributes[tag] ?? []), ...rules];
  }
  return { ...iridiumSanitizeSchema, tagNames: tags, attributes };
}
