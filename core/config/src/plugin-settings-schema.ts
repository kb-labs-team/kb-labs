import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv from 'ajv';

export interface PluginSettingsValidator {
  validate(value: unknown): { valid: true } | { valid: false; cause: string };
}

export class PluginSettingsSchemaLoadError extends Error {
  readonly code = 'KB_PLUGIN_SETTINGS_SCHEMA_INVALID';

  constructor(message: string, readonly detail?: string, readonly plugin = 'unknown') {
    super(message);
    this.name = 'PluginSettingsSchemaLoadError';
  }
}

/** Resolve and compile one manifest settings schema before it is used. */
export async function resolvePluginSettingsValidator(
  schemaRef: unknown,
  packageRoot: string,
  pluginId = 'unknown',
): Promise<PluginSettingsValidator> {
  try {
    if (!isRecord(schemaRef)) {
      throw new Error('The manifest does not declare a settings schema object.');
    }

    if (isOnlyStringKey(schemaRef, '$ref') && typeof schemaRef.$ref === 'string') {
      const reference = schemaRef.$ref;
      const { document, uri } = await loadJsonSchemaReference(reference, packageRoot);
      const ajv = new Ajv({ allErrors: true, strict: false });
      ajv.addSchema(document as object, uri);
      const fragmentIndex = reference.indexOf('#');
      const fragment = fragmentIndex >= 0 ? reference.slice(fragmentIndex) : '';
      const validate = ajv.compile({ $ref: `${uri}${fragment}` });
      return {
        validate(value) {
          return validate(value)
            ? { valid: true }
            : { valid: false, cause: ajv.errorsText(validate.errors, { separator: '; ' }) };
        },
      };
    }

    if (isOnlyStringKey(schemaRef, 'zod') && typeof schemaRef.zod === 'string') {
      const zodSchema = await loadZodSchema(schemaRef.zod, packageRoot);
      return {
        validate(value) {
          const result = zodSchema.safeParse(value);
          return result.success
            ? { valid: true }
            : { valid: false, cause: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ') };
        },
      };
    }

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemaRef as object);
    return {
      validate(value) {
        return validate(value)
          ? { valid: true }
          : { valid: false, cause: ajv.errorsText(validate.errors, { separator: '; ' }) };
      },
    };
  } catch (error) {
    if (error instanceof PluginSettingsSchemaLoadError) {throw error;}
    const detail = error instanceof Error ? error.message : String(error);
    throw new PluginSettingsSchemaLoadError(
      `The plugin settings schema could not be loaded: ${detail}`,
      detail,
      pluginId,
    );
  }
}

interface LoadedZodSchema {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
}

async function loadZodSchema(reference: string, packageRoot: string): Promise<LoadedZodSchema> {
  const [moduleSpecifier, exportName] = reference.split('#');
  if (!moduleSpecifier || !exportName) {throw new Error('A Zod reference must use <module>#<export>.');}
  const packageRequire = createRequire(path.join(packageRoot, 'package.json'));
  const modulePath = moduleSpecifier.startsWith('.') || path.isAbsolute(moduleSpecifier)
    ? packageRequire.resolve(path.resolve(packageRoot, moduleSpecifier))
    : packageRequire.resolve(moduleSpecifier);
  const loaded = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const defaultExport = isRecord(loaded.default) ? loaded.default : undefined;
  const schema = loaded[exportName] ?? defaultExport?.[exportName];
  if (!isRecord(schema) || typeof schema.safeParse !== 'function') {
    throw new Error(`Zod export "${exportName}" is missing or has no safeParse method.`);
  }
  return schema as unknown as LoadedZodSchema;
}

async function loadJsonSchemaReference(reference: string, packageRoot: string): Promise<{ document: unknown; uri: string }> {
  const hashIndex = reference.indexOf('#');
  const target = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : reference.slice(hashIndex + 1);
  if (!target) {throw new Error('A JSON Schema reference must include a file path before its fragment.');}
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('file:')) {
    throw new Error('Only local JSON Schema references are supported.');
  }
  const filePath = target.startsWith('file:')
    ? fileURLToPath(target)
    : path.resolve(packageRoot, target);
  const resolved = path.resolve(filePath);
  const root = path.resolve(packageRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('The JSON Schema reference escapes the plugin package.');
  }
  const parsed: unknown = JSON.parse(await fs.readFile(resolved, 'utf8'));
  const selected = fragment ? resolveJsonPointer(parsed, fragment) : parsed;
  if (!isRecord(selected)) {throw new Error('The JSON Schema reference does not point to a schema object.');}
  return { document: parsed, uri: pathToFileURL(resolved).href };
}

function resolveJsonPointer(document: unknown, fragment: string): unknown {
  if (!fragment.startsWith('/')) {throw new Error('A JSON Schema fragment must be a JSON Pointer.');}
  return fragment.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current) && !Array.isArray(current)) {throw new Error(`JSON Schema pointer segment "${segment}" was not found.`);}
      const value = (current as Record<string, unknown>)[segment];
      if (value === undefined) {throw new Error(`JSON Schema pointer segment "${segment}" was not found.`);}
      return value;
    }, document);
}

function isOnlyStringKey(value: Record<string, unknown>, key: string): boolean {
  return Object.keys(value).length === 1 && typeof value[key] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
