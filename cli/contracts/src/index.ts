/**
 * @module @kb-labs/cli-contracts
 *
 * Type definitions and contracts for KB Labs CLI framework.
 *
 * This package contains pure TypeScript type definitions with ZERO runtime dependencies.
 * It defines the contracts for:
 * - Commands (CliCommand interface)
 * - Context (CliContext, Profile interfaces)
 * - Presenters (Presenter interface for output)
 *
 * Versioning policy: V1, V2, etc. built into type names for API evolution.
 */

// System context
export type { SystemContext } from "./system-context";

// Presenter contracts
export type { Presenter } from "./presenter/index";

// Reserved command namespaces (single source of truth, see 06-command-naming.md §8)
export {
  RESERVED_NAMESPACES,
  SYSTEM_NAMESPACES,
  VERB_NAMESPACES,
  FIRST_PARTY_NAMESPACES,
  FUTURE_NAMESPACES,
  FIRST_PARTY_SCOPE,
  checkReservedNamespace,
  suggestNamespace,
  listReservedNamespaces,
} from "./reserved-namespaces";
export type { ReservedTier, ReservedNamespaceViolation } from "./reserved-namespaces";
