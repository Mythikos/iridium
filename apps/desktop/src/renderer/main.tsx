/**
 * The Electron renderer entry (07-client-applications.md §2.5, §7.1).
 *
 * The same `@iridium/ui` application the browser tab mounts, with the other `IridiumHost` binding.
 * Nothing else is renderer-specific: `window.iridium` is the only platform object in scope, and it
 * carries no credential.
 */
import { mountIridium } from '@iridium/ui';

import '@iridium/ui/src/theme/tailwind.css';
import { createElectronHost } from './host/electron.ts';

const bridge = window.iridium;
if (bridge === undefined) {
  throw new Error('apps/desktop: window.iridium is missing; the preload did not run.');
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('apps/desktop: #root is missing from index.html.');
}

mountIridium(createElectronHost(bridge)).mount(container);
