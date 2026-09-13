/**
 * Step 5 of `pnpm gen`: `packages/contracts/mcp/tools.schema.json`
 * (12-milestones.md §4.3; 06-mcp-and-agent-access.md, "Contract artefacts and drift").
 *
 * The artefact is the frozen record of the MCP tool surface: names, titles, descriptions, input and
 * output JSON Schema, annotations, and **registration order**. `mcp.tools-schema.contract` asserts
 * that a live `tools/list` in both protocol eras deep-equals the `tools` array below, order included,
 * and `docs/agents/tools-reference.md` is generated from the same file, so the documentation cannot
 * describe a tool that does not exist.
 *
 * **At M0 the tool set is empty, and that is the artefact, not a placeholder for one.** The six read
 * tools arrive at M3 (06-mcp-and-agent-access.md; the `mcp` plugin is boot step 10 and is an empty
 * stub until then). What the M0 document does carry is the envelope and the frozen registration order,
 * because the order is fixed now — 06 fixes it as "the order the 2026-07-28 spec asks for and the
 * order `mcp.tools-schema.contract` asserts" — and an artefact that recorded nothing would let M3
 * choose a different one silently.
 *
 * **The seam M3 fills in.** When `packages/contracts/src/mcp/tools.ts` exists, this step imports its
 * `MCP_TOOLS` export and emits one entry per tool in the order that array declares, then asserts that
 * the emitted names equal `REGISTRATION_ORDER`. A tool added without a place in that order, or a
 * reordering, therefore fails this step rather than the contract test on a running server.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isRecord } from './lib/json.ts';
import { ARTEFACTS, REPO_ROOT } from './lib/paths.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { writeJsonOrCompare } from './lib/write.ts';

/** The MCP protocol revision the schemas are frozen against (06-mcp-and-agent-access.md §4.1). */
export const MCP_PROTOCOL_REVISION = '2026-07-28';

/**
 * The registration order `tools/list` must return, fixed by 06-mcp-and-agent-access.md.
 *
 * It is data here rather than a comment because the M3 export asserts against it: deterministic
 * `tools/list` output is part of the contract, and "whatever order the module happens to declare" is
 * not a contract.
 */
export const REGISTRATION_ORDER: readonly string[] = [
  'list_vaults',
  'list_notes',
  'get_note',
  'search_notes',
  'list_note_revisions',
  'list_attachments',
];

/** Where the zod tool schemas will live. Absent until M3. */
const TOOL_SOURCE = `${REPO_ROOT.replaceAll('\\', '/')}/packages/contracts/src/mcp/tools.ts`;

/** One entry of the committed `tools` array. The shape `tools/list` returns, plus nothing. */
export interface ToolSchemaEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

function isToolEntry(value: unknown): value is ToolSchemaEntry {
  return isRecord(value) && typeof value['name'] === 'string';
}

/** Load the tool definitions, or an empty list when the module does not exist yet. */
async function loadTools(): Promise<readonly ToolSchemaEntry[]> {
  if (!existsSync(TOOL_SOURCE)) return [];
  const module: unknown = await import(pathToFileURL(TOOL_SOURCE).href);
  const exported = isRecord(module) ? module['MCP_TOOLS'] : undefined;
  if (!Array.isArray(exported) || !exported.every((entry) => isToolEntry(entry))) {
    throw new Error(
      `${TOOL_SOURCE} exists but exports no \`MCP_TOOLS\` array of tool definitions. That export is ` +
        'the seam this step reads; see the module header of scripts/export-mcp-tools.ts.',
    );
  }
  const tools: readonly ToolSchemaEntry[] = exported;
  const names = tools.map((tool) => tool.name);
  const expected = [...REGISTRATION_ORDER];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(
      'MCP_TOOLS does not declare the frozen registration order.\n' +
        `  expected: ${expected.join(', ')}\n` +
        `  found:    ${names.join(', ')}\n` +
        '  `tools/list` order is part of the contract (06-mcp-and-agent-access.md). Either reorder ' +
        'the module or change REGISTRATION_ORDER in scripts/export-mcp-tools.ts together with 06.',
    );
  }
  return tools;
}

export const step: Step = {
  name: 'mcp tool schema',
  produces: 'packages/contracts/mcp/tools.schema.json',
  async run(context: StepContext): Promise<StepResult> {
    const tools = await loadTools();
    const document = {
      protocolRevision: MCP_PROTOCOL_REVISION,
      generatedBy: 'scripts/export-mcp-tools.ts',
      description:
        'The frozen MCP tool surface. `mcp.tools-schema.contract` asserts that a live `tools/list` ' +
        'deep-equals `tools`, order included, in both protocol eras. Regenerate with `pnpm gen`.',
      registrationOrder: [...REGISTRATION_ORDER],
      tools,
    };
    const outcome = writeJsonOrCompare(ARTEFACTS.mcpTools, document, context.check);
    return {
      summary:
        `${String(tools.length)} tool(s) at revision ${MCP_PROTOCOL_REVISION}, ` +
        `${String(outcome.bytes)} bytes`,
      writes: [outcome],
      details:
        tools.length === 0
          ? [
              'the six read tools arrive at M3; the envelope and the frozen order are the M0 artefact',
            ]
          : [],
    };
  },
};

if (import.meta.main) await runAsMain(step);
