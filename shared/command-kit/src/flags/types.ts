/**
 * @module @kb-labs/shared-command-kit/flags/types
 * Types for flag validation and schema definition
 */

/**
 * Flag type definition
 */
export type FlagType = 'boolean' | 'string' | 'number' | 'array';

/**
 * Base flag schema definition
 */
export interface BaseFlagSchema<T extends FlagType = FlagType> {
  /** Flag name */
  name?: string;
  /** Flag type */
  type: T;
  /** Short alias (e.g., 'n' for 'dry-run') */
  alias?: string;
  /** Description for help text */
  description?: string;
  /** Default value if flag is not provided */
  default?: unknown;
  /** Whether flag is required */
  required?: boolean;
  /** Whether CLI output and diagnostics must redact this flag's value */
  secret?: boolean;
  /** Flags that conflict with this flag */
  conflicts?: string[];
  /** Flags that this flag depends on */
  dependsOn?: string[];
  /** Flags that are implied when this flag is set */
  implies?: string[] | [string, unknown][];
  // Note: transform is defined in child interfaces with specific types
}

/**
 * Boolean flag schema
 */
export interface BooleanFlagSchema extends BaseFlagSchema<'boolean'> {
  type: 'boolean';
  default?: boolean;
  /** Transform function to apply to the value */
  transform?: (value: boolean) => boolean | Promise<boolean>;
}

/**
 * String flag schema
 */
export interface StringFlagSchema extends BaseFlagSchema<'string'> {
  type: 'string';
  default?: string;
  /** Allowed values (enum) */
  choices?: readonly string[];
  /** Regex pattern for validation */
  pattern?: RegExp;
  /** Minimum string length */
  minLength?: number;
  /** Maximum string length */
  maxLength?: number;
  /** Custom validation function */
  validate?: (value: string) => true | string | Promise<true | string>;
  /** Transform function to apply to the value */
  transform?: (value: string) => string | Promise<string>;
}

/**
 * Number flag schema
 */
export interface NumberFlagSchema extends BaseFlagSchema<'number'> {
  type: 'number';
  default?: number;
  /** Minimum value */
  min?: number;
  /** Maximum value */
  max?: number;
  /** Custom validation function */
  validate?: (value: number) => true | string | Promise<true | string>;
  /** Transform function to apply to the value */
  transform?: (value: number) => number | Promise<number>;
}

/**
 * Array flag schema
 */
export interface ArrayFlagSchema extends BaseFlagSchema<'array'> {
  type: 'array';
  default?: unknown[];
  /** Type of array items */
  items?: 'string' | 'number' | 'boolean';
  /** Minimum array length */
  minLength?: number;
  /** Maximum array length */
  maxLength?: number;
  /** Transform function to apply to the value */
  transform?: (value: unknown[]) => unknown[] | Promise<unknown[]>;
}

/**
 * Union of all flag schema types
 */
export type FlagSchema =
  | BooleanFlagSchema
  | StringFlagSchema
  | NumberFlagSchema
  | ArrayFlagSchema;

/**
 * Flag schema definition object (for defineFlags)
 */
export type FlagSchemaDefinition = Record<string, Omit<FlagSchema, 'name'>>;

/**
 * Validation error
 */
export class FlagValidationError extends Error {
  constructor(
    public readonly flag: string,
    message: string,
    public readonly value?: unknown,
    public readonly schema?: FlagSchemaDefinition,
    public readonly commandName?: string
  ) {
    super(message);
    this.name = 'FlagValidationError';
  }
}

/**
 * Validation result
 */
export interface ValidationResult<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  errors?: Array<{
    flag: string;
    message: string;
    value?: unknown;
  }>;
}

/**
 * Safe validation result (doesn't throw)
 */
export interface SafeValidationResult<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  errors: Array<{
    flag: string;
    message: string;
    value?: unknown;
  }>;
}

