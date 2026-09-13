# Spikes

A spike in this plan is not exploratory coding. It is a bounded experiment against pinned
versions with one question, one pass criterion, and a fallback that is already designed — so a
failed spike changes an implementation choice without changing the architecture, and a passed
spike is recorded evidence that a decision was verified rather than assumed
(`docs/plan/14-risks-and-open-questions.md`, "Spikes").

The single spike register — ids, filenames, milestone assignments, questions, pass criteria and
recorded fallbacks — lives in `docs/plan/14-risks-and-open-questions.md` ("Spikes") and is mirrored
by `docs/plan/12-milestones.md` §4.4 inside each milestone's scope. This file holds only the note
template every spike document must use; it is not itself a spike note, and it does not restate the
register (read one of those two plan sections for the current list of spike ids and what each one
blocks).

## Filing a spike note

Every spike ends in `docs/spikes/S<nn>-<slug>.md`, using the `S<nn>` id and `<slug>` the register
assigns it. `docs.spikes.spec` asserts that every spike referenced by a reached milestone exists as
that file, carries every heading below, and — when its Result is `fail` — names the pull request or commit
that executed the recorded fallback.

## The template

A spike note has exactly these eight headings, in this order:

| Heading | Content |
|---|---|
| Question | The single yes/no or measurement question |
| Why it blocks | The milestone scope that cannot be written honestly without the answer |
| Pinned versions | Exact versions of every package, image and client involved |
| Method | The commands or harness used, reproducible from the repository |
| Result | `pass` or `fail` with the evidence (log excerpts, measurements, a committed reproduction test) |
| Decision | What the plan now does, in one sentence |
| Fallback executed | `n/a` on pass; on fail, the fallback taken and the pull request or commit that implemented it |
| Follow-ups | Upstream issues filed, tests added, register rows re-scored |

**Result is `pass` or `fail`, and never `open`.** A spike that has not yet run is not a document in
this directory; a spike that has run has a verdict. "We will look at it later" is not an outcome a
milestone gate accepts (decision D14-11) — a `fail` result does not block the milestone by itself,
but the recorded fallback for that spike is executed inside the same milestone, and the note names
the pull request or commit that did it (while `main` is worked without pull requests, the milestone commit, written in once it exists).

Spike notes are written by whoever runs the spike, at the milestone the register assigns it to; this
file is seeded once, at M0, and changes only if the template itself changes.
