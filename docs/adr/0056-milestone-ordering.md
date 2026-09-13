# A56 — Milestone ordering: risk-first order with enterprise foundations folded into M0/M1

**Status:** Accepted (2026-09-11).

## Context

Spec §10 names the first milestone literally: "one authenticated note, two editors, one viewer, MySQL persistence, and a server restart. Prove correct collaboration, authorization, and saving before expanding the vault-management UI." The four plans ordered work differently: platform-first (enterprise), UI-first (product-dx, with a visible editor at M1), MCP-before-structure (agent-first), and kernel-first (risk-first). The judges chose risk-first in two of three panels.

## Decision

M0 bootstrap + harnesses + spikes → M1 headless kernel (the spec §10 sentence is the literal gate; the audit chain, configuration, readiness, DB roles, and CLI foundations from the enterprise plan are included here rather than in a separate platform milestone) → M2 structure / lifecycle / revisions / projections / search → M3 MCP + tokens + bridge → M4 shared UI + web host (+ vault channel) → M5 Electron → M6 import/export/attachments UI → M7 admin console → M8 operations hardening + release. A minimal visible web editor may be demonstrated at M1 but is not a gate. Each milestone exits only on green automated tests; no time or effort estimates appear anywhere in the plan.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Platform-first (enterprise M1 "platform skeleton" before collaboration) | Delays the highest-risk proof (durable saving under faults); its contents are folded into M1 instead. |
| UI-first (product-dx: visible editor as the M1 gate) | Makes UI work a prerequisite of proving the kernel; the demo remains allowed but ungated. |
| MCP-before-structure (agent-first M2) | MCP reads projections and paths that M2 defines (`ContentReadCore`, `note_projections`, derived paths). |

## Consequences

Positive: the riskiest technical claims (A15, A16, A19, A21, A23) are proven headless before any UI exists; MCP (a primary feature) ships at M3, immediately after the read model exists. Negative: nothing user-visible exists until M4 — accepted deliberately; the optional M1 demo mitigates it without becoming a gate.

## Verification

`12-milestones.md` lists the exit tests per milestone; M1's `kernel.smoke.integration` is the literal spec §10 sentence.

## References

Spec §10; judges 1–3; plan-risk-first §11; plan-enterprise M1/M2 (folded). Implemented in `12-milestones.md`.

---

## Area 2 — HTTP server, validation, and data layer

---

Source: docs/plan/13-decision-log.md, decision A56. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
