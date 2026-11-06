/**
 * Architecture analysis types — layering violations and coupling metrics
 */

// ── Layering ─────────────────────────────────────────────────────────────────

/** A single import that crosses layer boundaries */
export interface LayeringViolation {
  file: string;
  fromPackage: string;
  fromLayer: number;
  toPackage: string;
  toLayer: number;
  importSpecifier: string;
}

export interface LayeringReport {
  violations: LayeringViolation[];
  totalViolations: number;
  affectedPackages: string[];
  /** Layer map used for analysis */
  layerMap: Record<string, number>;
}

// ── Coupling ──────────────────────────────────────────────────────────────────

export interface PackageCoupling {
  name: string;
  /** Afferent coupling: packages that depend on this */
  afferent: number;
  /** Efferent coupling: packages this depends on */
  efferent: number;
  /** Instability = Ce/(Ca+Ce). 0 = stable, 1 = unstable */
  instability: number;
}

export interface CouplingReport {
  packages: PackageCoupling[];
  avgInstability: number;
  mostUnstable: PackageCoupling[];
  mostCoupled: PackageCoupling[];
}
