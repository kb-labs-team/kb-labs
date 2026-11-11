import type { SchemaReference } from './api';

export interface CommandContract {
  id: string;
  description?: string;
  input?: SchemaReference;
  output?: SchemaReference;
  produces?: string[];
  consumes?: string[];
  examples?: string[];
}

export type CommandContractsMap = Record<string, CommandContract>;

