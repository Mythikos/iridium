/**
 * The mount entry point (12-milestones.md §4.3; 07-client-applications.md §2.5).
 *
 * `mountIridium(host)` is the M0 name of the seam 02-system-architecture.md calls
 * `createIridiumApp(host)`: it takes exactly one `IridiumHost` and returns the handle the two
 * product entries (`apps/web/src/main.tsx`, `apps/desktop/src/renderer/main.tsx`) use to attach the
 * application to a DOM element. Nothing here touches a global, which is what lets the browser tab
 * and the Electron renderer run the same bundle.
 */
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AppShell } from './app/app-shell.tsx';
import { HostProvider } from './app/host-context.tsx';
import type { IridiumHost } from './host.ts';

export interface IridiumApp {
  /** Attaches the application to `container`. Calling it twice without `unmount` throws. */
  mount(container: HTMLElement): void;
  /** Detaches the application and releases the React root. Idempotent. */
  unmount(): void;
}

export function mountIridium(host: IridiumHost): IridiumApp {
  let root: Root | null = null;

  return {
    mount(container: HTMLElement): void {
      if (root !== null) {
        throw new Error('mountIridium: this application is already mounted; call unmount() first.');
      }
      root = createRoot(container);
      root.render(
        <StrictMode>
          <HostProvider host={host}>
            <AppShell />
          </HostProvider>
        </StrictMode>,
      );
    },
    unmount(): void {
      root?.unmount();
      root = null;
    },
  };
}
