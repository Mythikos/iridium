/** Generated Unicode prose and independent Markdown syntax fragments. */
import * as fc from 'fast-check';

export const WORD = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'é', '中', '😀'),
  minLength: 1,
  maxLength: 20,
});
export const DOCUMENT = fc
  .array(fc.tuple(WORD, fc.constantFrom('plain', 'strong', 'code', 'image', 'entity')), {
    maxLength: 12,
  })
  .map((parts) =>
    parts
      .map(([word, kind]) =>
        kind === 'strong'
          ? `**${word}**m`
          : kind === 'code'
            ? `\`${word}\``
            : kind === 'image'
              ? `![${word}](image.png)`
              : kind === 'entity'
                ? `${word} &amp; &#169;`
                : word,
      )
      .join('\n\n'),
  );
