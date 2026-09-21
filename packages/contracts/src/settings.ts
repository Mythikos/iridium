/** Per-vault settings and environment-floor direction (12-milestones.md §6.2, D10-35). */
import { z } from 'zod';

import { LIMITS } from './limits.ts';
import { isSafeNodeName } from './paths.ts';

/** Values stored in the typed vault-settings columns. */
export interface VaultSettingValues {
  readonly markdownFlavor: 'gfm' | 'obsidian-compat';
  readonly softBreaks: boolean;
  readonly attachmentFolder: string;
  readonly loadExternalImages: 'never' | 'click' | 'always';
  readonly mcpEnabled: boolean;
  readonly aiGuidance: string | null;
  readonly trashRetentionDays: number;
  readonly autoCheckpointIntervalMin: number;
}

/** Environment floors may only be tightened in their declared direction. */
export type SettingStrictness = 'none' | 'higher' | 'lower' | 'false';

/** One source for floor direction and its environment key. */
export const VAULT_SETTING_RULES: Readonly<
  Record<
    keyof VaultSettingValues,
    {
      readonly stricter: SettingStrictness;
      readonly environment?: string;
    }
  >
> = Object.freeze({
  markdownFlavor: { stricter: 'none' },
  softBreaks: { stricter: 'none' },
  attachmentFolder: { stricter: 'none' },
  loadExternalImages: { stricter: 'none' },
  mcpEnabled: { stricter: 'false', environment: 'MCP_ENABLED' },
  aiGuidance: { stricter: 'none' },
  trashRetentionDays: { stricter: 'higher', environment: 'TRASH_RETENTION_DAYS' },
  autoCheckpointIntervalMin: { stricter: 'none' },
});

/** Safe relative attachment paths contain only valid node-name segments. */
function attachmentFolderIsSafe(path: string): boolean {
  return path.split('/').every((segment) => isSafeNodeName(segment));
}

/** Custom policy metadata uses OpenAPI extension keys when Zod exports the schema. */
function settingMetadata(key: keyof VaultSettingValues): Record<string, string> {
  const rule = VAULT_SETTING_RULES[key];
  return {
    'x-iridium-stricter': rule.stricter,
    ...(rule.environment === undefined ? {} : { 'x-iridium-environment': rule.environment }),
  };
}

/** Shared schemas for create, update and the full settings DTO. */
export const VAULT_SETTING_FIELDS: {
  readonly [Key in keyof VaultSettingValues]: z.ZodType<VaultSettingValues[Key]>;
} = Object.freeze({
  markdownFlavor: z.enum(['gfm', 'obsidian-compat']).meta(settingMetadata('markdownFlavor')),
  softBreaks: z.boolean().meta(settingMetadata('softBreaks')),
  attachmentFolder: z
    .string()
    .min(1)
    .max(LIMITS.NODE_NAME_MAX_BYTES)
    .refine(attachmentFolderIsSafe, {
      error: 'Use a vault-relative path without empty or unsafe segments.',
    })
    .meta(settingMetadata('attachmentFolder')),
  loadExternalImages: z
    .enum(['never', 'click', 'always'])
    .meta(settingMetadata('loadExternalImages')),
  mcpEnabled: z.boolean().meta(settingMetadata('mcpEnabled')),
  aiGuidance: z
    .string()
    .max(LIMITS.AI_GUIDANCE_MAX_CHARS)
    .nullable()
    .meta(settingMetadata('aiGuidance')),
  trashRetentionDays: z.int().min(1).max(3650).meta(settingMetadata('trashRetentionDays')),
  autoCheckpointIntervalMin: z
    .int()
    .min(1)
    .max(1440)
    .meta(settingMetadata('autoCheckpointIntervalMin')),
});
