/** Diagnostic CPU samples use Chromium's public DevTools Profiler, never a product hook. */
export async function startWorkerProfile(browser) {
  const connection = await browser.newBrowserCDPSession();
  const { targetInfos } = await connection.send('Target.getTargets');
  const worker = targetInfos.find(
    (target) => target.type === 'worker' && !target.url.includes('/uncapped/'),
  );
  if (worker === undefined) throw new Error('S11 profiling requires the live preview Worker.');
  const { sessionId } = await connection.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: false,
  });
  let nextId = 0;
  const pending = new Map();
  connection.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message);
    const waiting = pending.get(response.id);
    if (waiting === undefined) return;
    pending.delete(response.id);
    clearTimeout(waiting.timeout);
    if (response.error === undefined) waiting.resolve(response.result);
    else waiting.reject(new Error(JSON.stringify(response.error)));
  });
  async function send(method) {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`S11 profiler command timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timeout });
    });
    await connection.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id, method }),
    });
    return response;
  }
  await send('Profiler.enable');
  await send('Profiler.start');
  return async () => {
    const { profile } = await send('Profiler.stop');
    await connection.detach();
    return profile;
  };
}
