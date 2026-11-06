import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(packageRoot, 'src/error-envelope/errors.catalog.json');
const outputPath = resolve(packageRoot, 'src/error-envelope/error-codes.generated.ts');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
for (const entry of catalog.codes) {
  if (!Number.isInteger(entry.httpStatus) || entry.httpStatus < 100 || entry.httpStatus > 599) {
    throw new Error(`${entry.code} must declare an HTTP status between 100 and 599`);
  }
  if (!['input-refusal', 'operation-failure'].includes(entry.processExitClass)) {
    throw new Error(`${entry.code} must declare a process exit class`);
  }
}
const entries = [...catalog.codes].sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
if (!Array.isArray(catalog.environmentVariables)) throw new Error('environmentVariables must be declared as an array');
const environmentVariables = [...catalog.environmentVariables].sort();
const codes = [...new Set(entries.map(({ code }) => code))];
const templateParameterMetadata = entries.map((entry) => {
  const templates = [entry.message, entry.hint, entry.hintWithoutCorrelationId].filter(Boolean);
  const names = [...new Set(templates.flatMap((template) => [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1])))].sort();
  const namesFor = (fields) => [...new Set(fields.map((field) => entry[field]).filter(Boolean).flatMap((template) => [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1])))].sort();
  const runtime = entry.runtimeTemplateParameters ?? {};
  for (const name of Object.keys(runtime)) {
    if (!names.includes(name)) throw new Error(`${entry.code} declares unused runtime template parameter ${name}`);
  }
  const requiredNames = names.filter((name) => runtime[name] !== 'optional');
  const structuredDetailFields = entry.structuredDetailFields ?? [];
  if (new Set(structuredDetailFields).size !== structuredDetailFields.length) throw new Error(`${entry.code} declares duplicate structured detail fields`);
  const renderRecord = (fields) => fields.length === 0 ? 'Record<never, never>' : `{ ${fields.join('; ')} }`;
  const allType = renderRecord(names.map((name) => `${JSON.stringify(name)}: string`));
  const messageNames = namesFor(['message']);
  const hintNames = namesFor(['hint', 'hintWithoutCorrelationId']);
  return {
    code: entry.code,
    names,
    requiredNames,
    requiredMessageNames: messageNames.filter((name) => runtime[name] !== 'optional'),
    requiredHintNames: hintNames.filter((name) => runtime[name] !== 'optional'),
    messageNames,
    hintNames,
    structuredDetailFields,
    type: `  ${JSON.stringify(entry.code)}: ${allType};`,
  };
});
const templateParameters = templateParameterMetadata.map(({ type }) => type);
const schemaType = (schema) => {
  if (schema.type === 'string') return 'string';
  if (schema.type === 'array') return `readonly ${schemaType(schema.items)}[]`;
  if (schema.type === 'object') {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(([name, value]) => `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${schemaType(value)}`);
    return fields.length ? `{ ${fields.join('; ')} }` : 'Record<string, never>';
  }
  throw new Error(`Unsupported structured detail JSON schema type ${schema.type}`);
};
const detailParameters = entries.map((entry) => {
  const runtime = entry.runtimeTemplateParameters ?? {};
  const templates = [entry.message, entry.hint, entry.hintWithoutCorrelationId].filter(Boolean);
  const names = [...new Set(templates.flatMap((template) => [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1])))].sort();
  const structured = entry.structuredDetailFields ?? [];
  const fields = [
    ...names.filter((name) => !(name in runtime)).map((name) => `${JSON.stringify(name)}: string`),
    ...structured.filter((name) => !names.includes(name)).map((name) => {
      const schema = entry.structuredDetailSchemas?.[name];
      const required = (entry.requiredStructuredDetailFields ?? []).includes(name);
      return `${JSON.stringify(name)}${required ? '' : '?'}: ${schema ? schemaType(schema) : 'string'}`;
    }),
  ];
  return `  ${JSON.stringify(entry.code)}: ${fields.length ? `{ ${fields.join('; ')} }` : 'Record<string, never>'};`;
});
const parametersForTemplate = (entry, fields) => {
  const runtime = entry.runtimeTemplateParameters ?? {};
  const templates = fields.map((field) => entry[field]).filter(Boolean);
  const names = [...new Set(templates.flatMap((template) => [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1])))].filter((name) => !(name in runtime)).sort();
  return names.length === 0 ? 'Record<never, never>' : `{ ${names.map((name) => `${JSON.stringify(name)}: string`).join('; ')} }`;
};
const messageTemplateParameters = entries.map((entry) => `  ${JSON.stringify(entry.code)}: ${parametersForTemplate(entry, ['message'])};`);
const hintTemplateParameters = entries.map((entry) => `  ${JSON.stringify(entry.code)}: ${parametersForTemplate(entry, ['hint', 'hintWithoutCorrelationId'])};`);
const runtimeTemplateParameters = entries.map((entry) => {
  const runtime = entry.runtimeTemplateParameters ?? {};
  const fields = Object.entries(runtime).map(([name, requirement]) => `${JSON.stringify(name)}${requirement === 'optional' ? '?' : ''}: string`);
  const type = fields.length === 0 ? 'Record<never, never>' : `{ ${fields.join('; ')} }`;
  return `  ${JSON.stringify(entry.code)}: ${type};`;
});
const producerInputs = entries.map((entry, index) => {
  const metadata = templateParameterMetadata[index];
  const runtime = entry.runtimeTemplateParameters ?? {};
  const variants = [];
  for (const messageOverride of [false, true]) for (const hintOverride of [false, true]) {
    const required = new Set([
      ...(messageOverride ? [] : metadata.requiredMessageNames),
      ...(hintOverride ? [] : metadata.requiredHintNames),
    ]);
    const fields = [];
    const detailNames = metadata.names.filter(name => !(name in runtime));
    const detailFields = detailNames.map(name => `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: string`);
    for (const name of metadata.structuredDetailFields.filter(name => !detailNames.includes(name))) {
      const schema = entry.structuredDetailSchemas?.[name];
      detailFields.push(`${JSON.stringify(name)}${(entry.requiredStructuredDetailFields ?? []).includes(name) ? '' : '?'}: ${schema ? schemaType(schema) : 'string'}`);
    }
    const requiredDetail = detailNames.some(name => required.has(name)) || (entry.requiredStructuredDetailFields ?? []).length > 0;
    if (detailFields.length) fields.push(`details${requiredDetail ? '' : '?'}: { ${detailFields.join('; ')} }`);
    else fields.push('details?: Record<string, never>');
    const runtimeNames = Object.keys(runtime);
    const requiredRuntime = runtimeNames.some(name => required.has(name));
    if (runtimeNames.length) fields.push(`templateValues${requiredRuntime ? '' : '?'}: { ${runtimeNames.map(name => `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: string`).join('; ')} }`);
    else fields.push('templateValues?: Record<string, never>');
    fields.push(`message${messageOverride ? '' : '?'}: ${messageOverride ? 'string' : 'never'}`);
    fields.push(`hint${hintOverride ? '' : '?'}: ${hintOverride ? 'string' : 'never'}`);
    variants.push(`{ ${fields.join('; ')} }`);
  }
  return `  ${JSON.stringify(entry.code)}: ${variants.join(' | ')};`;
});
const output = [
  "import type { ErrorAction, ErrorEnvelope, PlatformDiagnostic } from './types.js';",
  '/**',
  ' * Generated from errors.catalog.json by `pnpm generate:error-codes`.',
  ' * Do not edit this file directly; the JSON catalog is the source of truth.',
  ' */',
  'export type CatalogErrorCode =',
  ...codes.map((code) => `  | ${JSON.stringify(code)}`),
  ';',
  '',
  'export interface CatalogTemplateParameters {',
  ...templateParameters,
  '}',
  '',
  'export interface CatalogProducerInputFor {',
  ...producerInputs.map(line => line.replace(': {', ': CatalogProducerCommon & ({').replace(/;$/, ');')),
  '}',
  'export type CatalogErrorRequest = { [C in CatalogErrorCode]: { code: C } & CatalogProducerInputFor[C] }[CatalogErrorCode];',
  'export interface CatalogProducerCommon { cause?: string; correlationId?: string; actions?: ErrorAction[]; docs?: string; diagnostics?: PlatformDiagnostic[]; severity?: ErrorEnvelope[\"severity\"]; }',
  '',
  'export interface CatalogDetailsFor {',
  ...detailParameters,
  '}',
  '',
  'export const catalogEnvironmentVariables = {',
  ...environmentVariables.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(name)},`),
  '} as const;',
  '',
  'export const catalogRequiredTemplateParameters: Readonly<Record<CatalogErrorCode, readonly string[]>> = {',
  ...templateParameterMetadata.map(({ code, requiredNames }) => `  ${JSON.stringify(code)}: ${JSON.stringify(requiredNames)},`),
  '};',
  '',
  'export const catalogRequiredMessageTemplateParameters: Readonly<Record<CatalogErrorCode, readonly string[]>> = {',
  ...templateParameterMetadata.map(({ code, requiredMessageNames }) => `  ${JSON.stringify(code)}: ${JSON.stringify(requiredMessageNames)},`),
  '};',
  '',
  'export const catalogRequiredHintTemplateParameters: Readonly<Record<CatalogErrorCode, readonly string[]>> = {',
  ...templateParameterMetadata.map(({ code, requiredHintNames }) => `  ${JSON.stringify(code)}: ${JSON.stringify(requiredHintNames)},`),
  '};',
  '',
  'export const catalogTemplateParameterNames: Readonly<Record<CatalogErrorCode, readonly string[]>> = {',
  ...templateParameterMetadata.map(({ code, names }) => `  ${JSON.stringify(code)}: ${JSON.stringify(names)},`),
  '};',
  '',
  'export const catalogMessageTemplateParameterNames: Readonly<Record<CatalogErrorCode, readonly string[]>> = {',
  ...templateParameterMetadata.map(({ code, messageNames }) => `  ${JSON.stringify(code)}: ${JSON.stringify(messageNames)},`),
  '};',
  '',
  'export const catalogHintTemplateParameterNames: Readonly<Record<CatalogErrorCode, readonly string[]>> = {',
  ...templateParameterMetadata.map(({ code, hintNames }) => `  ${JSON.stringify(code)}: ${JSON.stringify(hintNames)},`),
  '};',
  '',
  'export const catalogStructuredDetailFields: Readonly<Record<CatalogErrorCode, readonly string[]>> = {',
  ...templateParameterMetadata.map(({ code, structuredDetailFields }) => `  ${JSON.stringify(code)}: ${JSON.stringify(structuredDetailFields)},`),
  '};',
  '',
  'export interface CatalogMessageTemplateParameters {',
  ...messageTemplateParameters,
  '}',
  '',
  'export interface CatalogHintTemplateParameters {',
  ...hintTemplateParameters,
  '}',
  '',
  'export interface CatalogRuntimeTemplateParameters {',
  ...runtimeTemplateParameters,
  '}',
  '',
].join('\n');
await writeFile(outputPath, output, 'utf8');
