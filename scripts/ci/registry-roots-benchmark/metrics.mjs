export function unwrapCliEnvelope(envelope) {
  if (!envelope || envelope.ok !== true || !envelope.json || typeof envelope.json !== 'object') {
    throw new Error('DevKit CLI returned an invalid or unsuccessful JSON envelope');
  }
  const payload = envelope.json;
  if (!Array.isArray(payload.results) || payload.results.length === 0) {
    throw new Error('DevKit CLI JSON envelope has no task results');
  }
  if (!payload.summary || !Number.isInteger(payload.summary.scheduled) || payload.summary.scheduled <= 0) {
    throw new Error('DevKit CLI JSON envelope has no valid scheduled task count');
  }
  if (!Number.isInteger(payload.summary.blocked) || !Number.isInteger(payload.summary.notAffected)) {
    throw new Error('DevKit CLI JSON envelope has incomplete scheduled-task accounting');
  }
  const accountedRows = payload.results.length + payload.summary.blocked + payload.summary.notAffected;
  if (payload.summary.scheduled !== accountedRows) {
    throw new Error(`DevKit task count mismatch: scheduled=${payload.summary.scheduled}, accounted=${accountedRows}`);
  }
  if (typeof payload.elapsed !== 'string') throw new Error('DevKit CLI JSON envelope has no elapsed duration');
  return payload;
}

export function summarizeTaskRows(rows) {
  const packageName = row => row.Package ?? row.package ?? null;
  const cached = row => row.Cached ?? row.cached ?? false;
  const cacheHits = rows.filter(cached).length;
  const taskResultRows = rows.length;
  const hitRatio = taskResultRows === 0 ? null : cacheHits / taskResultRows;
  return {
    task_result_rows: taskResultRows,
    cache_hits_from_task_rows: cacheHits,
    non_cached_task_rows: taskResultRows - cacheHits,
    task_row_cache_hit_ratio: hitRatio,
    cache_hit_status: taskResultRows === 0
      ? 'no_task_rows'
      : cacheHits === 0
        ? 'no_hits'
        : cacheHits === taskResultRows
          ? 'all_result_rows_cached'
          : 'partial',
    packages: [...new Set(rows.map(packageName).filter(Boolean))].sort(),
  };
}

export function summarizeRootClosure(roots, resultPackages) {
  const observed = new Set(resultPackages);
  const missingRoots = roots.filter(name => !observed.has(name));
  if (missingRoots.length > 0) {
    throw new Error(`Registry roots absent from actual DevKit task results: ${missingRoots.join(', ')}`);
  }
  const rootSet = new Set(roots);
  const dependencyClosurePackages = resultPackages.filter(name => !rootSet.has(name));
  return {
    requested_root_count: roots.length,
    requested_roots_present_in_results: roots.length,
    dependency_closure_package_count: dependencyClosurePackages.length,
    dependency_closure_packages: dependencyClosurePackages,
    missing_roots: [],
  };
}
