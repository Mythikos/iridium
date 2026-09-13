/**
 * `desktop.launch.e2e` — the M0 desktop smoke (12-milestones.md §4.3 and §4.6;
 * 10-testing-and-quality.md, "E2E inventory").
 *
 * It exists from the first milestone so the merge-blocking `e2e-electron` lane is never an empty
 * required check, and it proves the four properties the shell is worthless without: the packaged-dev
 * shell launches, the renderer is loaded from `app://iridium/`, no Node reaches that renderer, and
 * the response carrying the application carries a Content-Security-Policy.
 *
 * It carries `@smoke`, which is the selector `e2e-electron` uses on every pull request across
 * ubuntu, windows and macos.
 */
import { expect, test } from '../fixtures/index.ts';

test.describe('desktop.launch.e2e [area:clients]', { tag: ['@smoke', '@area-clients'] }, () => {
  test('launches a window on app://iridium with a CSP and no Node in the renderer', async ({
    electronApp,
    firstWindow,
  }) => {
    // The app launched and opened exactly one window (07-client-applications.md D07-16).
    expect(electronApp.windows()).toHaveLength(1);

    // The renderer is never loaded from file:// and never from a remote origin (§7.3).
    expect(firstWindow.url()).toBe('app://iridium/');

    // The first window's title.
    await expect.poll(() => firstWindow.title()).toBe('Iridium');

    // Hardening rows H1 and H2: sandbox plus context isolation, so the page has no Node at all.
    const rendererGlobals = await firstWindow.evaluate(() => ({
      require: typeof require,
      process: typeof process,
      module: typeof module,
    }));
    expect(rendererGlobals).toStrictEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
    });

    // Hardening row H8: the per-load CSP the scheme handler attaches to the application document.
    // The request is made from main rather than from the page, because the policy under test sets
    // `connect-src 'none'` until a server profile exists — the renderer is not allowed to fetch
    // anything at all, including its own origin.
    const [document] = await Promise.all([
      firstWindow.waitForResponse((response) => response.url() === 'app://iridium/'),
      firstWindow.reload(),
    ]);
    const csp = (await document.allHeaders())['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain('localhost');
  });
});
