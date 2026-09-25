# D12-23: extended exit rows

Status: accepted 2026-09-25.

An exit-criteria row in 12-milestones.md whose Test cell carries the literal marker "(extended)" after the name adds exit obligations at that milestone to a test that an earlier milestone already schedules. It claims no milestone in `docs/acceptance-map.json`: `scripts/lib/milestone-index.ts` lists the name in that milestone's exit criteria but records no claim for it, keeping the name in an extensions map, and `scripts/build-acceptance-map.ts` requires each extended name's resolved `sinceMilestone` to exist and to be strictly earlier than the extending milestone, otherwise exiting 1 and naming the section and the test. The shipped extended rows keep their values: `token.effective-permissions.prop` stays M1 and `content.read-parity.integration` stays M3.

Because the exit tables' claims win in the acceptance map, an unmarked later row would move a test's `sinceMilestone` forward and erase the milestone that first proved it; the marker lets a later milestone add obligations — `ticket-store.contract`, `config.env.unit`, `readyz.integration`, `ops.shutdown.unit`, `shutdown.drain.integration`, `db.query-deadline.unit` and `compat.n-minus-1.integration` among them at M3 — without that loss, and the generator refuses a marker with nothing earlier to extend. In 10-testing-and-quality.md an inventory row is extended in plain text with no bold marker, because the inventory's milestone reader takes the first bold marker and "since" phrase.

Verification: `pnpm gen` regenerates `docs/acceptance-map.json` and fails on an extended name that resolves to no strictly earlier milestone.

Source: D12-23 in [the decision log](../plan/13-decision-log.md) and in [12-milestones.md](../plan/12-milestones.md), "Decisions made in this section".
