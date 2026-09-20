# D10-25: extended chaos runner budget

Status: accepted, amended 2026-09-20.

The first remote nightly, run `35475597877`, cancels `chaos-extended` job `105984200183`
after its 240-minute deadline. The revocation file alone takes 6,952 seconds. The incomplete
run remains a failure; its logs and partial artifact do not establish the remaining cases.

Split the complete chaos project into four Vitest file shards on independent Actions runners,
on both supported MySQL engines. Each shard keeps `IRIDIUM_CHAOS_ITERATIONS=200`, the existing
per-case deadlines and a 240-minute job deadline. The target remains at most three hours per
shard. Vitest assigns every discovered file to exactly one shard; the 14-file M1 inventory
produces groups of 4, 4, 3 and 3. No test-name filter, retry or reduced iteration count is added.
Each shard uploads a distinct artifact, and `fail-fast: false` preserves the other results.

The other-engine job also separates its property and Schemathesis campaigns from the four
chaos shards. The first run's property failure previously skipped both later campaigns;
independent jobs preserve their evidence. Those campaigns retain their 300-minute deadlines
and existing example budgets. A logical lane is green only when every due matrix member passes.

Scheduled runs remain serialized. Each manual rehearsal has its own concurrency group, as in
the main CI workflow, so a repaired captured tree can run while the prior nightly's unrelated
mutation campaign finishes. Existing runs and their conclusions are retained.

This supersedes the original suggestion to split the timed-out suite into two jobs: two hash
shards would still place the two-hour revocation file beside the 200-iteration durability file.
Four shards separate those files without changing the acceptance scenarios. Static selection
verification is not a substitute for the next full remote nightly.
