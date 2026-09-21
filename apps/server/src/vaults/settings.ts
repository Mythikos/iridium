/** Environment floors are read from the contracts metadata, never duplicated per request field. */
import { VAULT_SETTING_RULES, type VaultSettingsPatch } from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';

/** Baselines supported by the current environment schema. */
export interface VaultSettingsFloor {
  readonly mcpEnabled: boolean;
  readonly trashRetentionDays: number;
}

/** Reject a weaker value rather than clamping it or accepting an ineffective setting. */
export function assertVaultSettingsFloor(
  patch: VaultSettingsPatch,
  floors: VaultSettingsFloor,
): void {
  for (const [key, rule] of Object.entries(VAULT_SETTING_RULES)) {
    const floor =
      key === 'mcpEnabled'
        ? { value: patch.mcpEnabled, baseline: floors.mcpEnabled }
        : key === 'trashRetentionDays'
          ? { value: patch.trashRetentionDays, baseline: floors.trashRetentionDays }
          : undefined;
    if (floor === undefined || floor.value === undefined) continue;
    const { value, baseline } = floor;
    const weaker =
      rule.stricter === 'false'
        ? !baseline && value !== false
        : rule.stricter === 'higher' && typeof value === 'number' && typeof baseline === 'number'
          ? value < baseline
          : rule.stricter === 'lower' && typeof value === 'number' && typeof baseline === 'number'
            ? value > baseline
            : false;
    if (weaker)
      throw new ProblemError('validation_failed', {
        detail: `${key} cannot weaken the ${rule.environment ?? key} environment baseline.`,
        errors: [
          {
            path: `body.${key}`,
            message: 'The environment floor may only be tightened.',
            code: 'below_env_floor',
          },
        ],
      });
  }
}
