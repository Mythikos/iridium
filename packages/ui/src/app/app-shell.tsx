/**
 * The empty application shell (12-milestones.md §4.3, `@iridium/ui` row).
 *
 * At M0 the shell exists to prove the seam end to end: it reads the host from context, announces
 * itself through `shell.setTitle` — the one `IridiumHost` member both hosts implement without a
 * server — and renders a single landmark with strings that come from `i18n/en.ts` rather than from
 * literals. M4 replaces the body with `ThemeProvider → QueryClientProvider → CompatibilityGate →
 * SessionGate → RouterProvider → ToastProvider` and the workspace routes.
 */
import { useEffect } from 'react';

import { t } from '../i18n/t.ts';
import { useHost } from './host-context.tsx';

export function AppShell() {
  const host = useHost();

  useEffect(() => {
    host.shell.setTitle(t('app.name'));
  }, [host]);

  return (
    <main aria-label={t('app.shell.label')} data-iridium-shell={host.kind}>
      <p>{t('app.shell.loading')}</p>
    </main>
  );
}
