import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  RepositoryDiagnosticsProvider,
  RepositoryProbe,
  RepositoryProbeObservation,
} from '../sdk/index.js';
import type {
  RepositoryFingerprints,
  RepositoryModel,
  RepositorySignal,
  RepositoryTopology,
} from '../contracts/index.js';

export function createBuiltInRepositoryProbes(): RepositoryProbe[] {
  return [
    createTopologyProbe(),
    createConventionsProbe(),
    createJavascriptTypescriptProbe(),
    createPythonProbe(),
    createGoProbe(),
    createPhpProbe(),
    createJvmProbe(),
    createRustProbe(),
    createRubyProbe(),
    createGenericLayoutProbe(),
  ];
}

export function createDefaultRepositoryDiagnosticsProvider(input?: {
  probes?: RepositoryProbe[];
}): RepositoryDiagnosticsProvider {
  return {
    id: 'default-repository-diagnostics',
    async describe({ workingDir, mode, profile, kernel }) {
      const fileNames = await safeReadDirNames(workingDir);
      const probes = input?.probes ?? createBuiltInRepositoryProbes();
      let observation: RepositoryProbeObservation = {};

      for (const probe of probes) {
        const next = await probe.probe({
          workingDir,
          mode,
          profile,
          kernel,
          fileNames,
        });
        if (next) {
          observation = mergeObservation(observation, next);
        }
      }

      return {
        topology: observation.topology ?? 'unknown',
        stack: buildStackFromFingerprints(observation.fingerprints),
        fingerprints: normalizeFingerprints(observation.fingerprints),
        workspace: {
          rootPath: workingDir,
          packageRoots: uniqueArray(observation.workspace?.packageRoots ?? []),
          appRoots: uniqueArray(observation.workspace?.appRoots ?? []),
          libraryRoots: uniqueArray(observation.workspace?.libraryRoots ?? []),
          infraRoots: uniqueArray(observation.workspace?.infraRoots ?? []),
          docsRoots: uniqueArray(observation.workspace?.docsRoots ?? []),
        },
        conventions: {
          hasAdr: observation.conventions?.hasAdr ?? false,
          hasOpenApi: observation.conventions?.hasOpenApi ?? false,
          hasCi: observation.conventions?.hasCi ?? false,
          hasLinting: observation.conventions?.hasLinting ?? false,
          hasFormatting: observation.conventions?.hasFormatting ?? false,
        },
        riskSignals: uniqueArray(observation.riskSignals ?? []),
        detectedAt: new Date().toISOString(),
        sources: uniqueArray(observation.sources ?? []),
      };
    },
  };
}

function createTopologyProbe(): RepositoryProbe {
  return {
    id: 'topology-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      let topology: RepositoryTopology = 'unknown';
      if (has('pnpm-workspace.yaml') || has('turbo.json') || has('nx.json') || has('lerna.json')) {
        topology = 'monorepo';
      } else if (has('package.json') || has('pyproject.toml') || has('go.mod') || has('composer.json') || has('Cargo.toml') || has('Gemfile') || has('pom.xml') || has('build.gradle')) {
        topology = 'single-package';
      }

      return {
        topology,
        sources: [
          ...[
            'pnpm-workspace.yaml',
            'turbo.json',
            'nx.json',
            'lerna.json',
            'package.json',
            'pyproject.toml',
            'go.mod',
            'composer.json',
            'Cargo.toml',
            'Gemfile',
            'pom.xml',
            'build.gradle',
          ]
            .filter((name) => has(name))
            .map((name) => path.join(workingDir, name)),
        ],
      };
    },
  };
}

function createConventionsProbe(): RepositoryProbe {
  return {
    id: 'conventions-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      return {
        conventions: {
          hasAdr: has('docs') || has('adr'),
          hasOpenApi: ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json'].some(has),
          hasCi: has('.github') || has('.gitlab-ci.yml') || has('.circleci'),
          hasLinting: [
            '.eslintrc',
            '.eslintrc.js',
            '.eslintrc.cjs',
            '.flake8',
            'ruff.toml',
            'phpcs.xml',
            'golangci.yml',
            'golangci.yaml',
          ].some(has),
          hasFormatting: [
            '.prettierrc',
            '.prettierrc.js',
            'prettier.config.js',
            'ruff.toml',
            'php-cs-fixer.php',
            '.php-cs-fixer.php',
            'rustfmt.toml',
          ].some(has),
        },
        workspace: {
          docsRoots: has('docs') ? [path.join(workingDir, 'docs')] : [],
        },
      };
    },
  };
}

function createJavascriptTypescriptProbe(): RepositoryProbe {
  return {
    id: 'js-ts-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      const fingerprints: Partial<RepositoryFingerprints> = {
        ecosystems: mergeSignals(
          createSignal(has('package.json'), 'javascript-ecosystem', 0.72, workingDir, 'package.json'),
          createSignal(has('tsconfig.json'), 'typescript-ecosystem', 0.84, workingDir, 'tsconfig.json'),
        ),
        languages: mergeSignals(
          createSignal(has('package.json'), 'javascript', 0.7, workingDir, 'package.json'),
          createSignal(has('tsconfig.json') || has('tsup.config.ts') || has('vite.config.ts'), 'typescript', 0.9, workingDir, 'tsconfig.json'),
        ),
        runtimes: createSignal(has('package.json'), 'node', 0.82, workingDir, 'package.json'),
        packageManagers: mergeSignals(
          createSignal(has('pnpm-lock.yaml') || has('pnpm-workspace.yaml'), 'pnpm', 0.95, workingDir, 'pnpm-lock.yaml'),
          createSignal(has('package-lock.json'), 'npm', 0.92, workingDir, 'package-lock.json'),
          createSignal(has('yarn.lock'), 'yarn', 0.92, workingDir, 'yarn.lock'),
          createSignal(has('bun.lockb') || has('bun.lock'), 'bun', 0.9, workingDir, 'bun.lockb'),
        ),
        buildTools: mergeSignals(
          createSignal(has('turbo.json'), 'turbo', 0.92, workingDir, 'turbo.json'),
          createSignal(has('nx.json'), 'nx', 0.92, workingDir, 'nx.json'),
          createSignal(has('tsup.config.ts'), 'tsup', 0.9, workingDir, 'tsup.config.ts'),
          createSignal(has('vite.config.ts') || has('vite.config.js'), 'vite', 0.9, workingDir, 'vite.config.ts'),
        ),
        testTools: mergeSignals(
          createSignal(has('vitest.config.ts') || has('vitest.config.js'), 'vitest', 0.92, workingDir, 'vitest.config.ts'),
          createSignal(has('jest.config.js') || has('jest.config.ts'), 'jest', 0.9, workingDir, 'jest.config.js'),
          createSignal(has('playwright.config.ts') || has('playwright.config.js'), 'playwright', 0.9, workingDir, 'playwright.config.ts'),
        ),
        frameworks: mergeSignals(
          createSignal(has('next.config.js') || has('next.config.mjs') || has('next.config.ts'), 'next', 0.92, workingDir, 'next.config.js'),
          createSignal(has('nuxt.config.ts') || has('nuxt.config.js'), 'nuxt', 0.92, workingDir, 'nuxt.config.ts'),
          createSignal(has('astro.config.mjs') || has('astro.config.js') || has('astro.config.ts'), 'astro', 0.92, workingDir, 'astro.config.mjs'),
          createSignal(has('svelte.config.js') || has('svelte.config.mjs'), 'svelte', 0.88, workingDir, 'svelte.config.js'),
        ),
      };

      return {
        fingerprints,
        workspace: {
          packageRoots: mapExistingRoots(workingDir, fileNames, ['packages']),
          appRoots: mapExistingRoots(workingDir, fileNames, ['apps', 'services']),
          libraryRoots: mapExistingRoots(workingDir, fileNames, ['libs', 'lib']),
        },
      };
    },
  };
}

function createPythonProbe(): RepositoryProbe {
  return {
    id: 'python-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      const detected = has('pyproject.toml') || has('requirements.txt') || has('requirements-dev.txt') || has('poetry.lock');
      return {
        fingerprints: {
          ecosystems: createSignal(detected, 'python-ecosystem', 0.9, workingDir, 'pyproject.toml'),
          languages: createSignal(detected, 'python', 0.95, workingDir, has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt'),
          runtimes: createSignal(detected, 'python', 0.95, workingDir, has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt'),
          packageManagers: mergeSignals(
            createSignal(has('poetry.lock'), 'poetry', 0.94, workingDir, 'poetry.lock'),
            createSignal(has('requirements.txt') || has('requirements-dev.txt'), 'pip', 0.88, workingDir, 'requirements.txt'),
          ),
          testTools: mergeSignals(
            createSignal(has('pytest.ini') || has('conftest.py'), 'pytest', 0.9, workingDir, has('pytest.ini') ? 'pytest.ini' : 'conftest.py'),
          ),
        },
        workspace: {
          appRoots: mapExistingRoots(workingDir, fileNames, ['src', 'app']),
          libraryRoots: mapExistingRoots(workingDir, fileNames, ['src']),
        },
      };
    },
  };
}

function createGoProbe(): RepositoryProbe {
  return {
    id: 'go-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      const detected = has('go.mod');
      return {
        fingerprints: {
          ecosystems: createSignal(detected, 'go-ecosystem', 0.95, workingDir, 'go.mod'),
          languages: createSignal(detected, 'go', 0.98, workingDir, 'go.mod'),
          runtimes: createSignal(detected, 'go', 0.98, workingDir, 'go.mod'),
          buildTools: createSignal(detected && has('Makefile'), 'make', 0.8, workingDir, 'Makefile'),
          testTools: createSignal(detected, 'go-test', 0.72, workingDir, 'go.mod'),
        },
        workspace: {
          appRoots: mapExistingRoots(workingDir, fileNames, ['cmd']),
          libraryRoots: mapExistingRoots(workingDir, fileNames, ['internal', 'pkg']),
        },
      };
    },
  };
}

function createPhpProbe(): RepositoryProbe {
  return {
    id: 'php-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      const detected = has('composer.json') || has('composer.lock');
      return {
        fingerprints: {
          ecosystems: createSignal(detected, 'php-ecosystem', 0.92, workingDir, has('composer.json') ? 'composer.json' : 'composer.lock'),
          languages: createSignal(detected, 'php', 0.96, workingDir, has('composer.json') ? 'composer.json' : 'composer.lock'),
          runtimes: createSignal(detected, 'php', 0.96, workingDir, has('composer.json') ? 'composer.json' : 'composer.lock'),
          packageManagers: createSignal(detected, 'composer', 0.96, workingDir, has('composer.json') ? 'composer.json' : 'composer.lock'),
          testTools: createSignal(has('phpunit.xml') || has('phpunit.xml.dist'), 'phpunit', 0.92, workingDir, has('phpunit.xml') ? 'phpunit.xml' : 'phpunit.xml.dist'),
          frameworks: mergeSignals(
            createSignal(has('artisan'), 'laravel', 0.94, workingDir, 'artisan'),
            createSignal(has('bin') && has('config') && has('public'), 'symfony', 0.7, workingDir, 'composer.json'),
          ),
        },
        workspace: {
          appRoots: mapExistingRoots(workingDir, fileNames, ['app', 'src']),
          infraRoots: mapExistingRoots(workingDir, fileNames, ['config', 'database', 'routes']),
        },
      };
    },
  };
}

function createJvmProbe(): RepositoryProbe {
  return {
    id: 'jvm-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      const detected = has('pom.xml') || has('build.gradle') || has('build.gradle.kts');
      return {
        fingerprints: {
          ecosystems: createSignal(detected, 'jvm-ecosystem', 0.9, workingDir, has('pom.xml') ? 'pom.xml' : 'build.gradle'),
          languages: mergeSignals(
            createSignal(detected, 'java', 0.82, workingDir, has('pom.xml') ? 'pom.xml' : 'build.gradle'),
            createSignal(has('build.gradle.kts'), 'kotlin', 0.84, workingDir, 'build.gradle.kts'),
          ),
          buildTools: mergeSignals(
            createSignal(has('pom.xml'), 'maven', 0.95, workingDir, 'pom.xml'),
            createSignal(has('build.gradle') || has('build.gradle.kts'), 'gradle', 0.95, workingDir, has('build.gradle') ? 'build.gradle' : 'build.gradle.kts'),
          ),
        },
        workspace: {
          appRoots: mapExistingRoots(workingDir, fileNames, ['src']),
        },
      };
    },
  };
}

function createRustProbe(): RepositoryProbe {
  return {
    id: 'rust-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      const detected = has('Cargo.toml');
      return {
        fingerprints: {
          ecosystems: createSignal(detected, 'rust-ecosystem', 0.95, workingDir, 'Cargo.toml'),
          languages: createSignal(detected, 'rust', 0.98, workingDir, 'Cargo.toml'),
          runtimes: createSignal(detected, 'rust', 0.98, workingDir, 'Cargo.toml'),
          buildTools: createSignal(detected, 'cargo', 0.98, workingDir, 'Cargo.toml'),
          packageManagers: createSignal(detected, 'cargo', 0.98, workingDir, 'Cargo.toml'),
        },
        workspace: {
          appRoots: mapExistingRoots(workingDir, fileNames, ['src']),
        },
      };
    },
  };
}

function createRubyProbe(): RepositoryProbe {
  return {
    id: 'ruby-probe',
    probe({ workingDir, fileNames }) {
      const has = createHas(fileNames);
      const detected = has('Gemfile') || has('Gemfile.lock');
      return {
        fingerprints: {
          ecosystems: createSignal(detected, 'ruby-ecosystem', 0.93, workingDir, has('Gemfile') ? 'Gemfile' : 'Gemfile.lock'),
          languages: createSignal(detected, 'ruby', 0.96, workingDir, has('Gemfile') ? 'Gemfile' : 'Gemfile.lock'),
          runtimes: createSignal(detected, 'ruby', 0.96, workingDir, has('Gemfile') ? 'Gemfile' : 'Gemfile.lock'),
          packageManagers: createSignal(detected, 'bundler', 0.94, workingDir, has('Gemfile') ? 'Gemfile' : 'Gemfile.lock'),
          buildTools: createSignal(detected && has('Rakefile'), 'rake', 0.9, workingDir, 'Rakefile'),
        },
        workspace: {
          appRoots: mapExistingRoots(workingDir, fileNames, ['app', 'lib']),
        },
      };
    },
  };
}

function createGenericLayoutProbe(): RepositoryProbe {
  return {
    id: 'generic-layout-probe',
    probe({ workingDir, fileNames }) {
      return {
        workspace: {
          packageRoots: mapExistingRoots(workingDir, fileNames, ['packages']),
          appRoots: mapExistingRoots(workingDir, fileNames, ['apps', 'services', 'cmd', 'src']),
          libraryRoots: mapExistingRoots(workingDir, fileNames, ['libs', 'lib', 'internal', 'pkg']),
          infraRoots: mapExistingRoots(workingDir, fileNames, ['infra', 'config', 'database', 'routes']),
          docsRoots: mapExistingRoots(workingDir, fileNames, ['docs']),
        },
        riskSignals: [
          ...(!fileNames.includes('README.md') ? ['missing_readme'] : []),
          ...(!fileNames.includes('.gitignore') ? ['missing_gitignore'] : []),
        ],
      };
    },
  };
}

async function safeReadDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  } catch {
    return [];
  }
}

function mergeObservation(
  base: RepositoryProbeObservation,
  next: RepositoryProbeObservation,
): RepositoryProbeObservation {
  return {
    topology: next.topology && next.topology !== 'unknown' ? next.topology : base.topology,
    stack: {
      ...(base.stack ?? {}),
      ...(next.stack ?? {}),
    },
    fingerprints: mergeFingerprints(base.fingerprints, next.fingerprints),
    workspace: {
      ...(base.workspace ?? {}),
      rootPath: next.workspace?.rootPath ?? base.workspace?.rootPath,
      packageRoots: uniqueArray([...(base.workspace?.packageRoots ?? []), ...(next.workspace?.packageRoots ?? [])]),
      appRoots: uniqueArray([...(base.workspace?.appRoots ?? []), ...(next.workspace?.appRoots ?? [])]),
      libraryRoots: uniqueArray([...(base.workspace?.libraryRoots ?? []), ...(next.workspace?.libraryRoots ?? [])]),
      infraRoots: uniqueArray([...(base.workspace?.infraRoots ?? []), ...(next.workspace?.infraRoots ?? [])]),
      docsRoots: uniqueArray([...(base.workspace?.docsRoots ?? []), ...(next.workspace?.docsRoots ?? [])]),
    },
    conventions: {
      hasAdr: (base.conventions?.hasAdr ?? false) || (next.conventions?.hasAdr ?? false),
      hasOpenApi: (base.conventions?.hasOpenApi ?? false) || (next.conventions?.hasOpenApi ?? false),
      hasCi: (base.conventions?.hasCi ?? false) || (next.conventions?.hasCi ?? false),
      hasLinting: (base.conventions?.hasLinting ?? false) || (next.conventions?.hasLinting ?? false),
      hasFormatting: (base.conventions?.hasFormatting ?? false) || (next.conventions?.hasFormatting ?? false),
    },
    riskSignals: uniqueArray([...(base.riskSignals ?? []), ...(next.riskSignals ?? [])]),
    sources: uniqueArray([...(base.sources ?? []), ...(next.sources ?? [])]),
  };
}

function mergeFingerprints(
  base?: Partial<RepositoryFingerprints>,
  next?: Partial<RepositoryFingerprints>,
): Partial<RepositoryFingerprints> {
  return {
    ecosystems: mergeSignals(base?.ecosystems, next?.ecosystems),
    languages: mergeSignals(base?.languages, next?.languages),
    frameworks: mergeSignals(base?.frameworks, next?.frameworks),
    runtimes: mergeSignals(base?.runtimes, next?.runtimes),
    packageManagers: mergeSignals(base?.packageManagers, next?.packageManagers),
    buildTools: mergeSignals(base?.buildTools, next?.buildTools),
    testTools: mergeSignals(base?.testTools, next?.testTools),
  };
}

function normalizeFingerprints(
  partial?: Partial<RepositoryFingerprints>,
): RepositoryFingerprints {
  return {
    ecosystems: sortSignals(partial?.ecosystems),
    languages: sortSignals(partial?.languages),
    frameworks: sortSignals(partial?.frameworks),
    runtimes: sortSignals(partial?.runtimes),
    packageManagers: sortSignals(partial?.packageManagers),
    buildTools: sortSignals(partial?.buildTools),
    testTools: sortSignals(partial?.testTools),
  };
}

function buildStackFromFingerprints(
  partial?: Partial<RepositoryFingerprints>,
): RepositoryModel['stack'] {
  const normalized = normalizeFingerprints(partial);
  return {
    languages: normalized.languages.map((signal) => signal.name),
    frameworks: normalized.frameworks.map((signal) => signal.name),
    runtimes: normalized.runtimes.map((signal) => signal.name),
    packageManagers: normalized.packageManagers.map((signal) => signal.name),
    buildTools: normalized.buildTools.map((signal) => signal.name),
    testTools: normalized.testTools.map((signal) => signal.name),
  };
}

function mergeSignals(
  ...collections: Array<RepositorySignal[] | RepositorySignal | undefined>
): RepositorySignal[] {
  const merged = new Map<string, RepositorySignal>();
  for (const collection of collections) {
    const signals = Array.isArray(collection) ? collection : collection ? [collection] : [];
    for (const signal of signals) {
      const current = merged.get(signal.name);
      if (!current || signal.confidence > current.confidence) {
        merged.set(signal.name, {
          name: signal.name,
          confidence: signal.confidence,
          sources: uniqueArray([...(current?.sources ?? []), ...signal.sources]),
        });
      } else {
        current.sources = uniqueArray([...current.sources, ...signal.sources]);
      }
    }
  }
  return sortSignals(Array.from(merged.values()));
}

function sortSignals(signals?: RepositorySignal[]): RepositorySignal[] {
  return [...(signals ?? [])]
    .sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name));
}

function createSignal(
  condition: boolean,
  name: string,
  confidence: number,
  workingDir: string,
  source: string,
): RepositorySignal[] {
  return condition
    ? [{ name, confidence, sources: [path.join(workingDir, source)] }]
    : [];
}

function mapExistingRoots(workingDir: string, fileNames: string[], names: string[]): string[] {
  const set = new Set(fileNames);
  return names.filter((name) => set.has(name)).map((name) => path.join(workingDir, name));
}

function createHas(fileNames: string[]): (name: string) => boolean {
  const set = new Set(fileNames);
  return (name) => set.has(name);
}

function uniqueArray<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
