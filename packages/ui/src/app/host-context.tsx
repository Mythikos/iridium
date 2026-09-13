/**
 * `HostProvider` — the first provider `mountIridium` builds (07-client-applications.md §2.5).
 *
 * The application reaches the platform only through the `IridiumHost` it is given at mount time, so
 * this context is the only way a component obtains one. Nothing outside `mountIridium` touches
 * globals, which is what makes the Electron renderer and the browser tab identical from React's
 * point of view.
 */
import { createContext, use, type ReactNode } from 'react';

import type { IridiumHost } from '../host.ts';

const HostContext = createContext<IridiumHost | null>(null);

export interface HostProviderProps {
  readonly host: IridiumHost;
  readonly children: ReactNode;
}

export function HostProvider({ host, children }: HostProviderProps) {
  return <HostContext value={host}>{children}</HostContext>;
}

export function useHost(): IridiumHost {
  const host = use(HostContext);
  if (host === null) {
    throw new Error('useHost was called outside HostProvider: mountIridium builds it at the root.');
  }
  return host;
}
