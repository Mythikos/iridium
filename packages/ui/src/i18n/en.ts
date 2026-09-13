/**
 * The English string table (07-client-applications.md §9.2, 13-decision-log.md A55).
 *
 * Every user-visible string in `@iridium/ui` lives here as a typed record, so `t('app.name')` is
 * checked at compile time and `guards.i18n.guard` can fail the build on a literal string in JSX or
 * on a key nobody reads. One locale ships at MVP; this table is exactly what a future translation
 * pipeline consumes.
 *
 * M0 carries the first keys — the ones the empty application shell renders.
 */
export const en = {
  'app.name': 'Iridium',
  'app.shell.label': 'Iridium workspace',
  'app.shell.loading': 'Loading Iridium…',
} as const;

/** Every key the table defines; `t()` accepts nothing else. */
export type MessageKey = keyof typeof en;
