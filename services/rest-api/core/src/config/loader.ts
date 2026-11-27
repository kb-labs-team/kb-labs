/**
 * @module @kb-labs/rest-api-core/config/loader
 * Configuration loader using loadBundle from @kb-labs/core-bundle
 */

import { loadBundle, type ProductId } from '@kb-labs/core-bundle';
import { resolveConfig, findNearestConfig, readJsonWithDiagnostics } from '@kb-labs/core-config';
import { restApiConfigSchema, type RestApiConfig } from './schema';

/**
 * Load REST API configuration
 */
export async function loadRestApiConfig(
  cwd: string = process.cwd(),
  cliOverrides?: Partial<RestApiConfig>
): Promise<{ config: RestApiConfig; diagnostics: Array<{ level: string; code: string; message: string }> }> {
  // Try to load bundle with 'restApi' product
  // Note: if 'restApi' is not registered as ProductId, we'll fall back to direct config loading
  let bundleConfig: Record<string, unknown> = {};
  
  try {
    const bundle = await loadBundle({
      cwd,
      product: 'restApi' as unknown as ProductId,
      profileId: 'default',
    });
    bundleConfig = bundle.config;
  } catch {
    // If bundle loading fails (product not registered), try direct config loading
    const { path: configPath } = await findNearestConfig({
      startDir: cwd,
      filenames: ['.kb/kb.config.json', '.kb/kb.config.yaml'],
    });
    
    if (configPath) {
      const readResult = await readJsonWithDiagnostics<any>(configPath);
      if (readResult.ok && readResult.data?.rest) {
        bundleConfig = readResult.data.rest;
      }
    }
  }
  
  const defaults: RestApiConfig = {
    port: 5050,
    basePath: '/api/v1',
    apiVersion: '1.0.0',
    cors: {
      origins: ['http://localhost:3000', 'http://localhost:5173'],
      allowCredentials: true,
      profile: 'dev',
    },
    timeouts: {
      requestTimeout: 30000,
      bodyLimit: 10_485_760,
    },
    rateLimit: {
      // 600/min for dev (dashboard needs ~10 requests per page load)
      // Override with KB_REST_RATE_LIMIT_MAX=60 for production public API
      max: 600,
      timeWindow: '1 minute',
    },
    plugins: [],
    mockMode: false,
  };

  const envMapper = (env: NodeJS.ProcessEnv): Partial<RestApiConfig> => {
    const overrides: Partial<RestApiConfig> = {};

    if (env.KB_REST_PORT) {
      const parsedPort = Number.parseInt(env.KB_REST_PORT, 10);
      if (!Number.isNaN(parsedPort)) {
        overrides.port = parsedPort;
      }
    }

    if (env.KB_REST_BASE_PATH) {
      overrides.basePath = env.KB_REST_BASE_PATH;
    }

    if (env.KB_REST_API_VERSION) {
      overrides.apiVersion = env.KB_REST_API_VERSION;
    }

    if (env.KB_REST_CORS_ORIGINS) {
      const origins = env.KB_REST_CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
      overrides.cors = {
        ...(overrides.cors ?? defaults.cors),
        origins,
      };
    }

    if (env.KB_REST_CORS_PROFILE) {
      overrides.cors = {
        ...(overrides.cors ?? defaults.cors),
        profile: env.KB_REST_CORS_PROFILE as RestApiConfig['cors']['profile'],
      };
    }

    if (env.KB_REST_MOCK_MODE === 'true' || env.KB_REST_MOCK_MODE === '1') {
      overrides.mockMode = true;
    }

    if (env.KB_REST_REDIS_URL) {
      overrides.redis = {
        ...(overrides.redis ?? {}),
        url: env.KB_REST_REDIS_URL,
        namespace: overrides.redis?.namespace ?? defaults.redis?.namespace ?? 'kb',
      } as RestApiConfig['redis'];
    }

    if (env.KB_REST_REDIS_NAMESPACE) {
      overrides.redis = {
        ...(overrides.redis ?? (env.KB_REST_REDIS_URL ? { url: env.KB_REST_REDIS_URL } : defaults.redis ?? {})),
        namespace: env.KB_REST_REDIS_NAMESPACE,
      } as RestApiConfig['redis'];
    }

    if (env.KB_REST_RATE_LIMIT_MAX) {
      const parsedMax = Number.parseInt(env.KB_REST_RATE_LIMIT_MAX, 10);
      if (!Number.isNaN(parsedMax)) {
        overrides.rateLimit = {
          ...(overrides.rateLimit ?? defaults.rateLimit ?? { max: 600, timeWindow: '1 minute' }),
          max: parsedMax,
        };
      }
    }

    if (env.KB_REST_RATE_LIMIT_WINDOW) {
      overrides.rateLimit = {
        ...(overrides.rateLimit ?? defaults.rateLimit ?? { max: 600, timeWindow: '1 minute' }),
        timeWindow: env.KB_REST_RATE_LIMIT_WINDOW,
      };
    }

    if (env.KB_REST_REQUEST_TIMEOUT) {
      const parsedTimeout = Number.parseInt(env.KB_REST_REQUEST_TIMEOUT, 10);
      if (!Number.isNaN(parsedTimeout)) {
        const baseTimeout = overrides.timeouts ?? defaults.timeouts;
        overrides.timeouts = {
          requestTimeout: parsedTimeout,
          bodyLimit: baseTimeout?.bodyLimit ?? defaults.timeouts?.bodyLimit ?? 10_485_760,
        };
      }
    }

    if (env.KB_REST_BODY_LIMIT) {
      const parsedBodyLimit = Number.parseInt(env.KB_REST_BODY_LIMIT, 10);
      if (!Number.isNaN(parsedBodyLimit)) {
        const baseTimeout = overrides.timeouts ?? defaults.timeouts;
        overrides.timeouts = {
          requestTimeout: baseTimeout?.requestTimeout ?? defaults.timeouts?.requestTimeout ?? 30000,
          bodyLimit: parsedBodyLimit,
        };
      }
    }

    return overrides;
  };
  
  // Resolve configuration: defaults → bundleConfig → env → cliOverrides
  const resolved = resolveConfig<RestApiConfig>({
    defaults,
    fileConfig: bundleConfig,
    envMapper,
    cliOverrides,
    validate: (cfg) => {
      const result = restApiConfigSchema.safeParse(cfg);
      if (result.success) {
        return { ok: true };
      }
      return {
        ok: false,
        diagnostics: result.error.issues.map((err) => ({
          level: 'error' as const,
          code: 'CONFIG_VALIDATION_ERROR',
          message: `${err.path.map(String).join('.')}: ${err.message}`,
        })),
      };
    },
  });
  
  // Parse with Zod to get properly typed config
  const validated = restApiConfigSchema.parse(resolved.value);
  
  return {
    config: validated,
    diagnostics: resolved.diagnostics,
  };
}

