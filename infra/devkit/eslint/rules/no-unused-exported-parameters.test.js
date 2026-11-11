import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import noUnusedExportedParameters from './no-unused-exported-parameters.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: tseslint.parser,
  },
});

ruleTester.run('no-unused-exported-parameters', noUnusedExportedParameters, {
  valid: [
    {
      code: '/** @type {(context: object, input: object) => void} */ export const execute = (context, input) => {};',
      languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    },
    'export abstract class Base { protected configure(_request: object) {} }',
    'export function used(ctx, value) { return ctx + value; }',
    'function internal(_ctx, value) { return value; }',
    {
      code: 'interface Contract { run(required: string): void; } export class Implementation implements Contract { run(required: string) {} }',
    },
    {
      code: 'type ResolveHook = (specifier: string, context: object, next: Function) => void; export const resolve: ResolveHook = (specifier, context, next) => {};',
    },
    {
      code: 'export const satisfied = ((value: string) => {}) satisfies (value: string) => void;',
    },
  ],
  invalid: [
    {
      code: 'export function fail(_ctx, value, _isJson) { return value; }',
      errors: [
        { messageId: 'unused', data: { name: '_ctx' } },
        { messageId: 'unused', data: { name: '_isJson' } },
      ],
    },
    {
      code: 'export class Implementation { run(required: string) {} }',
      errors: [{ messageId: 'unused', data: { name: 'required' } }],
    },
    {
      code: 'interface Contract { run(input: string): void; } export class Implementation implements Contract { run(input: string) {} unrelated(unused: string) {} }',
      errors: [{ messageId: 'unused', data: { name: 'unused' } }],
    },
    {
      code: 'class Base { run(input: string): void {} } export class Implementation extends Base { unrelated(unused: string) {} }',
      errors: [{ messageId: 'unused', data: { name: 'unused' } }],
    },
    {
      code: 'export async function resolve(specifier, context, nextResolve) {}',
      errors: [
        { messageId: 'unused', data: { name: 'specifier' } },
        { messageId: 'unused', data: { name: 'context' } },
        { messageId: 'unused', data: { name: 'nextResolve' } },
      ],
    },
  ],
});
