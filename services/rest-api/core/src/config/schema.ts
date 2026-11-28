/**
 * @module @kb-labs/rest-api-core/config/schema
 * Zod schema for REST API configuration
 */

import { z } from 'zod';

export const restApiConfigSchema = z.object({
  port: z.number().int().positive().default(5050),
  basePath: z.string().default('/api/v1'),
  apiVersion: z.string().default('1.0.0'),
  cors: z.object({
    origins: z.array(z.string()).default(['http://localhost:3000', 'http://localhost:5173']),
    allowCredentials: z.boolean().default(true),
    profile: z.enum(['dev', 'preview', 'prod']).default('dev'),
  }).prefault({}),
  timeouts: z.object({
    requestTimeout: z.number().int().positive().default(30000),
    bodyLimit: z.number().int().positive().default(10_485_760),
  }).optional(),
  rateLimit: z.object({
    max: z.number().int().positive().default(60),
    timeWindow: z.string().default('1 minute'),
  }).optional(),
  startup: z.object({
    maxConcurrent: z.number().int().positive().default(32),
    queueLimit: z.number().int().nonnegative().default(128),
    timeoutMs: z.number().int().positive().default(5000),
    retryAfterSeconds: z.number().int().positive().default(2),
  }).optional(),
  plugins: z.array(z.string()).default([]),
  mockMode: z.boolean().default(false),
  redis: z
    .object({
      url: z.string().min(1),
      namespace: z.string().default('kb'),
    })
    .optional(),
  events: z
    .object({
      registry: z
        .object({
          token: z.string().min(1),
          headerName: z.string().default('authorization'),
          queryParam: z.string().default('access_token'),
        })
        .optional(),
    })
    .optional(),
  http2: z
    .object({
      enabled: z.boolean().default(false),
      allowHTTP1: z.boolean().default(true), // Fallback for old clients
    })
    .optional(),
  ssl: z
    .object({
      keyPath: z.string().min(1),
      certPath: z.string().min(1),
    })
    .optional(),
});

export type RestApiConfig = z.infer<typeof restApiConfigSchema>;

