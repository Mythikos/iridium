import type { ObsidianCode } from '@iridium/contracts';
/** The seam is reserved; G2 requires identical rendering of both flavors through 1.0. */
import type { Schema } from 'hast-util-sanitize';
import type { Pluggable } from 'unified';

import type { MarkdownFlavor } from './types.ts';

/** All future flavor transforms run before the unchanged sanitizer boundary. */
export interface FlavorPlugin {
  id: MarkdownFlavor;
  remark: Pluggable[];
  rehype: Pluggable[];
  sanitizeExtension: Partial<Schema>;
  detectorOverrides?: Partial<Record<ObsidianCode, 'silence'>>;
}

/** The base flavor contributes no additional transforms. */
export const gfmFlavor: FlavorPlugin = { id: 'gfm', remark: [], rehype: [], sanitizeExtension: {} };

/** Obsidian syntax is detected, indexed and rendered literally by explicit product decision. */
export const obsidianCompatFlavor: FlavorPlugin = { ...gfmFlavor, id: 'obsidian-compat' };
