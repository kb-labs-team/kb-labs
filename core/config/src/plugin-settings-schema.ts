import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv from 'ajv';

export interface PluginSettingsValidator {
  validate(value: unknown): Promise<{ valid: true } | { valid: false; cause: string }>;
}

const ZOD_VALIDATION_TIMEOUT_MS = 3_000;
const ZOD_VALIDATION_MAX_INPUT_BYTES = 1_048_576;
const ZOD_VALIDATION_MAX_OUTPUT_BYTES = 65_536;
const ZOD_VALIDATION_HEAP_MB = 64;

const ZOD_WORKER_SOURCE = String.raw`
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
const send = (value) => { try { writeSync(3, JSON.stringify(value)); } finally { process.exit(0); } };
const fail = (error) => send({ ok: false, error: error instanceof Error ? error.message.slice(0, 3000) : String(error).slice(0, 3000) });
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
try {
  const request = JSON.parse(raw);
  const [moduleSpecifier, exportName] = request.reference.split('#');
  if (!moduleSpecifier || !exportName) throw new Error('A Zod reference must use <module>#<export>.');
  const packageRequire = createRequire(path.join(request.packageRoot, 'package.json'));
  const modulePath = moduleSpecifier.startsWith('.') || path.isAbsolute(moduleSpecifier)
    ? packageRequire.resolve(path.resolve(request.packageRoot, moduleSpecifier))
    : packageRequire.resolve(moduleSpecifier);
  const loaded = await import(pathToFileURL(modulePath).href);
  const defaultExport = loaded.default && typeof loaded.default === 'object' ? loaded.default : undefined;
  const schema = loaded[exportName] ?? defaultExport?.[exportName];
  if (!schema || typeof schema !== 'object' || typeof schema.safeParse !== 'function') {
    throw new Error('Zod export "' + exportName + '" is missing or has no safeParse method.');
  }
  if (request.action === 'check') send({ ok: true });
  const result = schema.safeParse(request.value);
  if (result.success) send({ ok: true, valid: true });
  const issues = Array.isArray(result.error?.issues) ? result.error.issues.slice(0, 100) : [];
  const cause = issues.map((issue) => {
    const issuePath = Array.isArray(issue.path) ? issue.path.slice(0, 50).join('.') : '';
    const message = typeof issue.message === 'string' ? issue.message.slice(0, 1000) : 'Invalid value';
    return (issuePath || '<root>') + ': ' + message;
  }).join('; ');
  send({ ok: true, valid: false, cause: cause || 'Settings do not match the plugin schema.' });
} catch (error) { fail(error); }
`;

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
        async validate(value) {
          return validate(value)
            ? { valid: true }
            : { valid: false, cause: ajv.errorsText(validate.errors, { separator: '; ' }) };
        },
      };
    }

    if (isOnlyStringKey(schemaRef, 'zod') && typeof schemaRef.zod === 'string') {
      const reference = schemaRef.zod;
      await runZodWorker({ action: 'check', reference, packageRoot }, pluginId, 'load');
      return {
        async validate(value) {
          try {
            const result = await runZodWorker({ action: 'validate', reference, packageRoot, value }, pluginId, 'validate');
            return result.valid ? { valid: true } : { valid: false, cause: result.cause ?? 'Settings do not match the plugin schema.' };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { valid: false, cause: `Plugin settings validation failed: ${detail}` };
          }
        },
      };
    }

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemaRef as object);
    return {
      async validate(value) {
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

interface ZodWorkerResult {
  valid?: boolean;
  cause?: string;
}

async function runZodWorker(
  request: { action: 'check' | 'validate'; reference: string; packageRoot: string; value?: unknown },
  pluginId: string,
  phase: 'load' | 'validate',
): Promise<ZodWorkerResult> {
  let input: string;
  try {
    input = JSON.stringify(request);
  } catch {
    throw new PluginSettingsSchemaLoadError('Plugin settings validation input is not JSON serializable.', undefined, pluginId);
  }
  if (Buffer.byteLength(input) > ZOD_VALIDATION_MAX_INPUT_BYTES) {
    throw new PluginSettingsSchemaLoadError('Plugin settings validation input exceeds the 1 MiB limit.', undefined, pluginId);
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[key] !== undefined) {env[key] = process.env[key];}
  }
  const child = spawn(process.execPath, [
    `--max-old-space-size=${ZOD_VALIDATION_HEAP_MB}`,
    '--input-type=module',
    '-e',
    ZOD_WORKER_SOURCE,
  ], { env, stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
  const stdin = child.stdin;
  const control = child.stdio[3];
  if (!stdin || !control) {
    child.kill('SIGKILL');
    throw new Error('Could not open plugin settings worker pipes.');
  }

  return new Promise<ZodWorkerResult>((resolve, reject) => {
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`Plugin settings ${phase} timed out after ${ZOD_VALIDATION_TIMEOUT_MS} ms.`)));
    }, ZOD_VALIDATION_TIMEOUT_MS);
    control.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > ZOD_VALIDATION_MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('Plugin settings validation output exceeded the 64 KiB limit.')));
        return;
      }
      output.push(chunk);
    });
    stdin.on('error', () => {});
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Plugin settings ${phase} process exited with code ${String(code)}.`));
          return;
        }
        try {
          const result: { ok: boolean; valid?: boolean; cause?: string; error?: string } = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (!result.ok) {throw new Error(result.error ?? `Plugin settings ${phase} failed.`);}
          resolve({ valid: result.valid, cause: result.cause });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(`Plugin settings ${phase} returned invalid output.`));
        }
      });
    });
    stdin.end(input);
  });
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
