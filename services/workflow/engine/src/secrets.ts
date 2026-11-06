import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform'

export interface SecretProvider {
  validate(names: string[]): void
  resolve(names: string[]): Promise<Record<string, string>>
  sourceFor(name: string): string
}

export const MIN_WORKFLOW_SECRET_LENGTH = 8

export function createMissingSecretError(provider: SecretProvider, name: string): ErrorEnvelopeError {
  const source = provider.sourceFor(name)
  return new ErrorEnvelopeError(createErrorEnvelope('KB_CONFIG_SECRET_MISSING', {
    details: { secretName: name, variable: source },
    message: `Workflow secret "${name}" is declared but missing.`,
    hint: `Set ${source}, then run "kb workflow lint".`,
  }))
}

export interface EnvSecretProviderOptions {
  /** Prefix applied when looking up secrets in environment variables. Defaults to `KB_SECRET_`. */
  prefix?: string
  /** When true (default), plain and prefixed environment variable names are checked. */
  allowPlain?: boolean
}

export class EnvSecretProvider implements SecretProvider {
  private readonly prefix: string
  private readonly allowPlain: boolean

  constructor(options: EnvSecretProviderOptions = {}) {
    this.prefix = options.prefix ?? 'KB_SECRET_'
    this.allowPlain = options.allowPlain ?? true
  }

  sourceFor(name: string): string {
    if (this.allowPlain && process.env[name] !== undefined) return name
    return `${this.prefix}${name}`
  }

  validate(names: string[]): void {
    for (const name of names) {
      const value = this.lookup(name)
      if (value === undefined) {
        throw createMissingSecretError(this, name)
      }
      if (value.length < MIN_WORKFLOW_SECRET_LENGTH) {
        throw new ErrorEnvelopeError(createErrorEnvelope('KB_CONFIG_INVALID', {
          details: { path: `secret.${name}` },
          message: `Workflow secret "${name}" must contain at least ${MIN_WORKFLOW_SECRET_LENGTH} characters.`,
          hint: `Set ${this.sourceFor(name)} to a value with at least ${MIN_WORKFLOW_SECRET_LENGTH} characters, then run "kb workflow lint".`,
        }))
      }
    }
  }

  async resolve(names: string[]): Promise<Record<string, string>> {
    this.validate(names)
    const resolved: Record<string, string> = {}
    for (const name of names) {
      const value = this.lookup(name)
      if (value === undefined) throw createMissingSecretError(this, name)
      resolved[name] = value
    }
    return resolved
  }

  private lookup(name: string): string | undefined {
    const prefixed = `${this.prefix}${name}`
    const candidates = this.allowPlain
      ? [process.env[name], process.env[prefixed]]
      : [process.env[prefixed]]
    return candidates.find((candidate) => typeof candidate === 'string')
  }
}

export function createDefaultSecretProvider(): SecretProvider {
  return new EnvSecretProvider()
}
