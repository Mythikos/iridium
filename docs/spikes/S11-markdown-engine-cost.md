# S11 — Markdown engine cost

## Question

Does the implemented remark pipeline meet the projection and preview budgets on
the committed corpus and a declared pilot-representative size distribution, or
does A42 require the recorded markdown-it fallback?

## Why it blocks

M2 must establish the parser choice and worker admission behavior that M4's preview
budget relies on. The experiment must include the actual sanitizer, highlighting,
projection and complete worker response, rather than a parser-only microbenchmark.

## Pinned versions

The measured host is Windows 10.0.26200, x64, Intel Core i9-14900KF with 32 logical
processors and 68,463,702,016 bytes RAM. Runtime versions are Node 24.21.0,
Playwright 1.63.0 and Chromium 153.0.8010.12. The worker pool is Piscina 5.3.2;
production browser builds use Vite 8.3.0 and its default Oxc minifier with the shared
`WEB_BUILD_TARGET`. The final persisted projection version is **2**: M1 already
stored version 1, so keeping 1 would silently skip the required reindex.

Pipeline versions are unified 11.0.5, original remark-parse 11.0.0 and
remark-frontmatter 5.0.0, remark-rehype 11.1.2, remark-breaks 4.0.0,
mdast-util-gfm-autolink-literal 2.0.1, mdast-util-to-hast 13.2.1,
mdast-util-to-string 4.0.0, rehype-sanitize 6.0.0, hast-util-sanitize 5.0.2,
rehype-stringify 10.0.1, yaml 2.9.1, lowlight 3.3.0, highlight.js 11.12.0,
github-slugger 2.0.0 and vfile 6.0.3. The executed fallback is markdown-it 15.0.2
with the checked-in packaging patch. Its unchanged grammar is shared between the
root entry and the additional token entry.

Terser 5.51.2 was compared and rejected; it is not a production dependency. The
original patch generator used the TypeScript 6.0.3 compiler API; the final declared
spike dependency uses `npm:@typescript/typescript6@6.0.2` and reproduced exactly the
same patch bytes with diff 8.0.4. The workspace compiler is TypeScript 7.0.2 and tests use Vitest
5.0.0. Exact resolved browser package locators, lockfile hashes, pipeline build
hashes and emitted module graphs are retained per run in
[evidence.json](../../spikes/s11-markdown/evidence.json).

## Method

The reproduction lives in [spikes/s11-markdown](../../spikes/s11-markdown/README.md):

```sh
pnpm --filter @iridium/markdown build
pnpm exec node spikes/s11-markdown/verify-parser-patch.mjs
pnpm exec node spikes/s11-markdown/measure.mjs --label=local-repeat --verify-bundle
pnpm exec node spikes/s11-markdown/record-evidence.mjs
```

The independent spike workspace lives outside the server package so production
pruning excludes its manifest and dependencies together. Older report paths and
hashes retain the location where each measurement ran. Relocation produced the
same emitted content-hash filenames and sizes; the canonical corpus passed all 1,464
comparisons. Hostile inputs are selected by their expectations manifest, so the
fixture package's generated changelog cannot become an extra note.

Each complete run uses one warmed real Piscina worker with the production heap
and stack limits, and one warmed Chromium module Worker. Calls are sequential.
Projection includes worker-side hashing; preview transfers exactly the required
`PreviewResult` fields. Results record compute, parsing, transform and complete
round-trip latency separately. Module initialization is excluded. Hosts terminate
and replace workers after the 10-second server or 2-second browser deadline.
Uncapped cases call the same parser and transforms through a benchmark-only
adapter; production exposes no admission bypass.

The 732 measured sources comprise all 652 CommonMark 0.31.2 examples, 15 GFM golden
sources, testkit's demo and Obsidian sample vaults, and its original hostile corpus.
Every normalized source is identified by byte length and SHA-256. CommonMark
attribution and CC-BY-SA-4.0 terms are preserved in the fixture provenance file.
The corpus size distribution is p50 20 bytes, p95 104 bytes, p99 427 bytes and
maximum 149,947 bytes. These short conformance examples are not a pilot workload.

The separate declared representative distribution is 50 notes at 4 KiB, 40 at
16 KiB, nine at 64 KiB and one at 1 MiB, using the readable handbook passage in the
harness. Its p50 is 4 KiB and p95/p99 are 64 KiB. **No actual pilot corpus was
supplied**; neither actual pilot size percentiles nor their latency were measured.

Normal size cases have 20 samples, the 1 MiB and pathological cases have three,
and prescan has 30. Percentiles use nearest rank. Three-sample p95 and p99 are
sample maxima, not stable population estimates. Full samples and every unsuccessful
run are retained in the evidence, with repeated manifests stored once by hash.
Generated bundles and CPU profiles are ignored artifacts; their hashes and CPU
attribution summaries are retained. Team builds, test cohorts and Docker commands
were paused during the isolated timing windows. No external contention cause was
established for the observed variance.

## Result

**fail** for the original remark implementation. The executed fallback preserves
the pipeline contract and passes the parser and packaging checks described below.
This is local evidence on the declared synthetic distribution; it does not claim
an unavailable actual-pilot measurement or formal milestone completion.

The original complete run (`windows-final.json`) measured browser preview p95
115.1 ms at the representative 64 KiB size. A favorable isolated repeat measured
85.2 ms, but that result did not supersede the failure. CPU profiles attributed the
main cost to micromark's splice/subtokenize/compile path. Removing duplicated
outline work, using native ASCII admission checks and transferring only the
required preview result still produced **109.2 ms** in `post-mitigation.json`
(101.1 ms worker compute). Its 100 KiB Node projection p95 was 206.311 ms, within
the 400 ms projection target, but that did not satisfy the independent preview
criterion. A42's recorded parser fallback was therefore executed.

The first complete fallback run measured representative preview p95 27.4 ms,
100 KiB projection p95 41.963 ms and prescan throughput 283.936 MB/s. Its complete
browser payload was **130,181 gzip bytes**, failing the **120,000-byte** limit.
The subsequent packaging work retained all required payload and semantics:

| Experiment | Complete gzip bytes | Outcome |
|---|---:|---|
| Initial markdown-it fallback | 130,181 | Fail |
| Shared parser entry, optional capabilities still retained | 122,586 | Fail |
| Safe Terser comparison of that entry | 120,591 | Fail |
| Browser-only central policy leaf, Oxc | 121,007 | Fail |
| Shared token core drops unused optional registry | 119,445 | Pass |
| Final shared sync/async resolver, release version 2 | 119,540 | Pass |
| Bounded native UTF-8 admission counter | 119,566 | Pass |

The final import-boundary cleanup makes S11 a separate `spike` workspace with
declared dependencies and uses the Markdown package's narrow benchmark subpath.
The shared hostile corpus is exposed through an inert fixture leaf without
copying bytes or depending on the Node testkit runtime. The subsequent emitted
worker and broker have the same content-hash filenames and sizes as the final timing build and pass all
1,464 preview comparisons (`markdown-it-spike-boundaries.json`).

The leaf policy defines each browser-relevant bound once and the central `LIMITS`
object aggregates it; no bound was removed or weakened. Importing the original
rehype-highlight entry retained its default common-language registry even when a
fixed registry was supplied. The equivalent transform therefore uses lowlight's
core with exactly the 21 specified grammars and aliases, detection disabled.
Both lowlight's core and those grammars resolve highlight.js 11.12.0. Sanitizer
ordering and schema are unchanged. Required JavaScript was neither split out of
the measured total nor deferred to conceal bytes.

The release-v2 run before the final admission optimization preserved another
failure: prescan p95 was **4.277 ms**, or **245.170 MB/s**, below 250 MB/s.
Its representative preview p95 was 42.8 ms and 100 KiB projection p95 was 61.901 ms.
A diagnostic CPU profile attributed about 28% of sampled prescan work to the full
ASCII regex scan used for byte counting. The implementation now uses
[`TextEncoder.encodeInto`](https://encoding.spec.whatwg.org/#dom-textencoder-encodeinto)
with a reusable 64 KiB scratch buffer: exact UTF-8 length, bounded auxiliary memory
and no source-sized allocation. Tests cover surrogate pairs across buffer
boundaries, lone surrogates, non-ASCII source and reuse after a longer input.
The initial v2 failure remains in the evidence rather than being replaced by the
earlier favorable v1 run.

The final isolated release-v2 run (`markdown-it-release-v2-final.json`) passes
all four declared local gates: representative preview p95 **28.8 ms < 100 ms**,
100 KiB projection p95 **37.127 ms < 400 ms** (39.18 ms round trip), prescan p95
**2.693 ms**, or **389.371 MB/s ≥ 250 MB/s**, and complete browser payload
**119,566 bytes ≤ 120,000** (118,794 worker + 772 broker). Its source-size curve
with admission enabled is below; all durations are milliseconds.

| Source bytes | Node compute p50 / p95 / p99 | Browser round trip p50 / p95 / p99 |
|---|---:|---:|
| 4,096 | 1.344 / 2.422 / 3.248 | 1.6 / 1.9 / 2.4 |
| 16,384 | 4.887 / 8.615 / 9.632 | 5.8 / 8.4 / 9.0 |
| 65,536 | 24.456 / 36.338 / 40.594 | 23.8 / 28.8 / 32.4 |
| 102,400 | 32.687 / 37.127 / 38.703 | 37.5 / 41.3 / 41.9 |
| 262,144 | 90.998 / 129.088 / 134.816 | 101.9 / 134.8 / 164.8 |
| 1,048,576 | 497.112 / 527.399 / 527.399 | 501.8 / 511.4 / 511.4 |

The same complete run with caps bypassed only in the benchmark records:

| Source bytes | Node compute p50 / p95 / p99 | Browser round trip p50 / p95 / p99 |
|---|---:|---:|
| 4,096 | 1.293 / 2.258 / 6.317 | 1.6 / 2.3 / 4.6 |
| 16,384 | 4.311 / 8.581 / 9.299 | 5.6 / 8.7 / 8.8 |
| 65,536 | 20.447 / 32.278 / 34.357 | 23.6 / 29.1 / 30.0 |
| 102,400 | 31.650 / 35.631 / 35.651 | 35.8 / 41.8 / 42.0 |
| 262,144 | 88.539 / 128.425 / 143.860 | 97.4 / 108.0 / 112.7 |
| 1,048,576 | 506.532 / 552.162 / 552.162 | 472.5 / 522.0 / 522.0 |

All 732 measured fixtures completed in both workers (aggregate Node compute p95
0.323 ms; browser round-trip p95 0.3 ms), and **1,464** emitted-browser results
exactly matched Node across both flavors. The required 1 MiB realistic case
completed all samples under both worker deadlines; its browser p95 is above the
representative 100 ms target, which is specifically evaluated at 64 KiB.
All 652 CommonMark ASTs and source positions, the committed GFM goldens and the
adversarial adapter cases pass their comparison with the frozen remark baseline.
One additional adversarial case deliberately follows CommonMark over the old
baseline: `**😀**m` stays literal because Unicode symbols count as punctuation.
The old baseline treated UTF-16 surrogate halves independently. This difference
has an explicit regression and an independent source-coordinate oracle; it is
not described as unqualified equivalence. See the
[CommonMark Unicode punctuation rule](https://spec.commonmark.org/0.31.2/#unicode-punctuation-character).

The `'*a_' × 20000` input timed out in all three original-engine server and browser
samples, including with admission enabled. The fallback completes it under the
worker deadlines, but it is not rejected by the stated admission caps; a browser
round-trip stress sample reaches **153.1 ms** (compute 50.6 ms). The representative-size criterion
does not assert every pathological result is below 100 ms. A 3,000-deep blockquote
is rejected with caps; without caps, Chromium throws `RangeError` while Node
completes. Exactly 20,000 paragraph lines are admitted (browser sample maximum
126.3 ms) and 20,001 are rejected.
The excessive list-indent case is rejected. Thus the register's blanket wording
that all pathological cases are rejected by prescan must be read against this
explicit case matrix, not asserted as a measured fact.

## Decision

Use the markdown-it token adapter behind the unchanged `@iridium/markdown`
interface, retain worker deadlines and admission caps, and reindex M1 projections
at pipeline version 2.

## Fallback executed

The A42 fallback is implemented in
[`packages/markdown/src/markdown-it`](../../packages/markdown/src/markdown-it),
selected by the frozen processor, with the same mdast/hast projection and
sanitize-last boundary. The narrow pinned
[upstream packaging patch](../../patches/markdown-it@15.0.2.patch) keeps the public
root API and shared grammar intact. Its
[maintenance and removal rules](../../spikes/s11-markdown/PARSER-PATCH.md)
require the full root oracle, adapter differential, emitted-browser corpus and
complete payload budget after each upgrade.

The fallback was executed in commit `fba2ca7`, which builds the M2 content model
and lands the parser swap, its pinned packaging patch and the pipeline-version 2
reindex of M1 projections together.

## Follow-ups

- The measured decision is mirrored in A42 and ADR 0042.
- Retain the actual-pilot limitation for M4. If a pilot corpus becomes available,
  rerun its real p50/p95/p99 sizes without relabeling synthetic evidence.
- Keep the named source-map, flavor, hostile/sanitizer, byte-preservation,
  pathological and pipeline-version tests. The sanitizer schema's focused V8
  run covered all 25 statements, 18 branches, two functions and 22 lines.
- Review the pinned parser-entry patch on upgrades and remove it when an equivalent
  upstream entry meets the same full-payload budget. No upstream issue or pull
  request has been filed during this task.
- Preserve the failed original-engine, bundle and admission measurements. The
  first `windows-host.json` prescan accidentally included hashing and is explicitly
  superseded by later admission-only measurements; its other case data remains.
