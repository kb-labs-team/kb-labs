import type { ServiceCommandInvocationDeclaration } from './manifest.js';

export interface ServiceCommandInputSources {
  argv?: readonly string[];
  flags?: object;
  arguments?: Readonly<Record<string, unknown>>;
}

export type ServiceCommandInputResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; field: string; message: string; code: 'KB_RUNTIME_INPUT_INVALID' };

/** Resolve CLI argv/flags or MCP named arguments through one declaration. */
export function normalizeServiceCommandInput(
  invocation: ServiceCommandInvocationDeclaration,
  sources: ServiceCommandInputSources,
): ServiceCommandInputResult {
  const value: Record<string, unknown> = { ...invocation.values };
  if (sources.arguments) {
    const declared = new Set(invocation.inputs.map((input) => input.name));
    for (const name of Object.keys(sources.arguments)) {
      if (!declared.has(name)) {
        return { ok: false, field: name, message: `Unexpected argument: ${name}.`, code: 'KB_RUNTIME_INPUT_INVALID' };
      }
    }
  }
  for (const input of invocation.inputs) {
    const raw = sources.arguments
      ? sources.arguments[input.name]
      : input.source.kind === 'positional'
        ? sources.argv?.[input.source.index]
        : (sources.flags as Readonly<Record<string, unknown>> | undefined)?.[input.source.name];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.length === 0)) {
      if (input.required) {
        return { ok: false, field: input.name, message: `Missing required argument: ${input.name}.`, code: 'KB_RUNTIME_INPUT_INVALID' };
      }
      continue;
    }
    if (typeof raw !== input.type) {
      return { ok: false, field: input.name, message: `Argument ${input.name} must be a ${input.type}.`, code: 'KB_RUNTIME_INPUT_INVALID' };
    }
    value[input.name] = raw;
  }
  return { ok: true, value };
}
