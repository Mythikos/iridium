# D13-16: test-name and CI-gate spellings are citations

Status: accepted 2026-09-25; supersedes D13-2 in part — the never-edited rule does not cover citation corrections of recorded test-name and CI-gate spellings — marked inline on D13-2's row and in the log's "How to read this log" Status field.

**The rule.** A test-name or CI-gate spelling anywhere in `docs/` is a citation. Correcting it to the canonical that a Superseded row records is a citation correction, not an edit of decision text under D13-2, and needs no supersession marker, wherever the spelling appears: a plan section, a Verification or Decision paragraph of the decision log, a section-decision row, an ADR file, a milestone record or a spike note; the Superseded row keeps the old spelling resolvable. Three things remain decision content and change only by supersession: what a decision says a test asserts; which test exists; and a sentence whose subject is the superseded spelling itself, which is exempted by line hash and never corrected. The retired CI job name is therefore cited as "the `static` job's `pnpm gen:check` step", identically in the log and its mirrors, and the route-policy boot guard by its full name, `authz.route-policy.boot.guard`.

**The checker.** `scripts/check-test-name-references.ts`, with its pure rules in `scripts/lib/test-names.ts`, scans `docs/**/*.md` and skips the rows of every table whose first header cell is "Superseded"; `scripts/build-acceptance-map.ts` parses every such table — 10's "Superseded spellings" and 12 §13.5 — into the map's `superseded` array. It enforces:

- **Recorded spellings.** Each backticked left-column spelling whose canonical cell names at least one acceptance-map key is refused outside name context: a match must not be preceded by `[A-Za-z0-9_.@/-]` nor followed by `[A-Za-z0-9_-]` or by `.` and an alphanumeric. When a row's spellings and canonical keys are equally many they pair positionally; otherwise, and for every multi-key spelling, the checker prints the whole canonical cell. Rows whose canonical is only a CI step, a lane or a retired gate are records and are not enforced.
- **Pseudo-name spans.** A backticked span that is a `.test`, `.test.ts` or `.test.tsx` citation, or a directory-prefixed `<area>.<subject>.<layer>` pseudo-name, is refused.
- **Collisions.** At load, the checker exits 2, naming the row and the vocabulary, when a recorded spelling equals, or is a dotted prefix of, a member of a non-test vocabulary: `LOG_EVENTS`, `AUDIT_ACTIONS`, `OAUTH_ACCESS_LOG_ACTIONS` or an operationId of 09 §2.18's route index.
- **Exemptions** live in `scripts/lib/test-name-exemptions.json` as `{file, sha256 of the exact line, spellings, reason}`; an exemption covers only the spellings it names, and a hash mismatch or a listed spelling absent from its line fails the check.

A layerless coinage that was never recorded stays invisible to the checker, and the plan says so.

Without the carve-out, D13-2's never-edited rule would keep a wrong test name in every accepted Decision and Verification paragraph and its mirror, where no reader can resolve it; with it, a decision's substance still changes only by supersession while its citations stay resolvable.

Verification: `guards.test-name-references.guard` (the rules proven in-file over fixture strings: a planted layerless spelling of the route-policy guard refused and its full name accepted, a key that ends in another recorded spelling not flagged by it, a two-key stem printing both keys, a Superseded fixture row carrying a log event refused at load, the pseudo-name refusals and acceptances, and a stale-hash or absent-spelling exemption failing) and the `static` job's reference check.

Source: D13-16 in [the decision log](../plan/13-decision-log.md), "Decisions made in this section".
