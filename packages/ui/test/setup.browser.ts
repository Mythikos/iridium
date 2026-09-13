/**
 * Setup for the Vitest `component` project (Browser Mode, real Chromium — 10-testing-and-quality.md,
 * "Vitest 5.0.0 root configuration"). The root config names this file in
 * `projects[component].setupFiles`, so it runs once per test file in the browser page, before the
 * component under test is imported.
 *
 * At M0 it registers the axe-core matcher so a component spec can assert zero serious or critical
 * accessibility findings (07-client-applications.md §9.1). M4 adds the `MemoryHost` msw server
 * lifecycle here, once there are component trees to drive.
 */
import 'vitest-axe/extend-expect';
import { expect } from 'vitest';
// `vitest-axe/matchers` re-exports `toHaveNoViolations` as a value; its published `.d.ts` marks the
// re-export `type`, so the namespace import is the form that type-checks and still registers.
import * as axeMatchers from 'vitest-axe/matchers';

expect.extend(axeMatchers);
