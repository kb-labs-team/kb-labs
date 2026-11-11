import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { MarketplaceConfigSchema } from '../types/marketplace.js';

export type ValidationResult = { ok: boolean; errors: import('ajv').ErrorObject[] | null };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schemaMap: Record<string, Record<string, unknown>> = {};
schemaMap.marketplace = MarketplaceConfigSchema;

/**
 * Temporary schema registry hook – upcoming implementation will register schemas here.
 */
export function registerProductSchema(product: string, schema: Record<string, unknown>): void {
  schemaMap[product] = schema;
}

export function validateProductConfig(product: string, config: unknown): ValidationResult {
  const schema = schemaMap[product];
  if (!schema) {return { ok: true, errors: null };}

  const validate = ajv.compile(schema);
  const ok = validate(config);
  return { ok: !!ok, errors: validate.errors || null };
}
