/**
 * @module @kb-labs/review/llm
 * LLM-based analysis for KB Labs AI Review
 */

// Re-export BaseLLMAnalyzer from contracts (for backward compatibility)
export { BaseLLMAnalyzer } from '../contracts/index.js';

// Built-in analyzers (v1 - per-file analysis)
export { ArchitectureAnalyzer } from './analyzers/architecture-analyzer.js';
export { SecurityAnalyzer } from './analyzers/security-analyzer.js';
export { NamingAnalyzer } from './analyzers/naming-analyzer.js';

// LLM-Lite mode (v2 - batch analysis with verification)
export {
  LLMLiteAnalyzer,
  runLLMLiteAnalysis,
  type LLMLiteRequest,
  type LLMLiteResult,
  // Tool execution
  ToolExecutor,
  createToolExecutor,
  buildToolDefinitions,
  type ToolCall,
  type ToolResult,
  type RawFinding,
  type ToolBudget,
  DEFAULT_BUDGET,
  // Verification
  VerificationEngine,
  createVerificationEngine,
  type VerificationChecks,
  type VerifiedFinding,
  type VerificationResult,
  // Category validation
  CategoryValidator,
  createCategoryValidator,
  getCategoryValidator,
  discoverCategories,
  buildCategoryAliases,
  // ReviewConfig is now exported from @kb-labs/review/contracts
} from './llm-lite/index.js';
