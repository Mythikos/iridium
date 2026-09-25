# D14-03: the milestone risk gate lives in the exit record

Status: accepted; amended 2026-09-25: the gate is recorded in the milestone's exit record, not in a separate gate file.

**As accepted.** Milestone risk gates: a milestone exits only when every risk whose "Retired at" names it is retired with links to the green runs, or explicitly deferred by the product owner with a recorded reason, in `docs/milestones/M<n>-gate.md` — which also records re-scores and newly discovered risks.

**Amended 2026-09-25.** The milestone risk gate is the "Known risks carried forward" field of `docs/milestones/M<N>-exit.md` (D12-8). From M3 on that field accounts for every risk whose Retired-at names the milestone — retired with links to the green runs, or deferred by the product owner with a recorded reason — every re-score with its reason (D14-14), and every risk discovered during the milestone. No `M<N>-gate.md` file exists. `12-milestones.md` §13.2's field text is that accounting, and 14's references point at the exit record. The M3 exit record is the first to carry it, against the M3 retirement-map line as amended by AG9 and AG10.

One exit record per milestone is the plan's settled evidence discipline (D12-8). No gate file was ever written for M0, M1 or M2, whose exit records carried at most a short known-risks disposition; a second file per milestone for a subset of the same evidence invites exactly that omission, while folding the gate into the exit record's existing field makes it part of the review that gates the tag. Rejected: keeping a separate `M<N>-gate.md` beside the exit record.

Source: the D14-03 amendment in [the decision log](../plan/13-decision-log.md), and D14-03 in [14-risks-and-open-questions.md](../plan/14-risks-and-open-questions.md), "Decisions made in this section".
