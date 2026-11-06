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
 *   named export, and converts the ZodType to JSON Schema via zod-to-json-schema
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

      if (!(schema instanceof z.ZodType)) {
        console.warn(`[shared-http] resolveSchemaRef: "${ref.zod}" export is not a ZodType`);
        return null;
      }

      // $refStrategy: 'none' inlines all nested schemas — avoids $ref chains
      // that Fastify v4's JSON Schema validator may not resolve correctly.
       
      return zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[shared-http] resolveSchemaRef: failed to import "${modulePath}": ${(err as Error).message}`);
      return null;
    }
  }

  return null;
}
