# S11 Markdown worker measurements

The original remark pipeline failed the declared representative preview target
after mitigation. The A42 markdown-it fallback is implemented behind the same
pure pipeline interface. Its complete production preview payload is 119,566 gzip
bytes, including the worker and broker. See the formal
[S11 note](../../docs/spikes/S11-markdown-engine-cost.md) and committed
[measurement history](./evidence.json), which retain the failed experiments.

No actual pilot vault was supplied. These are local Windows measurements of the
committed corpus and an explicitly declared synthetic distribution, not observed
pilot telemetry or a formal milestone exit.

This independent workspace lives beside the other spike packages so `turbo prune`
does not copy an unselected nested manifest inside the server package. Historical
reports retain their original `apps/server/spikes/s11` paths and hashes; the move
changes reproduction paths, not their source bytes or recorded measurements.

```sh
pnpm --filter @iridium/markdown build
pnpm exec node spikes/s11-markdown/verify-parser-patch.mjs
pnpm exec node spikes/s11-markdown/measure.mjs --label=local-repeat --verify-bundle
pnpm exec node spikes/s11-markdown/record-evidence.mjs
```

`--only` selects case identifiers; `--warm-corpus` also warms the complete corpus.
Use a unique label to preserve previous results. `--verify-bundle` compares every
complete browser PreviewResult with the Node result for both Markdown flavors.
`--profile` emits diagnostic CPU profiles and disables budget verdicts. The
historical Terser 5.51.2 comparison is retained in the evidence; the current
configuration uses Vite's default Oxc minifier and requires no Terser dependency.

Raw reports, emitted bundles and profiles go in ignored `results/`. The evidence
recorder retains all JSON reports and every timing sample, deduplicating identical
manifests and build/module lists by SHA-256. It never filters failures. Generated
third-party bundles are not committed. The pinned parser entry and its upgrade
and removal rules are documented in [PARSER-PATCH.md](./PARSER-PATCH.md).

Run the complete protocol without concurrent builds, test cohorts or Docker work.
The harness uses one real warmed Piscina thread and one Chromium module Worker,
including full projection/preview transfer costs. Normal cases have 20 samples;
1 MiB and pathological cases have three, so their p95/p99 values are sample maxima.
The 30-sample prescan run excludes hashing. The complete fixture corpus has 732
sources; the representative distribution has 50 notes at 4 KiB, 40 at 16 KiB,
nine at 64 KiB and one at 1 MiB. Its declared p95 is 64 KiB. Every report records
versions, environment, exact source hashes, compiled pipeline hashes and lock hash.
