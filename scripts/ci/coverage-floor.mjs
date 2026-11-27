export function checkCoverageFloor(result, floor) {
  const packages = new Map(result.packages.map((pkg) => [pkg.package, pkg]));
  const violations = [];

  for (const [packageName, metrics] of Object.entries(floor.metrics)) {
    const pkg = packages.get(packageName);
    if (!pkg) {
      violations.push({ type: 'missing-package', package: packageName });
      continue;
    }

    for (const [metric, minimum] of Object.entries(metrics)) {
      const measured = pkg[metric];
      if (!measured || !Number.isFinite(measured.pct) || !Number.isFinite(measured.total)
          || (measured.total === 0 && minimum > 0)) {
        violations.push({ type: 'missing-metric', package: packageName, metric, minimum });
      } else if (measured.pct < minimum) {
        violations.push({ type: 'regression', package: packageName, metric, actual: measured.pct, minimum });
      }
    }
  }

  return violations;
}

export function findNewThresholdViolations(violations, floor) {
  return violations.filter(({ package: packageName, metric }) => {
    const acceptedMinimum = floor.metrics[packageName]?.[metric];
    return !Number.isFinite(acceptedMinimum);
  });
}

export function countAcceptedThresholdViolations(violations, floor) {
  return violations.filter(({ package: packageName, metric, actual }) => {
    const acceptedMinimum = floor.metrics[packageName]?.[metric];
    return Number.isFinite(acceptedMinimum) && actual >= acceptedMinimum;
  }).length;
}
