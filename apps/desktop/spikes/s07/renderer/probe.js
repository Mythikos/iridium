/**
 * Spike S07 — the renderer probes, loaded from `app://iridium/probe.js` under
 * `script-src 'self'` so the page runs under the same CSP shape a packaged load carries.
 *
 * Every probe resolves; nothing throws. `securitypolicyviolation` is recorded separately so a CSP
 * refusal can never be misread as a TLS failure.
 *
 * Throwaway harness for `docs/spikes/S07-electron-enterprise-ca.md`.
 */
const cspViolations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  cspViolations.push({
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
  });
});

const TIMEOUT_MS = 10_000;

async function probeFetch(url) {
  const started = performance.now();
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const body = await response.text();
    return { ok: true, status: response.status, body, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      error: `${error.name}: ${error.message}`,
      ms: Math.round(performance.now() - started),
    };
  }
}

function probeWebSocket(url) {
  const started = performance.now();
  return new Promise((resolve) => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let socket;
    const settle = (value) => {
      controller.abort();
      if (socket !== undefined) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      resolve({ ...value, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => {
      settle({ ok: false, error: 'timeout' });
    }, TIMEOUT_MS);
    try {
      socket = new WebSocket(url);
    } catch (error) {
      clearTimeout(timer);
      settle({ ok: false, error: `${error.name}: ${error.message}` });
      return;
    }
    socket.addEventListener(
      'open',
      () => {
        socket.send('s07');
      },
      options,
    );
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        settle({ ok: true, echoed: String(event.data) });
      },
      options,
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        settle({ ok: false, error: 'websocket error event' });
      },
      options,
    );
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        settle({ ok: false, error: `close ${event.code} clean=${event.wasClean}` });
      },
      options,
    );
  });
}

function probeImage(url) {
  const started = performance.now();
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => {
      resolve({ ok: false, error: 'timeout', ms: Math.round(performance.now() - started) });
    }, TIMEOUT_MS);
    image.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        resolve({
          ok: true,
          width: image.naturalWidth,
          ms: Math.round(performance.now() - started),
        });
      },
      { once: true },
    );
    image.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        resolve({ ok: false, error: 'error event', ms: Math.round(performance.now() - started) });
      },
      { once: true },
    );
    image.src = url;
  });
}

async function runProbe(probe) {
  if (probe.kind === 'fetch') return { ...probe, ...(await probeFetch(probe.url)) };
  if (probe.kind === 'ws') return { ...probe, ...(await probeWebSocket(probe.url)) };
  return { ...probe, ...(await probeImage(probe.url)) };
}

window.s07.onStage(async (stage) => {
  document.getElementById('status').textContent = `stage ${stage.name}`;
  const probes = [];
  // oxlint-disable-next-line no-await-in-loop -- probes run one at a time so the stage report preserves the fixed per-probe order the spike's evidence relies on
  for (const probe of stage.probes) probes.push(await runProbe(probe));
  const drained = cspViolations.splice(0, cspViolations.length);
  await window.s07.report({ stage: stage.name, probes, cspViolations: drained });
});

void window.s07.ready();
