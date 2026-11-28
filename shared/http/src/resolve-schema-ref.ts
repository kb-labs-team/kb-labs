import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface ZodSchemaRef {
  /** Reference in format "package-name#ExportedSchemaName" */
  zod: string;
}

export interface JsonSchemaRef {
  $ref: string;
}

export type SchemaRef = ZodSchemaRef | JsonSchemaRef;

/**
 * Resolves a SchemaRef from a plugin manifest to a plain JSON Schema object.
 *
 * Supports two formats:
 * - `{ $ref: "..." }` — returned as-is (already a JSON Schema reference)
 * - `{ zod: "pkg#ExportName" }` — dynamically imports the package, grabs the
 *   named export, and converts the ZodType to JSON Schema
 *
 * Fail-open: if the module cannot be imported or the export is missing/not a
 * ZodType, returns null and logs a warning. The route will still mount — it just
 * won't have schema documentation.
 *
 * @example
 * ```ts
 * const schema = await resolveSchemaRef({
 *   zod: '@kb-labs/commit/contracts#GenerateRequestSchema'
 * });
 * // → { type: 'object', properties: { ... }, required: [...] }
 * ```
 */
export async function resolveSchemaRef(ref: SchemaRef): Promise<Record<string, unknown> | null> {
  if ('$ref' in ref) {
    return { $ref: ref.$ref };
  }

  if ('zod' in ref) {
    const hashIdx = ref.zod.lastIndexOf('#');
    if (hashIdx === -1) {
      console.warn(`[shared-http] resolveSchemaRef: invalid zod ref format "${ref.zod}" (expected "pkg#ExportName")`);
      return null;
    }

    const modulePath = ref.zod.slice(0, hashIdx);
    const exportName = ref.zod.slice(hashIdx + 1);

    if (!modulePath || !exportName) {
      console.warn(`[shared-http] resolveSchemaRef: empty module or export in "${ref.zod}"`);
      return null;
    }

    try {
      const mod = await import(modulePath);
      const schema = mod[exportName];

      if (schema instanceof z.ZodType) {
        // Manifest schemas are used to validate incoming request data. Draft 7
        // remains compatible with Fastify's AJV validator; inline reused schemas
        // to avoid unresolved local reference chains in plugin routes.
        return z.toJSONSchema(schema, {
          target: 'draft-07',
          io: 'input',
          reused: 'inline',
          cycles: 'throw',
          unrepresentable: 'any',
        }) as Record<string, unknown>;
      }

      // Keep public compatibility with plugin manifests whose Zod schema was
      // exported from a package that still bundles Zod 3. This only converts
      // its schema metadata; request validation remains on the active provider.
      if (isLegacyZodSchema(schema)) {
        return zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
      }

      console.warn(`[shared-http] resolveSchemaRef: "${ref.zod}" export is not a ZodType`);
      return null;
    } catch (err) {
      console.warn(`[shared-http] resolveSchemaRef: failed to import "${modulePath}": ${(err as Error).message}`);
      return null;
    }
  }

  return null;
}

function isLegacyZodSchema(value: unknown): value is Parameters<typeof zodToJsonSchema>[0] {
  return value !== null && typeof value === 'object' && '_def' in value && !('_zod' in value);
}
