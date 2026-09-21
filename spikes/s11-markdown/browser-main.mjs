let worker;
let ready;
let nextId = 0;

function spawn() {
  worker = new Worker(new URL('./browser-worker.mjs', import.meta.url), { type: 'module' });
  ready = new Promise((resolve, reject) => {
    worker.addEventListener(
      'error',
      (event) => reject(new Error(`${event.message} (${event.filename}:${event.lineno})`)),
      { once: true },
    );
    worker.addEventListener(
      'message',
      (event) => {
        if (event.data.ready) resolve();
      },
      { once: true },
    );
  });
  window.markdownReady = ready;
}
spawn();

/** Only this page's Worker imports the Markdown parser. */
window.measureMarkdown = async (task, timeoutMs, includeValue = false) => {
  await ready;
  const requestId = ++nextId;
  const started = performance.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      spawn();
      resolve({ status: 'timeout', roundtripMs: performance.now() - started });
    }, timeoutMs);
    worker.addEventListener(
      'message',
      (event) => {
        if (event.data.requestId !== requestId) return;
        clearTimeout(timer);
        const { value, ...summary } = event.data;
        resolve({
          ...summary,
          roundtripMs: performance.now() - started,
          blocks: value?.blocks?.length ?? null,
          ...(includeValue ? { value } : {}),
        });
      },
      { once: true },
    );
    worker.postMessage({ ...task, requestId }, []);
  });
};
