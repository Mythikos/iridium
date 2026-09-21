import { toPreviewTree } from '@iridium/markdown';

import { measurePipeline } from './pipeline.mjs';

function previewResult(parsed) {
  const { blocks, outline, diagnostics } = toPreviewTree(parsed);
  // 08 §2.11 PreviewResult transfers block hast, not the additional export-oriented root.
  return { blocks, outline, diagnostics };
}

// Every preview block crosses postMessage, including its complete sanitized hast.
self.addEventListener('message', ({ data }) => {
  try {
    self.postMessage({ requestId: data.requestId, ...measurePipeline(data, previewResult) }, []);
  } catch (error) {
    self.postMessage({ requestId: data.requestId, status: 'error', error: String(error) }, []);
  }
});
self.postMessage({ ready: true }, []);
