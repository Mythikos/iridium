/**
 * The renderer half of spike S3. Runs on every load of the harness page and, for each target the
 * main process passed in the query string, issues one `fetch()` and opens one `WebSocket`. What the
 * server sees is the answer; what this file reports is only the renderer's own view of the same
 * events (its origin, and whether the call succeeded or was refused before it left the process).
 */
/* eslint-disable no-console -- console is the harness's transport: the main process mirrors every
   line into the event log, which is the only channel a sandboxed page with no preload has. */
const params = new URLSearchParams(location.search);
const leg = params.get('leg') ?? 'unknown';
const targets = JSON.parse(params.get('targets') ?? '[]');
const control = params.get('control') ?? '';
const pushPath = params.get('push');

const out = document.getElementById('out');
const lines = [];

function emit(entry) {
  lines.push(entry);
  // The main process mirrors every console line into the harness log, so a leg whose network is
  // blocked outright still reports.
  console.log(`[S03]${JSON.stringify(entry)}`);
  out.textContent = lines.map((l) => JSON.stringify(l)).join('\n');
}

function pageFacts(phase) {
  return {
    type: 'page',
    phase,
    leg,
    href: location.href,
    locationOrigin: location.origin,
    windowOrigin: window.origin,
    documentOrigin: document.location.origin,
    isSecureContext,
    crossOriginIsolated,
    protocol: location.protocol,
    host: location.host,
    port: location.port,
  };
}

document.addEventListener('securitypolicyviolation', (event) => {
  emit({
    type: 'csp-violation',
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
    policy: event.originalPolicy,
  });
});

/**
 * Not part of the register row, but decided by the same CSP the shell already ships: `packagedCsp()`
 * builds `connect-src` from the active profile alone and never adds `'self'`, so this asks whether the
 * renderer can `fetch()` an asset of its own origin.
 */
async function sameOriginProbe() {
  try {
    const res = await fetch('/probe.js', { cache: 'no-store' });
    const body = await res.text();
    emit({ type: 'same-origin-fetch', ok: res.ok, status: res.status, bytes: body.length });
  } catch (error) {
    emit({ type: 'same-origin-fetch', ok: false, error: String(error) });
  }
}

async function fetchProbe(target) {
  const probe = `${leg}:${target.id}:fetch`;
  const started = performance.now();
  try {
    const res = await fetch(`${target.http}/meta?probe=${encodeURIComponent(probe)}`, {
      cache: 'no-store',
    });
    const body = await res.json();
    emit({
      type: 'fetch',
      probe,
      target: target.id,
      ok: true,
      status: res.status,
      serverSawOrigin: body.origin ?? null,
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    emit({
      type: 'fetch',
      probe,
      target: target.id,
      ok: false,
      error: String(error),
      ms: Math.round(performance.now() - started),
    });
  }
}

function wsProbe(target) {
  const probe = `${leg}:${target.id}:ws`;
  return new Promise((resolve) => {
    const started = performance.now();
    let socket;
    try {
      socket = new WebSocket(`${target.ws}/collab?probe=${encodeURIComponent(probe)}`);
    } catch (error) {
      emit({
        type: 'ws',
        probe,
        target: target.id,
        ok: false,
        phase: 'construct',
        error: String(error),
      });
      resolve();
      return;
    }
    socket.binaryType = 'arraybuffer';
    const done = (entry) => {
      emit({
        ...entry,
        type: 'ws',
        probe,
        target: target.id,
        ms: Math.round(performance.now() - started),
      });
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    const timer = setTimeout(() => {
      done({ ok: false, phase: 'timeout', readyState: socket.readyState });
    }, 8000);
    socket.addEventListener('open', () => {
      socket.send(new Uint8Array([1, 2, 3, 4]));
    });
    socket.addEventListener('message', (event) => {
      emit({
        type: 'ws-first-message',
        probe,
        target: target.id,
        serverSawOrigin: typeof event.data === 'string' ? JSON.parse(event.data).origin : null,
      });
    });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      done({
        ok: event.code === 4001,
        phase: 'close',
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });
    socket.addEventListener('error', () => {
      // The event carries nothing by design; the close event that follows carries the code.
      emit({ type: 'ws-error', probe, target: target.id, readyState: socket.readyState });
    });
  });
}

async function main() {
  emit(pageFacts('load'));
  if (pushPath !== null && pushPath !== '') {
    history.pushState({}, '', pushPath);
    emit(pageFacts('after-pushState'));
  }
  await sameOriginProbe();
  for (const target of targets) {
    // oxlint-disable-next-line no-await-in-loop -- targets are probed in order so the emitted log stays a strict per-target sequence matching the register's per-leg layout
    await fetchProbe(target);
    // oxlint-disable-next-line no-await-in-loop -- this target's ws probe follows its own fetch probe so the two request kinds stay paired before the next target starts
    await wsProbe(target);
  }
  if (control !== '') {
    const data = encodeURIComponent(JSON.stringify({ leg, lines }));
    try {
      await fetch(`${control}/report?probe=${encodeURIComponent(`${leg}:report`)}&data=${data}`, {
        cache: 'no-store',
      });
    } catch (error) {
      console.log(`[S03]${JSON.stringify({ type: 'report-failed', leg, error: String(error) })}`);
    }
  }
  console.log('[S03-DONE]');
}

void main();
