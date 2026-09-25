# D14-11: spike notes are gating artefacts; spike timing and fallback references

Status: accepted; amended 2026-09-25: a spike that needs a milestone's surface runs at that milestone before its exit (S9 at M3, S15 at M4), and a failed spike's fallback is named by a pull request or a commit.

**As accepted.** Spike notes are gating artefacts: `docs/spikes/S<nn>-<slug>.md` with the fixed heading set (Question, Why it blocks, Pinned versions, Method, Result, Decision, Fallback executed, Follow-ups), checked by `docs.spikes.spec` in the `static` CI job — which is what the "spikes closed" milestone gate asserts, not a manual read-through — and carrying the same ids and filenames as the spike register in `12-milestones.md` §4.4; a spike whose result is `fail` must name the pull request that executed its recorded fallback in the same milestone.

**Amended 2026-09-25 (spike timing and fallback references, shared with D12-15).** A spike that needs a milestone's surface runs at that milestone once the surface exists and before its exit: S9 runs at M3 and S15 at M4 (AG9), in both registers. A spike whose result is `fail` names the pull request or the commit (`commit <sha>`) that executed its recorded fallback in the same milestone; while main is worked without pull requests (owner instruction, 2026-09-19) that is the milestone commit, written in by the follow-up docs commit, because a commit cannot name itself.

A spike cannot observe a surface that does not exist, and "before exit" keeps it a gate on the milestone that needs it without pretending it precedes the work. `docs.spikes.spec` already compares milestone numbers only and accepts a commit reference, so the plan text was the stale party. Rejected: keeping "entry" and running a spike against a partial server.

Source: the "Spike timing and fallback references" amendment in [the decision log](../plan/13-decision-log.md), and D14-11 in [14-risks-and-open-questions.md](../plan/14-risks-and-open-questions.md), "Decisions made in this section". The same amendment is mirrored for D12-15 in [d12-15-spike-register.md](./d12-15-spike-register.md).
