/**
 * `t()` — key lookup plus `{placeholder}` interpolation (07-client-applications.md D07-17).
 *
 * There is deliberately no runtime i18n library: one locale ships at MVP and the typed table in
 * `en.ts` is the only thing a translation pipeline needs. M4 adds the `Intl.PluralRules` count
 * variants and the React-node interpolation form described in §9.2; the signature below is the
 * string-only half those extend.
 */
import { en, type MessageKey } from './en.ts';

export type MessageValues = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

export function t(key: MessageKey, values?: MessageValues): string {
  const template: string = en[key];
  if (values === undefined) return template;
  return template.replaceAll(PLACEHOLDER, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
