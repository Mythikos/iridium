/**
 * The Playwright `setup` project (10-testing-and-quality.md, "Playwright 1.63.0 configuration").
 *
 * Every other project depends on this one, so it exists from M0 and must pass without a populated
 * database. M1 replaces the body with the real work: creating the fixture users through REST and
 * saving their storage states, which is what the `chromium` and `electron` projects then reuse.
 */
import { expect, test as setup } from '@playwright/test';

setup('the end-to-end environment is configured', ({ baseURL }) => {
  expect(baseURL, 'playwright.config.ts must publish a baseURL for every project').toBeTruthy();
});
