/**
 * The web host entry (07-client-applications.md §2.5, §6.1).
 *
 * `apps/web` contains almost nothing: this entry, `src/host/browser.ts`, the `index.html` shell and
 * a Vite config that extends the shared renderer configuration. Everything a user sees is
 * `@iridium/ui`, reached through the one `IridiumHost` this file constructs.
 */
import { mountIridium } from '@iridium/ui';

import '@iridium/ui/src/theme/tailwind.css';
import { createBrowserHost } from './host/browser.ts';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('apps/web: #root is missing from index.html.');
}

mountIridium(createBrowserHost()).mount(container);
