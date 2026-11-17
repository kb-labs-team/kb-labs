export function percentiles(samples) {
  if (!Array.isArray(samples) || !samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('percentiles requires a non-empty array of finite non-negative durations');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = p => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: sorted.length, p50_ms: at(0.50), p95_ms: at(0.95), p99_ms: at(0.99) };
}

export function median(values) {
  if (!Array.isArray(values) || !values.length || values.some(value => !Number.isFinite(value))) {
    throw new Error('median requires a non-empty array of finite numbers');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
