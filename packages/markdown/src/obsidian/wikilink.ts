/** Wikilinks are interpreted for indexing only; the renderer leaves the source literal. */

/** Parsed inner target, optional alias/size label and block fragment. */
export interface WikilinkTarget {
  target: string;
  alias: string | null;
  block: boolean;
  embed: boolean;
}

/** Splits an Obsidian reference without treating escaped pipes as aliases. */
export function parseWikilinkTarget(raw: string): WikilinkTarget | null {
  const embed = raw.startsWith('!');
  const value = embed ? raw.slice(1) : raw;
  if (!value.startsWith('[[') || !value.endsWith(']]')) return null;
  const interior = value.slice(2, -2);
  let split = -1;
  for (let offset = 0; offset < interior.length; offset += 1) {
    if (interior[offset] === '\\') {
      offset += 1;
      continue;
    }
    if (interior[offset] === '|') {
      split = offset;
      break;
    }
  }
  const target = (split < 0 ? interior : interior.slice(0, split)).replaceAll('\\|', '|').trim();
  return {
    target,
    alias: split < 0 ? null : interior.slice(split + 1),
    block: /#\^/.test(target),
    embed,
  };
}
