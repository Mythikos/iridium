/**
 * `seed.kernel()` — the cast the whole M1 suite and the Playwright `setup` project share
 * (10-testing-and-quality.md, "Seeding, tickets, sessions"; 12-milestones.md §5.2,
 * `@iridium/testkit`).
 *
 * *"server admin `admin@iridium.test`, `editorA@`, `editorB@`, `editorC@`, `viewer@` (all members of
 * vault `V` with the obvious roles) and `outsider@` (member of nothing)."* The outsider is the load
 * bearing one: every isolation assertion in the milestone is "the outsider gets `404`, never `403`",
 * and a cast without one lets a vault-scoped route pass by never being asked.
 *
 * `note N` carries `MARKER_IMPORT` — `⟦IMPORT-MARK⟧` — so that the *"duplicated initial content"*
 * bug class is detectable by a marker count in every test that touches the note, which is what makes
 * `collab.restart-no-duplication.integration` an assertion rather than a hope. The plan's sentence
 * says the marker arrives *"by importing a one-file fixture"*; the import job is M6 work
 * (12-milestones.md §10.2) and the M1 package row asks for *"note N with seeded Markdown"*, so at
 * this milestone the marker is seeded through `POST /vaults/:vaultId/nodes` instead. The oracle is
 * the same one either way, and M6 re-proves the row with the imported note.
 *
 * The admin is deliberately **not** a member of the vault: a server admin is an implied manager and
 * gets no `vault_members` row unless one is added explicitly (03-data-model.md §5, *Vault creation*),
 * and a seed that added one would hide every "admins are managers without a membership" bug.
 */

import { MARKER_IMPORT } from '../harness/markers.ts';
import type { SeedApi, SeededAdmin, SeededNote, SeededUser, SeededVault } from './seed.ts';

/** The vault every kernel fixture opens. */
export const KERNEL_VAULT_NAME = 'Kernel';

/** The note every kernel fixture edits. */
export const KERNEL_NOTE_NAME = 'Kernel Note';

/** Who is in the cast. */
export type KernelRoleName = 'admin' | 'editorA' | 'editorB' | 'editorC' | 'viewer' | 'outsider';

/** The local parts of the cast, in creation order. */
export const KERNEL_LOCAL_PARTS: Readonly<Record<KernelRoleName, string>> = Object.freeze({
  admin: 'admin',
  editorA: 'editorA',
  editorB: 'editorB',
  editorC: 'editorC',
  viewer: 'viewer',
  outsider: 'outsider',
});

/**
 * The seeded Markdown of `note N`.
 *
 * One marker and one line. Anything longer would make every convergence assertion read around
 * content that is not what the test is about, and the marker has to survive projection and export
 * unchanged, which is exactly what `⟦…⟧` was chosen for.
 */
export const KERNEL_NOTE_MARKDOWN: string = `${MARKER_IMPORT} kernel note\n`;

/** What `seed.kernel()` hands back. */
export interface KernelSeed {
  readonly admin: SeededAdmin;
  readonly editorA: SeededUser;
  readonly editorB: SeededUser;
  readonly editorC: SeededUser;
  readonly viewer: SeededUser;
  /** A member of nothing: the principal every isolation assertion is made against. */
  readonly outsider: SeededUser;
  /** Vault `V`. */
  readonly vault: SeededVault;
  /** Note `N`, carrying `MARKER_IMPORT` exactly once. */
  readonly note: SeededNote;
  /** Everyone with a membership, in role order, for a loop over the matrix. */
  readonly members: readonly (readonly [SeededUser, 'editor' | 'viewer'])[];
}

/**
 * Create the cast, the vault and the note.
 *
 * The cast is created concurrently through real API transactions. The service serializes its
 * creation ordinal and link issuance; the vault and note follow because their foreign keys name
 * the users and vault established by those transactions.
 */
export async function seedKernel(api: SeedApi): Promise<KernelSeed> {
  const admin: SeededAdmin = await api.admin({ displayName: 'Kernel Admin' });

  const [editorA, editorB, editorC, viewer, outsider] = await Promise.all([
    api.user({ admin, email: api.email(KERNEL_LOCAL_PARTS.editorA) }),
    api.user({ admin, email: api.email(KERNEL_LOCAL_PARTS.editorB) }),
    api.user({ admin, email: api.email(KERNEL_LOCAL_PARTS.editorC) }),
    api.user({ admin, email: api.email(KERNEL_LOCAL_PARTS.viewer) }),
    api.user({ admin, email: api.email(KERNEL_LOCAL_PARTS.outsider) }),
  ]);

  const members: readonly (readonly [SeededUser, 'editor' | 'viewer'])[] = [
    [editorA, 'editor'],
    [editorB, 'editor'],
    [editorC, 'editor'],
    [viewer, 'viewer'],
  ];

  const vault = await api.vault({ admin, name: KERNEL_VAULT_NAME, members });
  const note = await api.note({
    admin,
    vault,
    name: KERNEL_NOTE_NAME,
    markdown: KERNEL_NOTE_MARKDOWN,
  });

  return { admin, editorA, editorB, editorC, viewer, outsider, vault, note, members };
}
