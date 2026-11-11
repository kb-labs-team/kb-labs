/**
 * Staleness detection with 3 criteria:
 * 1. Version mismatch
 * 2. Time-based (src newer than dist)
 * 3. Dependency staleness (dependency rebuilt after package)
 */

/**
 * Analyze staleness for a single package
 */
export function analyzeStaleness(pkgName, meta, graph, options) {
  const issues = [];

  // Criterion 1: Version Mismatch
  if (meta.distExists && meta.builtVersion && meta.builtVersion !== meta.version) {
    issues.push({
      type: 'version-mismatch',
      severity: 'error',
      message: `Built version ${meta.builtVersion} != current version ${meta.version}`,
      expected: meta.version,
      actual: meta.builtVersion,
    });
  }

  // Criterion 2: Time-based Staleness
  if (meta.distExists && meta.srcMtime && meta.distMtime) {
    if (meta.srcMtime > meta.distMtime) {
      const ageMs = meta.srcMtime - meta.distMtime;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      issues.push({
        type: 'source-newer',
        severity: 'warning',
        message: `Source modified ${ageDays.toFixed(1)} days after last build`,
        srcMtime: meta.srcMtime,
        distMtime: meta.distMtime,
        ageDays,
      });
    }
  }

  // Criterion 3: Dependency Staleness (CRITICAL!)
  const node = graph.get(pkgName);
  if (node && meta.distExists && meta.distMtime) {
    for (const [depName, depMeta] of node.dependencies) {
      if (!depMeta.distExists || !depMeta.distMtime) {continue;}

      // Check if dependency was rebuilt AFTER this package
      if (depMeta.distMtime > meta.distMtime) {
        const ageMs = depMeta.distMtime - meta.distMtime;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        issues.push({
          type: 'dependency-stale',
          severity: 'error',
          message: `Depends on ${depName} which was rebuilt ${ageDays.toFixed(1)} days ago`,
          dependency: depName,
          depDistMtime: depMeta.distMtime,
          thisDistMtime: meta.distMtime,
          ageDays,
        });
      }
    }
  }

  // Criterion 4: Never Built
  if (!meta.distExists) {
    issues.push({
      type: 'never-built',
      severity: 'warning',
      message: 'Package has never been built',
    });
  }

  // Criterion 5: Age Detection (if --age-days specified)
  if (options.ageDays && meta.distMtime) {
    const now = Date.now();
    const ageMs = now - meta.distMtime;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > options.ageDays) {
      issues.push({
        type: 'old-build',
        severity: 'info',
        message: `Built ${ageDays.toFixed(0)} days ago`,
        ageDays,
      });
    }
  }

  // Criterion 6: No Types Generation
  if (meta.distExists && !meta.hasDts) {
    issues.push({
      type: 'no-types',
      severity: 'info',
      message: 'Package has dts: false (no type generation)',
    });
  }

  return {
    pkgName,
    meta,
    issues,
    status: determineStatus(issues),
    impactScore: 0, // Will be calculated in propagation phase
  };
}

/**
 * Determine overall status from issues
 */
function determineStatus(issues) {
  if (issues.some((i) => i.type === 'never-built')) {return 'never-built';}
  if (issues.some((i) => i.severity === 'error')) {return 'stale';}
  if (issues.some((i) => i.severity === 'warning')) {return 'stale';}
  return 'fresh';
}
