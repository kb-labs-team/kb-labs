import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const contractDir = fileURLToPath(new URL('../../../../core/platform/contracts/ux-result', import.meta.url));
const schemaDir = join(contractDir, 'fixtures');
const ajv = new Ajv2020({ allErrors: true, strict: false });
const errorSchema = JSON.parse(readFileSync(
  new URL('../../../../core/platform/src/error-envelope/error-envelope.schema.json', import.meta.url), 'utf8',
));
const resultSchema = JSON.parse(readFileSync(join(contractDir, 'machine-result.schema.json'), 'utf8'));
ajv.addSchema(errorSchema);
const validate = ajv.compile(resultSchema);

function readFixtures(kind: 'valid' | 'invalid'): Array<{ name: string; value: unknown }> {
  const dir = join(schemaDir, kind);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      name: file,
      value: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown,
    }));
}

describe('machine result JSON Schema', () => {
  // case: S-203.1
  it('accepts every shared valid fixture', () => {
    for (const { name, value } of readFixtures('valid')) {
      expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  // case: S-203.2
  it('rejects every shared invalid fixture', () => {
    for (const { name, value } of readFixtures('invalid')) {
      expect(validate(value), name).toBe(false);
    }
  });
});
