/**
 * @module @kb-labs/review/heuristic/runner
 * Linter runner - executes linters via CLI and collects findings.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, extname, relative } from 'path';
import type { ReviewFinding } from '../contracts/index.js';
import type { LinterEngine, LinterResult } from './engines/types.js';
import { LINTER_ENGINES } from './engines/index.js';

/**
 * Linter runner configuration.
 */
export interface LinterRunnerConfig {
  /** Custom engines to use (defaults to all available) */
  engines?: LinterEngine[];

  /** Maximum buffer size for CLI output (default: 10MB) */
  maxBuffer?: number;

  /** Timeout for each linter run in ms (default: 60000) */
  timeout?: number;
}

/**
 * Linter runner.
 *
 * Executes linters via CLI subprocess and parses their JSON output.
 */
export class LinterRunner {
  private engines: Map<string, LinterEngine>;
  private maxBuffer: number;
  private timeout: number;

  constructor(config: LinterRunnerConfig = {}) {
    const engineList = config.engines ?? LINTER_ENGINES;
    this.engines = new Map(engineList.map(e => [e.id, e]));
    this.maxBuffer = config.maxBuffer ?? 10 * 1024 * 1024; // 10MB
    this.timeout = config.timeout ?? 60000; // 60s
  }

  /**
   * Find project root for a file based on engine's config files.
   */
  findProjectRoot(file: string, engine: LinterEngine): string {
    let dir = dirname(file);
    const root = '/';

    while (dir !== root && dir.length > 1) {
      for (const configFile of engine.configFiles) {
        if (existsSync(join(dir, configFile))) {
          return dir;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }

    // Fallback to file's directory
    return dirname(file);
  }

  /**
   * Run a specific linter on files.
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- Complex orchestration of linter execution with error handling, config discovery, and result processing
  async runEngine(engineId: string, files: string[]): Promise<LinterResult> {
    const startTime = Date.now();
    const engine = this.engines.get(engineId);

    if (!engine) {
      return {
        engineId,
        findings: [],
        files,
        durationMs: Date.now() - startTime,
        error: `Unknown engine: ${engineId}`,
      };
    }

    // Filter files by extension
    const relevantFiles = files.filter(f =>
      engine.extensions.includes(extname(f))
    );

    if (relevantFiles.length === 0) {
      return {
        engineId,
        findings: [],
        files: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Group files by project root
    const filesByRoot = new Map<string, string[]>();
    for (const file of relevantFiles) {
      const root = this.findProjectRoot(file, engine);
      const group = filesByRoot.get(root) ?? [];
      group.push(file);
      filesByRoot.set(root, group);
    }

    // Run linter for each project root
    const allFindings: ReviewFinding[] = [];
    const errors: string[] = [];

    for (const [projectRoot, groupFiles] of filesByRoot) {
      try {
        // Make file paths relative to project root
        // Input files might be relative to a different cwd (e.g., monorepo root)
        // We need them relative to the project root where we'll run the linter
        const relativeFiles = groupFiles.map(f => {
          // If the file path starts with the project root, strip it
          if (f.startsWith(projectRoot + '/')) {
            return f.slice(projectRoot.length + 1);
          }
          // Otherwise, try to make it relative
          return relative(projectRoot, f) || f;
        });

        const [cmd, ...args] = engine.buildCommand(relativeFiles, projectRoot);
        const proc = spawnSync(cmd!, args, {
          cwd: projectRoot,
          encoding: 'utf-8',
          maxBuffer: this.maxBuffer,
          timeout: this.timeout,
        });

        if (proc.error) {
          errors.push(`${projectRoot}: ${proc.error.message}`);
          continue;
        }

        // Most linters exit non-zero when they find issues but still write JSON to stdout
        const output = proc.stdout ?? '';

        // Parse output
        if (output && output.trim()) {
          try {
            const findings = engine.parseOutput(output, projectRoot);
            allFindings.push(...findings);
          } catch (parseError: unknown) {
            const err = parseError as { message?: string };
            errors.push(`${projectRoot}: Failed to parse output: ${err.message ?? 'Unknown error'}`);
          }
        }
      } catch (error: unknown) {
        const err = error as { message?: string };
        errors.push(`${projectRoot}: ${err.message ?? 'Unknown error'}`);
      }
    }

    return {
      engineId,
      findings: allFindings,
      files: relevantFiles,
      durationMs: Date.now() - startTime,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  /**
   * Run all applicable linters on files.
   */
  async runAll(files: string[]): Promise<LinterResult[]> {
    const results: LinterResult[] = [];

    // Find which engines have relevant files
    const enginesWithFiles = new Set<string>();
    for (const file of files) {
      const ext = extname(file);
      for (const engine of this.engines.values()) {
        if (engine.extensions.includes(ext)) {
          enginesWithFiles.add(engine.id);
        }
      }
    }

    // Run each engine
    for (const engineId of enginesWithFiles) {
      // eslint-disable-next-line no-await-in-loop -- Sequential engine execution for resource control
      const result = await this.runEngine(engineId, files);
      results.push(result);
    }

    return results;
  }

  /**
   * Get all findings from multiple engine results.
   */
  static collectFindings(results: LinterResult[]): ReviewFinding[] {
    return results.flatMap(r => r.findings);
  }
}

/**
 * Quick helper to run all linters on files.
 */
export async function runLinters(files: string[]): Promise<ReviewFinding[]> {
  const runner = new LinterRunner();
  const results = await runner.runAll(files);
  return LinterRunner.collectFindings(results);
}

/**
 * Quick helper to run a specific linter.
 */
export async function runLinter(engineId: string, files: string[]): Promise<ReviewFinding[]> {
  const runner = new LinterRunner();
  const result = await runner.runEngine(engineId, files);
  return result.findings;
}
