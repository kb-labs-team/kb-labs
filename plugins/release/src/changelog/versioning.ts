/**
 * Version bump detection and SemVer policy implementation
 * Supports independent, ripple, and lockstep strategies
 */

import semver from 'semver';
import type { Change, VersionBump } from './types';

/**
 * Compute version bump from changes
 */
export function computeBump(changes: Change[]): VersionBump {
  const hasBreaking = changes.some(c => c.breaking && c.breaking.length > 0);
  const hasFeature = changes.some(c => c.type === 'feat');
  const hasFix = changes.some(c => ['fix', 'perf', 'refactor'].includes(c.type));
  
  if (hasBreaking) {return 'major';}
  if (hasFeature) {return 'minor';}
  if (hasFix) {return 'patch';}
  return 'none';
}

/**
 * Compute next version with optional pre-release
 */
export function computeNextVersion(
  currentVersion: string,
  bump: VersionBump,
  preid?: string
): string {
  if (bump === 'none') {
    return currentVersion;
  }
  
  if (preid) {
    // Pre-release version: 1.0.0 -> 1.1.0-rc.1
    const nextVersion = semver.inc(currentVersion, bump === 'major' ? 'major' : bump === 'minor' ? 'minor' : 'patch');
    if (!nextVersion) {return currentVersion;}
    
    // Check if already pre-release
    const prerelease = semver.prerelease(nextVersion);
    if (prerelease && prerelease[0] === preid) {
      // Increment pre-release number
      const number = prerelease[1] as number;
      return semver.inc(nextVersion, 'prerelease', preid) || nextVersion;
    }
    
    return `${nextVersion}-${preid}.1`;
  }
  
  return semver.inc(currentVersion, bump) || currentVersion;
}

/**
 * Get package impact reasons
 */
export function getImpactReason(changes: Change[]): {
  reason: 'breaking' | 'feat' | 'fix' | 'perf' | 'ripple' | 'manual';
  details?: string;
} {
  if (changes.some(c => c.breaking && c.breaking.length > 0)) {
    return { reason: 'breaking', details: 'Contains breaking changes' };
  }
  if (changes.some(c => c.type === 'feat')) {
    return { reason: 'feat', details: 'New features added' };
  }
  if (changes.some(c => c.type === 'fix')) {
    return { reason: 'fix', details: 'Bug fixes included' };
  }
  if (changes.some(c => c.type === 'perf')) {
    return { reason: 'perf', details: 'Performance improvements' };
  }
  return { reason: 'manual', details: 'Manual version bump' };
}

/**
 * Get ripple dependencies for a package
 */
export function getRipplePackages(
  packageName: string,
  dependencyGraph: Record<string, string[]>,
  visited: Set<string> = new Set()
): string[] {
  const ripple: string[] = [];
  
  if (visited.has(packageName)) {
    return ripple;
  }
  
  visited.add(packageName);
  
  // Find all packages that depend on this one
  for (const [pkg, deps] of Object.entries(dependencyGraph)) {
    if (deps.includes(packageName) && pkg !== packageName) {
      if (!ripple.includes(pkg)) {
        ripple.push(pkg);
      }
      
      // Recurse to find transitive dependencies
      const transitive = getRipplePackages(pkg, dependencyGraph, visited);
      for (const t of transitive) {
        if (!ripple.includes(t)) {
          ripple.push(t);
        }
      }
    }
  }
  
  return ripple;
}

/**
 * Apply version policy (independent, ripple, or lockstep)
 */
export function applyVersionPolicy(
  changes: Change[],
  affectedPackages: string[],
  currentVersions: Record<string, string>,
  policy: 'independent' | 'ripple' | 'lockstep',
  dependencyGraph?: Record<string, string[]>
): Record<string, {
  nextVersion: string;
  bump: VersionBump;
  reason: 'breaking' | 'feat' | 'fix' | 'perf' | 'ripple' | 'manual';
  rippleFrom?: string[];
}> {
  const result: Record<string, any> = {};
  
  // Group changes by package
  const changesByPackage: Record<string, Change[]> = {};
  for (const change of changes) {
    for (const pkg of change.packages) {
      if (!changesByPackage[pkg]) {
        changesByPackage[pkg] = [];
      }
      changesByPackage[pkg].push(change);
    }
  }
  
  if (policy === 'independent') {
    // Each package versions independently
    for (const pkg of affectedPackages) {
      const pkgChanges = changesByPackage[pkg] || [];
      const bump = computeBump(pkgChanges);
      const reasonInfo = getImpactReason(pkgChanges);
      const currentVersion = currentVersions[pkg] || '0.0.0';
      const nextVersion = computeNextVersion(currentVersion, bump);
      
      result[pkg] = {
        nextVersion,
        bump,
        reason: reasonInfo.reason,
      };
    }
  } else if (policy === 'ripple' && dependencyGraph) {
    // Ripple bump dependent packages
    const ripplePackages = new Set<string>();
    
    for (const pkg of affectedPackages) {
      const pkgChanges = changesByPackage[pkg] || [];
      const bump = computeBump(pkgChanges);
      const reasonInfo = getImpactReason(pkgChanges);
      const currentVersion = currentVersions[pkg] || '0.0.0';
      const nextVersion = computeNextVersion(currentVersion, bump);
      
      result[pkg] = {
        nextVersion,
        bump,
        reason: reasonInfo.reason,
      };
      
      // Find ripple dependents
      const ripple = getRipplePackages(pkg, dependencyGraph);
      for (const rpkg of ripple) {
        ripplePackages.add(rpkg);
      }
    }
    
    // Apply ripple bumps
    for (const pkg of ripplePackages) {
      if (!result[pkg]) {
        const currentVersion = currentVersions[pkg] || '0.0.0';
        const nextVersion = computeNextVersion(currentVersion, 'patch');
        
        result[pkg] = {
          nextVersion,
          bump: 'patch' as VersionBump,
          reason: 'ripple' as const,
          rippleFrom: Array.from(affectedPackages),
        };
      }
    }
  } else if (policy === 'lockstep') {
    // All packages share same version
    const allChanges = Object.values(changesByPackage).flat();
    const bump = computeBump(allChanges);
    const reasonInfo = getImpactReason(allChanges);
    
    // Find highest current version
    let highestVersion = '0.0.0';
    for (const version of Object.values(currentVersions)) {
      if (semver.gt(version, highestVersion)) {
        highestVersion = version;
      }
    }
    
    const nextVersion = computeNextVersion(highestVersion, bump);
    
    for (const pkg of affectedPackages) {
      result[pkg] = {
        nextVersion,
        bump,
        reason: reasonInfo.reason,
      };
    }
  }
  
  return result;
}

/**
 * Get affected packages from changes
 */
export function getAffectedPackages(changes: Change[]): string[] {
  const packages = new Set<string>();
  
  for (const change of changes) {
    for (const pkg of change.packages) {
      packages.add(pkg);
    }
  }
  
  return Array.from(packages);
}


