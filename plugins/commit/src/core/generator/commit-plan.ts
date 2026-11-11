/**
 * Main commit plan generator
 */

/* eslint-disable no-await-in-loop -- Sequential LLM calls and git operations required for commit plan generation phases */

import type { CommitPlan, GitStatus, FileSummary, CommitGroup } from '../../contracts/index.js';
import type { GenerateOptions } from '../types';
import { AdapterUnavailableError, useLogger, useAnalytics, useLLM, type LLMMessage } from '@kb-labs/sdk';
import { COMMIT_PLAN_TOOL, COMMIT_PLAN_TOOL_PHASE3 } from './commit-tools';
import { getGitStatus, getAllChangedFiles } from '../analyzer/git-status';
import { getFileSummaries, getFileDiffs } from '../analyzer/file-summary';
import { getRecentCommits } from '../analyzer/recent-commits';
import {
  buildPromptWithDiff,
  buildEnhancedPrompt,
  parseResponse,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_WITH_DIFF,
  type ParsedLLMResponse,
} from './llm-prompt';
import { generateHeuristicPlan } from './heuristics';
import { analyzePatterns, type PatternAnalysis } from './pattern-detector';
import {
  detectSecretFiles,
  detectSecretsWithLocation,
  formatSecretsWarning,
  formatSecretsReport,
  SecretsDetectedError,
  type SecretMatch,
} from '../analyzer/secrets-detector';
import { promptUserConfirmation } from '../utils/prompt';

/** Confidence threshold - below this we escalate to Phase 2 with diff */
const CONFIDENCE_THRESHOLD = 0.7;

/** Maximum retry attempts for LLM generation (both phases) */
const MAX_LLM_RETRIES = 2;
const VALID_COMMIT_TYPES = new Set(['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'build', 'ci', 'perf']);

function normalizeCommitId(id: string | undefined): string | undefined {
  if (!id) { return undefined; }
  const trimmed = id.trim();
  if (!trimmed) { return undefined; }

  if (/^c\d+$/i.test(trimmed)) {
    return `c${trimmed.replace(/^c/i, '')}`;
  }

  if (/^\d+$/.test(trimmed)) {
    return `c${trimmed}`;
  }

  return trimmed;
}

function buildFallbackMessage(files: string[]): string {
  const firstFile = files[0];
  const fileName = firstFile ? firstFile.split('/').pop() ?? firstFile : 'files';
  return files.length === 1 ? `update ${fileName}` : `update ${files.length} files`;
}

function toSafeCommitGroup(
  commit: Partial<CommitGroup> & { files?: string[] },
  id: string
): CommitGroup | null {
  const files = Array.isArray(commit.files)
    ? commit.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
    : [];
  if (files.length === 0) {
    return null;
  }

  const uniqueFiles = [...new Set(files)];
  const type = typeof commit.type === 'string' && VALID_COMMIT_TYPES.has(commit.type)
    ? commit.type
    : 'chore';
  const message = typeof commit.message === 'string' && commit.message.trim().length > 0
    ? commit.message.trim()
    : buildFallbackMessage(uniqueFiles);
  const releaseHint = commit.releaseHint
    ?? (type === 'feat' ? 'minor' : (type === 'fix' || type === 'refactor' ? 'patch' : 'none'));

  return {
    id,
    type,
    scope: commit.scope,
    message,
    body: commit.body,
    files: uniqueFiles,
    releaseHint,
    breaking: Boolean(commit.breaking),
    reasoning: commit.reasoning ?? {
      newBehavior: false,
      fixesBug: false,
      internalOnly: true,
      explanation: 'Generated from Phase 3 fallback due invalid or incomplete LLM commit action.',
      confidence: 0.3,
    },
  };
}

/**
 * Generate a commit plan from current git changes
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Main orchestrator: scope resolution, git status, file analysis, LLM phases (1 & 2), validation, retry logic, heuristics, anti-hallucination checks
export async function generateCommitPlan(options: GenerateOptions): Promise<CommitPlan> {
  const { cwd, onProgress } = options;

  const logger = useLogger();
  const analytics = useAnalytics();
  // Gated on options.llmComplete (undefined when the caller's config has LLM
  // disabled — see run.ts's resolveContext), not just on useLLM() truthiness.
  // The platform's LLM adapter is registered independently of this plugin's
  // llm.enabled setting, so useLLM() alone stays truthy even when the commit
  // plugin should never call the gateway.
  const llm = options.llmComplete ? useLLM() : undefined;
  const startTime = Date.now();

  // 1. Get git status — cwd is already the resolved scope directory
  const gitStatus = await getGitStatus(cwd);
  const allFiles = getAllChangedFiles(gitStatus);

  if (allFiles.length === 0) {
    return createEmptyPlan(cwd, gitStatus);
  }

  // 3. 🔒 Security: Check for secret files early - ABORT if found!
  const secretFiles = detectSecretFiles(allFiles);

  if (secretFiles.length > 0) {
    // Create basic matches for secret files (no location info yet - just filenames)
    const basicMatches: SecretMatch[] = secretFiles.map(file => ({
      file,
      line: 0,
      column: 0,
      pattern: 'SECRET_FILE_PATTERN',
      patternName: 'Secret File Pattern',
      snippet: '',
      matchedText: file,
    }));

    const warning = formatSecretsWarning(secretFiles);
    await logger.error('🚨 SECRETS DETECTED', new Error('Secrets detected'), {
      secretFiles,
    });
    options.onOutput(`\n${warning}\n`);

    // Check if --allow-secrets flag is set
    if (!options.allowSecrets) {
      // No bypass flag - ABORT immediately
      throw new SecretsDetectedError(
        basicMatches,
        `Secrets detected in ${secretFiles.length} file(s). Use --allow-secrets to bypass after review, or add files to .gitignore.`
      );
    }

    // --allow-secrets flag is set - ask for user confirmation
    options.onOutput('\n⚠️  WARNING: --allow-secrets flag detected\n');
    options.onPauseProgress?.();
    const confirmed = await promptUserConfirmation(
      `⚠️  Proceed with committing ${secretFiles.length} file(s) that may contain secrets?`,
      options.onOutput,
      false, // default: NO
      options.autoConfirm,
    );
    options.onResumeProgress?.();

    if (!confirmed) {
      // User declined - ABORT
      throw new SecretsDetectedError(
        basicMatches,
        'User declined to commit files with potential secrets.'
      );
    }

    // User confirmed - log warning and continue
    await logger.warn('User confirmed to proceed with files containing potential secrets', {
      secretFiles,
      confirmedAt: new Date().toISOString(),
    });
    options.onOutput('✅ User confirmed - continuing with commit generation...\n');
  }

  // 4. Get file summaries (diff stats)
  const summaries = await getFileSummaries(cwd, allFiles);

  // 5. Analyze patterns BEFORE LLM (pre-processing)
  const patternAnalysis = analyzePatterns(summaries);

  // Track pattern detection
  if (patternAnalysis.confidence > 0.7) {
    await analytics?.track('commit.pattern-detected', {
      patternType: patternAnalysis.patternType,
      confidence: patternAnalysis.confidence,
      suggestedType: patternAnalysis.suggestedType,
      fileCount: summaries.length,
      hints: patternAnalysis.hints,
    });

    // Log pattern detection for debugging
    await logger.debug(`Pattern detected: ${patternAnalysis.patternType} (confidence: ${patternAnalysis.confidence.toFixed(2)})`, {
      suggestedType: patternAnalysis.suggestedType,
      hints: patternAnalysis.hints,
    });
  }

  // 6. Get recent commits for style reference
  const recentCommits = options.recentCommits ?? await getRecentCommits(cwd, 10);

  // 7. Generate plan using LLM (two-phase) or heuristics
  let commits: CommitGroup[];
  let llmUsed = false;
  let tokensUsed: number | undefined;
  let escalated = false;

  if (llm) {
    try {
      // Check if LLM supports native tools (chatWithTools)
      const supportsNativeTools = typeof llm.chatWithTools === 'function';

      let parsed: ParsedLLMResponse;

      if (supportsNativeTools) {
        // NEW: Use native tools approach (guaranteed structured output)
        await logger.debug('Using native tools approach (chatWithTools)');
        onProgress?.('Analyzing with native tools...');

        const result = await generateWithNativeTools(
          llm,
          summaries,
          patternAnalysis,
          recentCommits,
          logger,
          onProgress
        );

        parsed = result.parsed;
        tokensUsed = result.tokensUsed;
        llmUsed = true;
      } else {
        // FALLBACK: Text-based parsing for LLMs without chatWithTools support
        await logger.debug('Using text-based parsing (fallback)');
        onProgress?.('Analyzing with text-based LLM...');

        const prompt = buildEnhancedPrompt(summaries, patternAnalysis, recentCommits);

        const result = await retryLLMCall(
          () => llm.complete(prompt, {
            systemPrompt: SYSTEM_PROMPT,
            temperature: 0.3,
            maxTokens: 2000,
          }),
          'Phase 1',
          logger,
          onProgress
        );

        parsed = parseResponse(result.content, summaries, patternAnalysis);
        llmUsed = true;
        tokensUsed = result.tokensUsed;
      }

      // Phase 2: Escalate if LLM requests more context, confidence is low, or 10+ files
      const shouldEscalate = parsed.needsMoreContext
        || parsed.averageConfidence < CONFIDENCE_THRESHOLD
        || summaries.length >= 10;

      if (shouldEscalate) {
        const reason = summaries.length >= 10
          ? `${summaries.length} files (≥10)`
          : `confidence ${(parsed.averageConfidence * 100).toFixed(0)}%`;
        await logger.debug(`Escalating to Phase 2: ${reason}`, {
          fileCount: summaries.length,
          confidence: parsed.averageConfidence,
          needsMoreContext: parsed.needsMoreContext,
          requestedFiles: parsed.requestedFiles,
        });
        onProgress?.(`${reason} - fetching diff...`);

        // Get diff for requested files with smart selection
        // 1. If LLM specified files, use them (max 15)
        // 2. If empty/none specified, auto-select top 15 most changed files
        let filesToDiff: string[];

        if (parsed.requestedFiles.length > 0) {
          // LLM requested specific files - validate they exist and limit to 15
          const validFiles = parsed.requestedFiles.filter((f) => summaries.some((s) => s.path === f));
          filesToDiff = validFiles.slice(0, 15); // Truncate to max 15

          if (validFiles.length > 15) {
            await logger.warn(`LLM requested ${validFiles.length} files, truncated to 15 most critical`, {
              requestedCount: validFiles.length,
              truncatedCount: 15,
            });
          }
        } else {
          // No files specified - auto-select top 15 by change size
          const sortedByChanges = [...summaries].sort((a, b) => {
            const aChanges = (a.additions ?? 0) + (a.deletions ?? 0);
            const bChanges = (b.additions ?? 0) + (b.deletions ?? 0);
            return bChanges - aChanges; // Descending order
          });

          filesToDiff = sortedByChanges.slice(0, 15).map((s) => s.path);

          await logger.debug('Auto-selected top 15 most changed files for Phase 2', {
            totalFiles: summaries.length,
            selectedCount: filesToDiff.length,
          });
        }

        const diffs = await getFileDiffs(cwd, filesToDiff);

        // 🔒 Security: Check for secrets in diffs with EXACT LOCATION
        const secretMatches = detectSecretsWithLocation(diffs);

        if (secretMatches.length > 0) {
          // Found secrets in diff content with exact locations
          const report = formatSecretsReport(secretMatches);
          await logger.error('🚨 SECRETS DETECTED IN DIFF CONTENT', new Error('Secrets in diff'), {
            secretMatches,
          });
          onProgress?.('🚨 Secrets detected in diff');

          // Show detailed report to user
          options.onOutput(`\n${report}\n`);

          // Check if --allow-secrets flag is set
          if (!options.allowSecrets) {
            // No bypass flag - ABORT immediately
            throw new SecretsDetectedError(
              secretMatches,
              `Secrets detected in ${secretMatches.length} location(s). Use --allow-secrets to bypass after review, or remove secrets before committing.`
            );
          }

          // --allow-secrets flag is set - ask for user confirmation (or auto-confirm with --yes)
          options.onOutput('\n⚠️  WARNING: --allow-secrets flag detected\n');
          options.onPauseProgress?.();
          const confirmed = await promptUserConfirmation(
            `⚠️  Proceed with committing changes that contain ${secretMatches.length} potential secret(s)?`,
            options.onOutput,
            false, // default: NO
            options.autoConfirm, // auto-confirm if --yes flag
          );
          options.onResumeProgress?.();

          if (!confirmed) {
            // User declined - ABORT
            throw new SecretsDetectedError(
              secretMatches,
              'User declined to commit changes with potential secrets.'
            );
          }

          // User confirmed - log warning and continue
          await logger.warn('User confirmed to proceed with diff containing potential secrets', {
            secretMatches: secretMatches.map(m => ({ file: m.file, line: m.line, pattern: m.patternName })),
            confirmedAt: new Date().toISOString(),
          });
          options.onOutput('✅ User confirmed - continuing with Phase 2 analysis...\n');
          onProgress?.('Re-analyzing with diff context (Phase 2)...');
        }

        if (diffs.size > 0) {
          // Phase 2: Re-generate with diff context
          // Scale maxTokens with file count: more files = more commits = more tokens needed
          const maxTokensPhase2 = Math.min(6000, 3000 + Math.floor(summaries.length / 20) * 500);

          await logger.debug('Re-analyzing with diff context (Phase 2)', {
            filesWithDiff: filesToDiff.length,
            supportsNativeTools,
          });
          onProgress?.('Re-analyzing with diff context (Phase 2)...');

          if (supportsNativeTools) {
            // Phase 2 with native tools
            const resultWithDiff = await generateWithNativeToolsPhase2(
              llm,
              summaries,
              diffs,
              recentCommits,
              logger,
              onProgress
            );

            parsed = resultWithDiff.parsed;
            tokensUsed = (tokensUsed ?? 0) + (resultWithDiff.tokensUsed ?? 0);
            escalated = true;
          } else {
            // Phase 2 with text-based parsing (fallback)
            const promptWithDiff = buildPromptWithDiff(summaries, diffs, recentCommits);

            const resultWithDiff = await retryLLMCall(
              () => llm.complete(promptWithDiff, {
                systemPrompt: SYSTEM_PROMPT_WITH_DIFF,
                temperature: 0.3,
                maxTokens: maxTokensPhase2,
              }),
              'Phase 2',
              logger,
              onProgress
            );

            parsed = parseResponse(resultWithDiff.content, summaries, patternAnalysis);
            tokensUsed = (tokensUsed ?? 0) + (resultWithDiff.tokensUsed ?? 0);
            escalated = true;
          }
        }
      }

      commits = parsed.commits;

      // Validate that all files from summaries are included (may invoke Phase 3)
      commits = await validateAndFixCommits(commits, summaries, llm, llmUsed, logger, onProgress);
    } catch (error) {
      // CRITICAL: Re-throw SecretsDetectedError immediately - DO NOT fallback to heuristics!
      if (error instanceof SecretsDetectedError) {
        throw error;
      }

      // Fallback to heuristics ONLY for LLM errors (parse, timeout, etc.)
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error && error.stack ? error.stack : '';
      if (error instanceof AdapterUnavailableError && error.reason === 'not-configured') {
        throw error;
      } else {
        await logger.warn(`LLM generation failed, falling back to heuristics: ${errMsg}`, {
          error: errMsg,
          stack: errStack,
        });
        onProgress?.(`LLM failed, using heuristics: ${errMsg}`);
      }
      commits = generateHeuristicPlan(summaries);
    }
  } else {
    throw new AdapterUnavailableError('llm');
  }

  // 6. Track analytics
  const typeDistribution = commits.reduce((acc, commit) => {
    acc[commit.type] = (acc[commit.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  await analytics?.track('commit.generation-complete', {
    totalFiles: summaries.length,
    totalCommits: commits.length,
    llmUsed,
    escalated,
    tokensUsed,
    durationMs: Date.now() - startTime,
    typeDistribution,
    cwd,
  });

  // 7. Build final plan
  return {
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    repoRoot: cwd,
    gitStatus,
    commits,
    metadata: {
      totalFiles: summaries.length,
      totalCommits: commits.length,
      llmUsed,
      tokensUsed,
      escalated,
    },
  };
}

/**
 * Create empty plan when no changes
 */
function createEmptyPlan(cwd: string, gitStatus: GitStatus): CommitPlan {
  return {
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    repoRoot: cwd,
    gitStatus,
    commits: [],
    metadata: {
      totalFiles: 0,
      totalCommits: 0,
      llmUsed: false,
    },
  };
}


/**
 * Generate commits using native tools (chatWithTools) - Phase 1
 * Returns structured output without JSON parsing errors
 */
async function generateWithNativeTools(
  llm: ReturnType<typeof useLLM>,
  summaries: FileSummary[],
  patternAnalysis: PatternAnalysis,
  recentCommits: string[],
  logger: ReturnType<typeof useLogger>,
  _onProgress?: (message: string) => void
): Promise<{ parsed: ParsedLLMResponse; tokensUsed?: number }> {
  if (!llm || !llm.chatWithTools) {
    throw new Error('LLM does not support native tools (chatWithTools)');
  }

  // Build user prompt (without JSON format instructions)
  const userPrompt = buildEnhancedPrompt(summaries, patternAnalysis, recentCommits);

  // Build messages
  // Note: SYSTEM_PROMPT contains JSON format instructions which are automatically
  // ignored by OpenAI when using native tools (tool schema takes precedence)
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: userPrompt,
    },
  ];

  // Call LLM with native tools
  const response = await llm.chatWithTools(messages, {
    tools: [COMMIT_PLAN_TOOL],
    toolChoice: {
      type: 'function',
      function: { name: 'generate_commit_plan' },
    },
    temperature: 0.3,
  });

  // Extract tool call
  const toolCall = response.toolCalls?.[0];
  if (!toolCall || toolCall.name !== 'generate_commit_plan') {
    throw new Error('LLM did not call generate_commit_plan tool');
  }

  // Tool call input is already parsed JSON (no JSON.parse needed!)
  const toolArgs = toolCall.input as {
    needsMoreContext?: boolean;
    requestedFiles?: string[];
    commits: CommitGroup[];
  };

  // Calculate average confidence from commits
  const totalConfidence = toolArgs.commits.reduce((sum, c) => {
    const confidence = c.reasoning?.confidence ?? 0.5;
    return sum + confidence;
  }, 0);
  const averageConfidence = toolArgs.commits.length > 0
    ? totalConfidence / toolArgs.commits.length
    : 0;

  await logger.debug('Native tools Phase 1 result', {
    needsMoreContext: toolArgs.needsMoreContext,
    requestedFiles: toolArgs.requestedFiles?.length ?? 0,
    commitsCount: toolArgs.commits.length,
    averageConfidence,
  });

  return {
    parsed: {
      needsMoreContext: Boolean(toolArgs.needsMoreContext),
      requestedFiles: toolArgs.requestedFiles ?? [],
      commits: toolArgs.commits,
      averageConfidence,
    },
    tokensUsed: response.usage ? (response.usage.promptTokens + response.usage.completionTokens) : undefined,
  };
}

/**
 * Generate commits for missing files using native tools (Phase 3)
 * Called when LLM forgot to include some files in Phase 1/2
 * May return multiple commits if files should be grouped differently
 */
async function generateMissingFilesCommit(
  llm: ReturnType<typeof useLLM>,
  missingSummaries: FileSummary[],
  existingCommits: CommitGroup[],
  logger: ReturnType<typeof useLogger>,
  onProgress?: (message: string) => void
): Promise<CommitGroup[] | null> {
  if (!llm || !llm.chatWithTools) {
    return null; // Fallback to generic commit if no LLM
  }

  // Build context: what commits were already created (with IDs and files for extend_existing action)
  const existingCommitsContext = existingCommits
    .map((c) => {
      const filesPreview = c.files.length <= 3
        ? c.files.join(', ')
        : `${c.files.slice(0, 3).join(', ')} and ${c.files.length - 3} more`;
      return `[${c.id}] ${c.type}${c.scope ? `(${c.scope})` : ''}: ${c.message}\n   Files: ${filesPreview}`;
    })
    .join('\n\n');

  // Build prompt for missing files
  const missingFilesList = missingSummaries
    .map((s) => {
      const stats = s.binary ? 'binary' : `+${s.additions}/-${s.deletions}`;
      const isNew = s.isNewFile ? 'IsNewFile: true' : 'IsNewFile: false';
      return `- ${s.path} (${s.status}, ${stats}, ${isNew})`;
    })
    .join('\n');

  const systemPrompt = `You are analyzing files that were not included in the initial commit plan.

CONTEXT: These files were not classified by the LLM in previous phases. Your task is to determine:
1. Why they were missed (config files, minor changes, unrelated changes, etc.)
2. Whether they belong to an EXISTING commit or need a NEW commit
3. What type of commit they should be (chore, refactor, fix, feat, docs, test, etc.)

CRITICAL: You have TWO actions available:

ACTION 1: extend_existing (PREFER THIS if file is related to existing commit)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use when a file logically belongs to an already created commit.

Example: If existing commit is "feat(fs): add fs adapter" and you see:
- packages/adapters-fs/src/secure-storage.test.ts (test for fs adapter)

Then use:
{
  "action": "extend_existing",
  "existingCommitId": "c1",
  "files": ["packages/adapters-fs/src/secure-storage.test.ts"]
}

The file will be added to commit c1 instead of creating a new commit.

ACTION 2: create_new (use when file is unrelated to existing commits)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use when files don't fit into any existing commit.

DEFAULT to "chore" unless you see clear evidence of feat/fix/refactor.

IMPORTANT: These are leftover files - they are usually:
- Configuration files (package.json, tsconfig.json, etc.)
- Minor updates to existing files
- Test files or documentation
- Build/tooling changes

CRITICAL: WRITE INFORMATIVE COMMIT MESSAGES (not generic):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ BAD (too generic):
- "update files"
- "update configuration"
- "update additional files"
- "update 30 files"

✅ GOOD (specific and descriptive):
- "update TypeScript and ESLint configuration for strict mode"
- "update package dependencies for security patches"
- "update build configuration to support ESM modules"

Guidelines:
- Include WHAT was changed (specific files/components)
- Include WHY if relevant (context about the change)
- Use concrete nouns (not "files", "additional files")
- Add context that helps reviewers understand the change`;

  const userPrompt = `Existing commits (you can add files to these using extend_existing action):
${existingCommitsContext}

Files that need classification (${missingSummaries.length} remaining):
${missingFilesList}

IMPORTANT: You don't need to classify ALL files in one response if there are too many.
- If you can confidently classify some files → do it
- If you're unsure about some files → skip them (they'll be processed in next iteration)
- Focus on files you can group logically

For each file, choose the appropriate action:
1. extend_existing - if file belongs to an existing commit (e.g., test file for fs adapter → add to "feat(fs): add fs adapter")
2. create_new - if file doesn't fit into any existing commit

You may create:
- ONE new commit if all remaining files are related (same purpose, same change type)
- MULTIPLE new commits if files have different purposes (e.g., separate config changes from test updates)
- MIX of extend_existing and create_new actions (recommended!)

CRITICAL: Be specific in each commit message - describe WHAT is being changed, not just "update files".
PREFER extend_existing when possible to avoid creating unnecessary commits.`;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    onProgress?.('Classifying remaining files (Phase 3)...');

    const response = await llm.chatWithTools(messages, {
      tools: [COMMIT_PLAN_TOOL_PHASE3],
      toolChoice: {
        type: 'function',
        function: { name: 'generate_commit_plan' },
      },
      temperature: 0.3,
    });

    const toolCall = response.toolCalls?.[0];
    if (!toolCall || toolCall.name !== 'generate_commit_plan') {
      await logger.warn('Phase 3: LLM did not call tool, using fallback');
      return null;
    }

    const toolArgs = toolCall.input as {
      commits: Array<CommitGroup & { action?: 'create_new' | 'extend_existing'; existingCommitId?: string }>;
    };

    if (!toolArgs.commits || toolArgs.commits.length === 0) {
      await logger.warn('Phase 3: LLM returned empty commits, using fallback');
      return null;
    }

    // Process each commit action
    const newCommits: CommitGroup[] = [];
    let extendedCount = 0;
    let createdCount = 0;

    for (const commit of toolArgs.commits) {
      if (!Array.isArray(commit.files) || commit.files.length === 0) {
        await logger.warn('Phase 3: Skipping commit action with empty files', {
          action: commit.action,
          existingCommitId: commit.existingCommitId,
        });
        continue;
      }

      const action = commit.action || 'create_new'; // Default to create_new for backward compatibility

      if (action === 'extend_existing') {
        // Find existing commit by ID
        const normalizedRequestedId = normalizeCommitId(commit.existingCommitId);
        const existingCommit = existingCommits.find(c => normalizeCommitId(c.id) === normalizedRequestedId);
        if (existingCommit) {
          // Add files to existing commit
          existingCommit.files.push(...commit.files);
          extendedCount++;
          await logger.debug('Phase 3: Extended existing commit', {
            commitId: existingCommit.id,
            message: existingCommit.message,
            addedFiles: commit.files.length,
          });
        } else {
          // Fallback: create new commit if ID not found
          await logger.warn('Phase 3: Commit ID not found, creating new instead', {
            requestedId: commit.existingCommitId,
            normalizedRequestedId,
            availableIds: existingCommits.map(c => c.id).slice(0, 10),
          });
          const safeCommit = toSafeCommitGroup(
            commit,
            `c${existingCommits.length + newCommits.length + 1}`
          );
          if (safeCommit) {
            newCommits.push(safeCommit);
            createdCount++;
          } else {
            await logger.warn('Phase 3: Fallback commit had no valid files, skipped', {
              requestedId: commit.existingCommitId,
            });
          }
        }
      } else {
        // action === 'create_new'
        const safeCommit = toSafeCommitGroup(
          commit,
          `c${existingCommits.length + newCommits.length + 1}`
        );
        if (safeCommit) {
          newCommits.push(safeCommit);
          createdCount++;
        } else {
          await logger.warn('Phase 3: create_new action had no valid files, skipped');
        }
      }
    }

    await logger.debug('Phase 3: Processed commits', {
      total: toolArgs.commits.length,
      extended: extendedCount,
      created: createdCount,
      newCommitsCount: newCommits.length,
    });

    return newCommits;
  } catch (error) {
    await logger.warn('Phase 3 failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Generate commits using native tools (chatWithTools) - Phase 2 with diff
 * Returns structured output without JSON parsing errors
 */
async function generateWithNativeToolsPhase2(
  llm: ReturnType<typeof useLLM>,
  summaries: FileSummary[],
  diffs: Map<string, string>,
  recentCommits: string[],
  logger: ReturnType<typeof useLogger>,
  _onProgress?: (message: string) => void
): Promise<{ parsed: ParsedLLMResponse; tokensUsed?: number }> {
  if (!llm || !llm.chatWithTools) {
    throw new Error('LLM does not support native tools (chatWithTools)');
  }

  // Build user prompt with diff context
  const userPrompt = buildPromptWithDiff(summaries, diffs, recentCommits);

  // Build messages
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: SYSTEM_PROMPT_WITH_DIFF,
    },
    {
      role: 'user',
      content: userPrompt,
    },
  ];

  // Call LLM with native tools
  const response = await llm.chatWithTools(messages, {
    tools: [COMMIT_PLAN_TOOL],
    toolChoice: {
      type: 'function',
      function: { name: 'generate_commit_plan' },
    },
    temperature: 0.3,
  });

  // Extract tool call
  const toolCall = response.toolCalls?.[0];
  if (!toolCall || toolCall.name !== 'generate_commit_plan') {
    throw new Error('LLM did not call generate_commit_plan tool in Phase 2');
  }

  // Tool call input is already parsed JSON (no JSON.parse needed!)
  const toolArgs = toolCall.input as {
    needsMoreContext?: boolean;
    requestedFiles?: string[];
    commits: CommitGroup[];
  };

  // Calculate average confidence from commits
  const totalConfidence = toolArgs.commits.reduce((sum, c) => {
    const confidence = c.reasoning?.confidence ?? 0.5;
    return sum + confidence;
  }, 0);
  const averageConfidence = toolArgs.commits.length > 0
    ? totalConfidence / toolArgs.commits.length
    : 0;

  await logger.debug('Native tools Phase 2 result', {
    commitsCount: toolArgs.commits.length,
    averageConfidence,
  });

  return {
    parsed: {
      needsMoreContext: false, // Phase 2 is final, no more escalation
      requestedFiles: [],
      commits: toolArgs.commits,
      averageConfidence,
    },
    tokensUsed: response.usage ? (response.usage.promptTokens + response.usage.completionTokens) : undefined,
  };
}

export interface ValidationResult {
  commits: CommitGroup[];
  warnings: string[];
  hallucinations: string[];
}

/**
 * Anti-hallucination validation: ensure LLM output matches reality
 * 1. Remove hallucinated files (files that don't exist in git status)
 * 2. Remove duplicate files (file appears in multiple commits)
 * 3. Add missing files that LLM forgot (Phase 3: use LLM if available)
 * 4. Track warnings for debugging
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Anti-hallucination checks: detects hallucinated files, removes duplicates, groups forgotten files, optional LLM phase 3, tracks warnings
async function validateAndFixCommits(
  commits: CommitGroup[],
  summaries: FileSummary[],
  llm: ReturnType<typeof useLLM>,
  llmUsed: boolean,
  logger: ReturnType<typeof useLogger>,
  onProgress?: (message: string) => void
): Promise<CommitGroup[]> {
  const realFiles = new Set(summaries.map((s) => s.path));
  const hallucinations: string[] = [];

  // Step 1: Remove hallucinated files from each commit
  for (const commit of commits) {
    const validFiles: string[] = [];
    for (const file of commit.files) {
      if (realFiles.has(file)) {
        validFiles.push(file);
      } else {
        hallucinations.push(file);
      }
    }
    commit.files = validFiles;
  }

  // Step 2: Remove empty commits (all files were hallucinated)
  let nonEmptyCommits = commits.filter((c) => c.files.length > 0);

  // Step 3: Remove duplicate files - keep only first occurrence
  const seenFiles = new Set<string>();
  const duplicates: Array<{ file: string; commit: string }> = [];

  for (const commit of nonEmptyCommits) {
    const uniqueFiles: string[] = [];
    for (const file of commit.files) {
      if (!seenFiles.has(file)) {
        uniqueFiles.push(file);
        seenFiles.add(file);
      } else {
        duplicates.push({ file, commit: commit.id });
      }
    }
    commit.files = uniqueFiles;
  }

  // Log duplicates for debugging LLM behavior
  if (duplicates.length > 0) {
    logger.warn(`LLM returned ${duplicates.length} duplicate file(s) across commits - removed duplicates`, {
      duplicateCount: duplicates.length,
      samples: duplicates.slice(0, 5).map(d => `${d.file} in ${d.commit}`),
    });
  }

  // Step 4: Remove commits that became empty after deduplication
  nonEmptyCommits = nonEmptyCommits.filter((c) => c.files.length > 0);

  // Step 5: Adaptive Phase 3 loop - process missing files iteratively (up to 5 iterations for heavy cases)
  const MAX_PHASE3_ITERATIONS = 5;
  let phase3Iteration = 0;

  while (phase3Iteration < MAX_PHASE3_ITERATIONS) {
    // Recalculate missing files after each iteration
    const allFilesInCommits = new Set(nonEmptyCommits.flatMap((c) => c.files));
    const missingFiles = summaries
      .map((s) => s.path)
      .filter((f) => !allFilesInCommits.has(f));

    if (missingFiles.length === 0) {
      // ✅ Success! All files classified
      if (phase3Iteration > 0) {
        await logger.info('Phase 3: All files classified', {
          totalIterations: phase3Iteration,
          totalCommits: nonEmptyCommits.length,
        });
      }
      break;
    }

    phase3Iteration++;

    await logger.debug(`Phase 3 iteration ${phase3Iteration}/${MAX_PHASE3_ITERATIONS}`, {
      missingFiles: missingFiles.length,
      processedSoFar: summaries.length - missingFiles.length,
      totalFiles: summaries.length,
      progress: `${Math.round(((summaries.length - missingFiles.length) / summaries.length) * 100)}%`,
    });

    // Update progress for user
    if (onProgress) {
      const progress = Math.round(((summaries.length - missingFiles.length) / summaries.length) * 100);
      onProgress(`Classifying remaining files (Phase 3, iteration ${phase3Iteration}, ${progress}%)...`);
    }

    // Get summaries for missing files only
    const missingSummaries = summaries.filter((s) => missingFiles.includes(s.path));

    // Try LLM to generate commits for missing files (may extend existing or create new)
    let missingCommits: CommitGroup[] | null = null;

    if (llmUsed && llm) {
      missingCommits = await generateMissingFilesCommit(
        llm,
        missingSummaries,
        nonEmptyCommits,  // ← pass updated commits list (includes previous iterations)
        logger,
        onProgress
      );

      if (missingCommits && missingCommits.length > 0) {
        await logger.debug(`Phase 3 iteration ${phase3Iteration}: Processed commits`, {
          commitCount: missingCommits.length,
          filesCount: missingCommits.reduce((sum, c) => sum + c.files.length, 0),
        });

        // Add new commits to the list (extended commits are already modified in place)
        nonEmptyCommits.push(...missingCommits);
      }
    }

    // Safety check: if LLM didn't process ANY files, break to avoid infinite loop
    const newMissingFiles = summaries
      .map((s) => s.path)
      .filter((f) => !new Set(nonEmptyCommits.flatMap(c => c.files)).has(f));

    if (newMissingFiles.length === missingFiles.length) {
      // LLM didn't process any files this iteration - something is wrong
      await logger.warn('Phase 3: LLM made no progress, stopping iterations', {
        iteration: phase3Iteration,
        stillMissing: newMissingFiles.length,
      });
      break;
    }

    // Safety: if only few files left and many iterations, use fallback to avoid over-iteration
    if (newMissingFiles.length <= 3 && phase3Iteration >= 2) {
      await logger.debug('Phase 3: Few files left, proceeding to fallback');
      break;
    }
  }

  // Fallback: if still missing files after MAX_ITERATIONS
  const finalMissingFiles = summaries
    .map((s) => s.path)
    .filter((f) => !new Set(nonEmptyCommits.flatMap(c => c.files)).has(f));

  if (finalMissingFiles.length > 0) {
    await logger.warn('Phase 3: Max iterations reached or LLM struggled, using fallback', {
      totalIterations: phase3Iteration,
      remainingFiles: finalMissingFiles.length,
    });

    const firstFile = finalMissingFiles[0];
    const fileName = firstFile ? firstFile.split('/').pop() ?? firstFile : 'files';
    const commitMessage = finalMissingFiles.length === 1
      ? `update ${fileName}`
      : `update ${finalMissingFiles.length} remaining files`;

    const fallbackCommit: CommitGroup = {
      id: `c${nonEmptyCommits.length + 1}`,
      type: 'chore',
      message: commitMessage,
      files: finalMissingFiles,
      releaseHint: 'none',
      breaking: false,
      reasoning: {
        newBehavior: false,
        fixesBug: false,
        internalOnly: true,
        explanation: `Files not classified after ${phase3Iteration} Phase 3 iteration(s): ${finalMissingFiles.slice(0, 3).join(', ')}${finalMissingFiles.length > 3 ? ` and ${finalMissingFiles.length - 3} more` : ''}`,
        confidence: 0.3,
      },
    };

    nonEmptyCommits.push(fallbackCommit);
  }

  return nonEmptyCommits;
}

/**
 * Retry LLM call with automatic fallback on parse errors
 * Tries up to MAX_LLM_RETRIES times before throwing
 */
async function retryLLMCall(
  llmFn: () => Promise<{ content: string; tokensUsed?: number }>,
  phase: string,
  logger: ReturnType<typeof useLogger>,
  onProgress?: (message: string) => void
): Promise<{ content: string; tokensUsed?: number }> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
    try {
      const result = await llmFn();

      // Try to parse response to validate JSON
      parseResponse(result.content);

      // Success - return result
      if (attempt > 1) {
        await logger.debug(`${phase} succeeded on attempt ${attempt}/${MAX_LLM_RETRIES}`);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // DEBUG: Log full error details
      await logger.error(`🔍 LLM call failed (attempt ${attempt})`, lastError, {
        errorName: lastError.name,
        errorMessage: lastError.message,
        errorStack: lastError.stack,
      });

      // Extract error type for better user feedback
      const errorType = getErrorType(lastError);

      if (attempt < MAX_LLM_RETRIES) {
        // Log to file with full details
        await logger.warn(`${phase} failed (attempt ${attempt}/${MAX_LLM_RETRIES}): ${errorType}`, {
          errorMessage: lastError.message,
          errorType,
          attempt,
          stack: lastError.stack?.split('\n').slice(0, 3).join('\n'), // First 3 lines only
        });

        // Show concise user message
        onProgress?.(`${phase} ${errorType}, retrying (${attempt}/${MAX_LLM_RETRIES})...`);

        // Short delay before retry (exponential backoff: 1s, 2s, 4s...)
        await new Promise((resolve) => {
          setTimeout(resolve, 1000 * Math.pow(2, attempt - 1));
        });
      } else {
        await logger.error(`${phase} failed after ${MAX_LLM_RETRIES} attempts: ${errorType}`, lastError, {
          errorType,
        });
      }
    }
  }

  // All retries exhausted
  throw lastError || new Error(`${phase} failed after ${MAX_LLM_RETRIES} attempts`);
}

/**
 * Extract user-friendly error type from error message
 */
function getErrorType(error: Error): string {
  const message = error.message.toLowerCase();

  // Rate limiting
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return 'rate limited (429)';
  }

  // Server errors
  if (message.includes('500') || message.includes('502') || message.includes('503')) {
    return 'server error (5xx)';
  }

  // Timeout
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }

  // Network errors
  if (message.includes('network') || message.includes('econnrefused') || message.includes('enotfound')) {
    return 'network error';
  }

  // Parse errors (invalid JSON from LLM)
  if (message.includes('json') || message.includes('parse') || message.includes('unexpected token')) {
    return 'invalid JSON';
  }

  // LLM response validation errors
  if (message.includes('missing') || message.includes('missing required field')) {
    return 'invalid structure';
  }

  // Generic - include first 50 chars of error for debugging
  const preview = error.message.substring(0, 50).replace(/\n/g, ' ');
  return `error: ${preview}${error.message.length > 50 ? '...' : ''}`;
}
