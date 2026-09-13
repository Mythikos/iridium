# M0 spike harness (S1, S2, S14)

The throwaway harness of decision D12-5: spikes S1, S2 and S14 share it, and it is deleted when the
M1 kernel replaces it (`docs/plan/12-milestones.md` §4.4). Nothing here is product code and nothing
here may be imported by product code; the verdicts live in `docs/spikes/S01-*.md`, `S02-*.md` and
`S14-*.md`.

Every pass criterion of the register rows is asserted by a Vitest file, never observed by eye:

| Spike | File                                             | What it asserts                                                                           |
| ----- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| S2    | `s02-fastify-websocket-hocuspocus.spike.spec.ts` | `@fastify/websocket` 11.3.0 → `hocuspocus.handleConnection` wiring on the real `buildApp` |
| S1    | `s01-onloaddocument-v2-apply.spike.spec.ts`      | in-place V2 + V1 apply in `onLoadDocument`, 20 restarts, 1 MiB history                    |
| S14   | `s14-mcp-dual-era-handler.spike.spec.ts`         | one `createMcpHandler` behind `reply.hijack()` under Iridium's hook chain                 |

Run from `apps/server` (no database is needed — the app boots with `database: 'none'`):

```
pnpm exec vitest --run --config test/spikes/vitest.config.ts
```

S14's conformance and Inspector legs need the two tools installed in a scratch npm project outside the
repository (they are not workspace dependencies):

```
npm install --save-exact @modelcontextprotocol/conformance@0.1.16 @modelcontextprotocol/inspector@2.6.0
IRIDIUM_S14_TOOLS=<that directory> pnpm exec vitest --run --config test/spikes/vitest.config.ts
```

Without `IRIDIUM_S14_TOOLS` those two tests are skipped and the in-process client covers their
assertions. Measurements are written to `results/*.json` and cited by the spike notes.
