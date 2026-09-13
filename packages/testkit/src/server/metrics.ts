/**
 * Parsing `GET /metrics` (`TestServer.metrics()`).
 *
 * The Prometheus text exposition format is line-oriented and small here, so the harness parses it
 * rather than pulling in a client library: the suites assert on named series
 * (`iridium_http_requests_total`, `compaction_failures_total`, `projection_timeouts_total`, …), and a
 * counter that did *not* move is as much of an assertion as one that did — CH-11 asserts exactly that
 * about `projection_timeouts_total`.
 */

export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** Keys are the series as written: `name` when unlabelled, `name{a="1",b="2"}` otherwise. */
export type MetricsSnapshot = Readonly<Record<string, number>>;

const LINE = /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?<labels>\{.*\})?\s+(?<value>\S+)(?:\s+\d+)?$/;

function parseLabels(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw === '{}') {
    return {};
  }
  const labels: Record<string, string> = {};
  const inner = raw.slice(1, -1);
  // Label values are quoted and may contain escaped quotes and commas.
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  for (const match of inner.matchAll(pattern)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      labels[key] = value.replaceAll('\\"', '"').replaceAll('\\n', '\n').replaceAll('\\\\', '\\');
    }
  }
  return labels;
}

function parseValue(raw: string): number {
  if (raw === '+Inf') {
    return Number.POSITIVE_INFINITY;
  }
  if (raw === '-Inf') {
    return Number.NEGATIVE_INFINITY;
  }
  return Number(raw);
}

/** Every sample in the document, in file order. */
export function parseMetricSamples(text: string): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = LINE.exec(line);
    const name = match?.groups?.['name'];
    const value = match?.groups?.['value'];
    if (name === undefined || value === undefined) {
      continue;
    }
    samples.push({
      name,
      labels: parseLabels(match?.groups?.['labels']),
      value: parseValue(value),
    });
  }
  return samples;
}

/** The flat `Record<string, number>` shape `TestServer.metrics()` returns. */
export function parseMetrics(text: string): MetricsSnapshot {
  const snapshot: Record<string, number> = {};
  for (const sample of parseMetricSamples(text)) {
    const entries = Object.entries(sample.labels).toSorted(([a], [b]) => a.localeCompare(b));
    const key =
      entries.length === 0
        ? sample.name
        : `${sample.name}{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
    snapshot[key] = sample.value;
  }
  return snapshot;
}

/** The sum of every series of a metric, which is what a "did this counter move" assertion wants. */
export function metricTotal(text: string, name: string): number {
  return parseMetricSamples(text)
    .filter((sample) => sample.name === name)
    .reduce((total, sample) => total + sample.value, 0);
}
