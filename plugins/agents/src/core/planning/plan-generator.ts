/**
 * Plan generator - creates execution plans using LLM with native tool calling
 */

import { useLLM, type LLMTool, type LLMToolCallResponse } from '@kb-labs/sdk';
import type { TaskPlan, Phase, AgentMode, AgentEvent, AgentEventCallback, Tracer, LLMTier } from '../../contracts/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import { createLLMCallEvent } from '../../tracing/index.js';
import { PlanValidator } from './plan-validator.js';

interface GeneratedPlanData {
  complexity?: 'simple' | 'medium' | 'complex';
  estimatedDuration?: string;
  markdown?: string;
  phases?: unknown[];
  refactorDecisions?: unknown[];
  changeSets?: unknown[];
  objective?: {
    currentState?: string;
    targetState?: string;
    constraints?: string[];
  };
  evidence?: unknown[];
  decisions?: unknown[];
  alternatives?: unknown[];
  verification?: unknown[];
  rollback?: {
    trigger?: string;
    steps?: string[];
  };
}

interface PlanningProfile {
  domain: 'code' | 'browser' | 'mcp' | 'general';
  availableTools: string[];
  preferredTools: string[];
  capabilities: string[];
}

interface PlanQualityAssessment {
  score: number;
  issues: string[];
  severeIssues: string[];
  metrics: {
    phaseCount: number;
    stepCount: number;
    changeStepCount: number;
    readOnlyStepCount: number;
    changeRatio: number;
    hasPlaceholders: boolean;
    analysisPhaseCount: number;
    solutionStepRatio: number;
  };
}

interface DelegatedResearchOutput {
  summary: string;
  findings: string[];
}

/**
 * Generates execution plans from task descriptions
 */
export class PlanGenerator {
  /**
   * Generate a task execution plan using native tool calling
   */
  async generate(config: {
    task: string;
    sessionId: string;
    mode: AgentMode;
    complexity?: 'simple' | 'medium' | 'complex';
    toolRegistry?: ToolRegistry;
    researchContext?: string; // Context from research phase (if available)
    onEvent?: AgentEventCallback;
    agentId?: string;
    parentAgentId?: string;
    tracer?: Tracer;
    tier?: LLMTier;
  }): Promise<TaskPlan> {
    const planningTier: LLMTier = config.tier || 'large';
    const llm = useLLM({ tier: planningTier });
    if (!llm) {
      throw new Error('LLM not available for plan generation');
    }

    if (!llm.chatWithTools) {
      throw new Error('LLM does not support native tool calling');
    }

    const planningProfile = this.buildPlanningProfile(config.task, config.toolRegistry);

    // Create planning tools
    const researchTool = this.createResearchTool();
    const planToolName = this.getPlanToolName(config.task);
    const planTool = planToolName === 'plan_generate_refactor'
      ? this.createRefactorPlanTool(planningProfile)
      : this.createPlanTool(planningProfile);

    // Build tools array - research/planning tools + optional read-only discovery tools
    const tools: LLMTool[] = [researchTool, planTool];

    // Add research tools if registry provided
    if (config.toolRegistry) {
      const researchTools = this.getResearchTools(config.toolRegistry);
      tools.push(...researchTools);
    }

    this.emitStatus(config, 'planning', 'Preparing plan generation pipeline');
    this.emitProgress(config, 'plan-generation', 10, 'Initialized planning tools');

    const researchContext = config.researchContext
      || await this.collectResearchContext(llm, tools, {
        ...config,
        tier: planningTier,
      });

    this.emitProgress(config, 'plan-generation', 45, 'Research phase completed');

    const systemPrompt = this.buildSystemPrompt(
      config.task,
      config.mode,
      config.complexity,
      researchContext,
      planToolName,
      planningProfile,
    );
    const generationMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: `Create an executable plan for: ${config.task}` },
    ];
    const generationOptions = {
      tools,
      temperature: 0.1,
      toolChoice: { type: 'function' as const, function: { name: planToolName } },
    };

    // Use native tool calling for explicit plan tool submission
    const llmStart = Date.now();
    this.emitEvent(config, {
      type: 'llm:start',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      data: {
        tier: planningTier,
        messageCount: generationMessages.length,
      },
    });
    this.emitStatus(config, 'planning', 'Generating executable plan from research');

    const planToolCallId = this.newToolCallId(planToolName);
    this.emitEvent(config, {
      type: 'tool:start',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      toolCallId: planToolCallId,
      data: {
        toolName: planToolName,
        input: {
          task: config.task,
          mode: config.mode,
          complexity: config.complexity,
        },
      },
    });

    let response: LLMToolCallResponse;
    try {
      response = await llm.chatWithTools!(
        generationMessages,
        generationOptions,
      );
    } catch (error) {
      this.emitEvent(config, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: config.sessionId,
        toolCallId: planToolCallId,
        data: {
          toolName: planToolName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    const planDuration = Date.now() - llmStart;
    this.emitEvent(config, {
      type: 'llm:end',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      startedAt: new Date(llmStart).toISOString(),
      data: {
        tokensUsed: this.getTokensUsed(response),
        durationMs: planDuration,
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
      },
    });
    this.traceLLMCall(config, {
      iteration: 1,
      tools,
      temperature: generationOptions.temperature,
      response,
      startedAtMs: llmStart,
      endedAtMs: llmStart + planDuration,
    });

    // Extract plan from tool call
    let planData: GeneratedPlanData | undefined;
    if (response.toolCalls && response.toolCalls.length > 0) {
      const planCall = response.toolCalls.find((tc: { name: string; input: unknown }) => tc.name === planToolName);
      if (planCall) {
        planData = planCall.input as GeneratedPlanData;
      }
    }

    if (!planData) {
      this.emitEvent(config, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: config.sessionId,
        toolCallId: planToolCallId,
        data: {
          toolName: planToolName,
          error: `LLM response did not contain ${planToolName} tool input`,
        },
      });
      throw new Error('LLM did not generate a plan using the tool');
    }

    const markdownFirst = typeof planData.markdown === 'string'
      && planData.markdown.trim().length > 0;
    let qualitySummary: { score: number; issues: string[]; severeIssues: string[] } | null = null;
    let regenerated = false;
    if (markdownFirst) {
      const initialAssessment = this.assessFreeformMarkdown(planData.markdown || '');
      qualitySummary = initialAssessment;
      if (initialAssessment.severeIssues.length > 0) {
        const originalPlanData = planData as GeneratedPlanData;
        this.emitStatus(config, 'planning', 'Free-form markdown failed minimal quality checks, attempting one repair');
        this.emitProgress(config, 'plan-generation', 70, 'Repairing markdown draft with missing/invalid sections');
        const retryData = await this.regeneratePlanWithQualityFeedback({
          llm,
          tools,
          task: config.task,
          mode: config.mode,
          complexity: config.complexity,
          researchContext,
          issues: initialAssessment.issues,
          sessionId: config.sessionId,
          onEvent: config.onEvent,
          agentId: config.agentId,
          parentAgentId: config.parentAgentId,
          tier: planningTier,
          planToolName,
          planningProfile,
        });
        if (retryData) {
          const retryAssessment = this.assessFreeformMarkdown(retryData.markdown || '');
          const severeImproved = retryAssessment.severeIssues.length < initialAssessment.severeIssues.length;
          const scoreNotWorse = retryAssessment.score >= (initialAssessment.score - 0.05);
          if (retryAssessment.severeIssues.length === 0 || (severeImproved && scoreNotWorse)) {
            planData = retryData;
            qualitySummary = retryAssessment;
            regenerated = true;
          } else {
            planData = originalPlanData;
            qualitySummary = initialAssessment;
            this.emitStatus(config, 'planning', 'Markdown repair did not improve enough, keeping original draft');
          }
        }
      } else if (initialAssessment.issues.length > 0) {
        this.emitStatus(config, 'planning', 'Plan generated in one shot with minor markdown quality warnings');
      }
    } else {
      const quality = this.assessPlanQuality(config.task, planData as GeneratedPlanData);
      qualitySummary = quality;
      const shouldRetry = this.shouldRetryPlan(config.task, quality);
      if (shouldRetry) {
        const originalPlanData = planData as GeneratedPlanData;
        this.emitStatus(config, 'planning', 'Plan quality gate failed, regenerating with stricter refactoring constraints');
        this.emitProgress(config, 'plan-generation', 70, 'Regenerating plan with concrete refactoring requirements');
        const retryData = await this.regeneratePlanWithQualityFeedback({
          llm,
          tools,
          task: config.task,
          mode: config.mode,
          complexity: config.complexity,
          researchContext,
          issues: quality.issues,
          sessionId: config.sessionId,
          onEvent: config.onEvent,
          agentId: config.agentId,
          parentAgentId: config.parentAgentId,
          tier: planningTier,
          planToolName,
          planningProfile,
        });
        if (retryData) {
          const retryQuality = this.assessPlanQuality(config.task, retryData);
          if (retryQuality.score >= quality.score && retryQuality.severeIssues.length === 0) {
            planData = retryData;
            qualitySummary = retryQuality;
            regenerated = true;
          } else {
            planData = originalPlanData;
            qualitySummary = quality;
            this.emitStatus(config, 'planning', 'Retry plan quality did not improve enough, keeping original draft');
          }
        }
      } else if (quality.issues.length > 0) {
        this.emitStatus(config, 'planning', 'Plan generated in one shot with minor quality warnings');
      }
    }

    this.emitEvent(config, {
      type: 'tool:end',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      toolCallId: planToolCallId,
      startedAt: new Date(llmStart).toISOString(),
      data: {
        toolName: planToolName,
        success: true,
        durationMs: planDuration,
        output: 'Plan generated successfully',
        metadata: {
          structured: {
            phaseCount: Array.isArray(planData.phases) ? planData.phases.length : 0,
            complexity: planData.complexity,
            regenerated,
            qualityValidationSkipped: false,
            qualityScore: qualitySummary?.score ?? null,
            qualityIssues: qualitySummary?.issues.length ?? null,
            severeQualityIssues: qualitySummary?.severeIssues.length ?? null,
            decisionCount: Array.isArray((planData as GeneratedPlanData).decisions)
              ? ((planData as GeneratedPlanData).decisions as unknown[]).length
              : Array.isArray((planData as GeneratedPlanData).refactorDecisions)
                ? ((planData as GeneratedPlanData).refactorDecisions as unknown[]).length
                : 0,
            changeSetCount: Array.isArray((planData as GeneratedPlanData).changeSets)
              ? ((planData as GeneratedPlanData).changeSets as unknown[]).length
              : 0,
            verificationCount: Array.isArray((planData as GeneratedPlanData).verification)
              ? ((planData as GeneratedPlanData).verification as unknown[]).length
              : 0,
            markdownLength: typeof (planData as GeneratedPlanData).markdown === 'string'
              ? (planData as GeneratedPlanData).markdown!.length
              : 0,
          },
        },
      },
    });

    const plan = this.buildTaskPlan({
      sessionId: config.sessionId,
      task: config.task,
      mode: config.mode,
      complexityHint: config.complexity,
      planData,
    });

    this.emitProgress(config, 'plan-generation', 100, 'Plan generation completed');
    this.emitStatus(config, 'done', 'Plan draft created');
    return plan;
  }

  /**
   * Update an existing plan based on user feedback.
   * Uses a dedicated plan_update tool instead of free-form JSON.
   */
  async update(config: {
    plan: TaskPlan;
    feedback: string;
    mode?: AgentMode;
    toolRegistry?: ToolRegistry;
    enableResearch?: boolean;
    onEvent?: AgentEventCallback;
    agentId?: string;
    parentAgentId?: string;
    tracer?: Tracer;
    tier?: LLMTier;
  }): Promise<TaskPlan> {
    const planningTier: LLMTier = config.tier || 'large';
    const llm = useLLM({ tier: planningTier });
    if (!llm) {
      throw new Error('LLM not available for plan update');
    }

    if (!llm.chatWithTools) {
      throw new Error('LLM does not support native tool calling');
    }

    const updateTool = this.createPlanUpdateTool();
    const researchTool = this.createResearchTool();
    const targetMode = config.mode || config.plan.mode;
    const updateTask = `${config.plan.task}\n\nRevision goal:\n${config.feedback}`;
    const toolCallingTools: LLMTool[] = [researchTool, updateTool];
    if (config.toolRegistry) {
      toolCallingTools.push(...this.getResearchTools(config.toolRegistry));
    }

    let researchContext = '';
    if (config.enableResearch !== false && config.toolRegistry) {
      this.emitStatus(config, 'researching', 'Collecting additional context for plan revision');
      this.emitProgress(config, 'plan-revision', 10, 'Running pre-revision research');
      researchContext = await this.collectResearchContext(llm, toolCallingTools, {
        task: updateTask,
        sessionId: config.plan.sessionId,
        mode: targetMode,
        complexity: config.plan.complexity,
        toolRegistry: config.toolRegistry,
        onEvent: config.onEvent,
        agentId: config.agentId,
        parentAgentId: config.parentAgentId,
        tier: planningTier,
      });
    }

    const updateMessages = [
      {
        role: 'system' as const,
        content: this.buildUpdateSystemPrompt(config.plan, config.feedback, targetMode, researchContext),
      },
      {
        role: 'user' as const,
        content: `Revise the plan using feedback: ${config.feedback}`,
      },
    ];
    const updateOptions = {
      tools: toolCallingTools,
      temperature: 0.1,
      toolChoice: { type: 'function' as const, function: { name: 'plan_update' } },
    };

    this.emitStatus(config, 'planning', 'Revising plan draft from user feedback');
    this.emitProgress(config, 'plan-revision', 20, 'Submitting plan revision request');

    const llmStart = Date.now();
    this.emitEvent(config, {
      type: 'llm:start',
      timestamp: new Date().toISOString(),
      sessionId: config.plan.sessionId,
      data: {
        tier: planningTier,
        messageCount: updateMessages.length,
      },
    });
    const updateToolCallId = this.newToolCallId('plan_update');
    this.emitEvent(config, {
      type: 'tool:start',
      timestamp: new Date().toISOString(),
      sessionId: config.plan.sessionId,
      toolCallId: updateToolCallId,
      data: {
        toolName: 'plan_update',
        input: {
          planId: config.plan.id,
          feedback: config.feedback,
        },
      },
    });

    let response: LLMToolCallResponse;
    try {
      response = await llm.chatWithTools!(
        updateMessages,
        updateOptions,
      );
    } catch (error) {
      this.emitEvent(config, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: config.plan.sessionId,
        toolCallId: updateToolCallId,
        data: {
          toolName: 'plan_update',
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    const updateDuration = Date.now() - llmStart;
    this.emitEvent(config, {
      type: 'llm:end',
      timestamp: new Date().toISOString(),
      sessionId: config.plan.sessionId,
      startedAt: new Date(llmStart).toISOString(),
      data: {
        tokensUsed: this.getTokensUsed(response),
        durationMs: updateDuration,
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
      },
    });
    this.traceLLMCall(config, {
      iteration: 1,
      tools: toolCallingTools,
      temperature: updateOptions.temperature,
      response,
      startedAtMs: llmStart,
      endedAtMs: llmStart + updateDuration,
    });

    const updateCall = response.toolCalls?.find((tc: { name: string; input: unknown }) => tc.name === 'plan_update');
    const planData = updateCall?.input as {
      complexity?: 'simple' | 'medium' | 'complex';
      estimatedDuration?: string;
      markdown?: string;
      phases?: unknown[];
      revisionSummary?: string;
    } | undefined;

    if (!planData) {
      this.emitEvent(config, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: config.plan.sessionId,
        toolCallId: updateToolCallId,
        data: {
          toolName: 'plan_update',
          error: 'LLM response did not contain plan_update tool input',
        },
      });
      throw new Error('LLM did not update the plan using plan_update tool');
    }

    const updated = this.buildTaskPlan({
      sessionId: config.plan.sessionId,
      task: config.plan.task,
      mode: targetMode,
      complexityHint: config.plan.complexity,
      planData,
      existingPlan: config.plan,
    });

    this.emitEvent(config, {
      type: 'tool:end',
      timestamp: new Date().toISOString(),
      sessionId: config.plan.sessionId,
      toolCallId: updateToolCallId,
      startedAt: new Date(llmStart).toISOString(),
      data: {
        toolName: 'plan_update',
        success: true,
        durationMs: updateDuration,
        output: 'Plan updated successfully',
        metadata: {
          structured: {
            phaseCount: Array.isArray(planData.phases) ? planData.phases.length : 0,
            complexity: planData.complexity,
            markdownLength: typeof planData.markdown === 'string' ? planData.markdown.length : 0,
          },
        },
      },
    });
    this.emitProgress(config, 'plan-revision', 100, 'Plan revision completed');
    this.emitStatus(config, 'done', 'Plan revision draft ready');

    return {
      ...updated,
      createdAt: config.plan.createdAt,
      status: 'draft',
    };
  }

  private buildTaskPlan(input: {
    sessionId: string;
    task: string;
    mode: AgentMode;
    complexityHint?: 'simple' | 'medium' | 'complex';
    planData: {
      complexity?: 'simple' | 'medium' | 'complex';
      estimatedDuration?: string;
      markdown?: string;
      phases?: unknown[];
      refactorDecisions?: unknown[];
      changeSets?: unknown[];
    };
    existingPlan?: TaskPlan;
  }): TaskPlan {
    const now = new Date().toISOString();
    const planId = input.existingPlan?.id || `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const normalizedPhases = this.normalizePhasesFromTool(input.planData.phases || []);
    const markdownPhases = this.parsePhasesFromMarkdown(input.planData.markdown || '');
    const synthesizedPhases = this.synthesizeRefactorPhasesFromChangeSets(input.planData.changeSets);
    const phasesFromSources = normalizedPhases.length > 0
      ? normalizedPhases
      : markdownPhases.length > 0
        ? markdownPhases
        : synthesizedPhases;
    const phases = phasesFromSources.length > 0
      ? phasesFromSources
      : this.createFallbackPhases(input.task);
    const markdown = this.normalizePlanMarkdown(input.task, input.planData.markdown, phases);

    const plan: TaskPlan = {
      id: planId,
      sessionId: input.sessionId,
      task: input.task,
      mode: input.mode,
      phases,
      estimatedDuration: input.planData.estimatedDuration || 'Unknown',
      complexity: input.complexityHint || input.planData.complexity || 'medium',
      createdAt: input.existingPlan?.createdAt || now,
      updatedAt: now,
      status: input.existingPlan?.status || 'draft',
      markdown,
    };

    return plan;
  }

  private async runResearchPhase(
    llm: NonNullable<ReturnType<typeof useLLM>>,
    tools: LLMTool[],
    task: string,
    mode: AgentMode,
    complexity?: 'simple' | 'medium' | 'complex',
    eventConfig?: {
      sessionId: string;
      onEvent?: AgentEventCallback;
      agentId?: string;
      parentAgentId?: string;
      tracer?: Tracer;
      tier?: LLMTier;
    }
  ): Promise<string> {
    const started = Date.now();
    const researchMessages = [
      {
        role: 'system' as const,
        content: this.buildResearchSystemPrompt(task, mode, complexity),
      },
      {
        role: 'user' as const,
        content: `Research this task and submit findings via plan_research tool: ${task}`,
      },
    ];
    const researchOptions = {
      tools,
      temperature: 0.1,
      toolChoice: { type: 'function' as const, function: { name: 'plan_research' } },
    };
    this.emitStatus(eventConfig, 'researching', 'Researching codebase for plan context');
    this.emitEvent(eventConfig, {
      type: 'llm:start',
      timestamp: new Date().toISOString(),
      sessionId: eventConfig?.sessionId,
      data: {
        tier: eventConfig?.tier || 'large',
        messageCount: researchMessages.length,
      },
    });
    const researchToolCallId = this.newToolCallId('plan_research');
    this.emitEvent(eventConfig, {
      type: 'tool:start',
      timestamp: new Date().toISOString(),
      sessionId: eventConfig?.sessionId,
      toolCallId: researchToolCallId,
      data: {
        toolName: 'plan_research',
        input: {
          task,
          mode,
          complexity,
        },
      },
    });

    let response: LLMToolCallResponse;
    try {
      response = await llm.chatWithTools!(
        researchMessages,
        researchOptions,
      );
    } catch (error) {
      this.emitEvent(eventConfig, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: eventConfig?.sessionId,
        toolCallId: researchToolCallId,
        data: {
          toolName: 'plan_research',
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    const researchCall = response.toolCalls?.find((tc: { name: string; input: unknown }) => tc.name === 'plan_research');
    const input = researchCall?.input as { summary?: string; findings?: string[] } | undefined;
    const findings = Array.isArray(input?.findings) ? input!.findings.filter((v): v is string => typeof v === 'string') : [];
    const summary = typeof input?.summary === 'string' ? input.summary.trim() : '';

    const durationMs = Date.now() - started;
    this.emitEvent(eventConfig, {
      type: 'llm:end',
      timestamp: new Date().toISOString(),
      sessionId: eventConfig?.sessionId,
      startedAt: new Date(started).toISOString(),
      data: {
        tokensUsed: this.getTokensUsed(response),
        durationMs,
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
      },
    });
    this.traceLLMCall(eventConfig, {
      iteration: 1,
      tools,
      temperature: researchOptions.temperature,
      response,
      startedAtMs: started,
      endedAtMs: started + durationMs,
    });

    if (!summary && findings.length === 0) {
      this.emitEvent(eventConfig, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: eventConfig?.sessionId,
        toolCallId: researchToolCallId,
        data: {
          toolName: 'plan_research',
          error: 'No research summary/findings returned',
        },
      });
      return '';
    }

    this.emitEvent(eventConfig, {
      type: 'tool:end',
      timestamp: new Date().toISOString(),
      sessionId: eventConfig?.sessionId,
      toolCallId: researchToolCallId,
      startedAt: new Date(started).toISOString(),
      data: {
        toolName: 'plan_research',
        success: true,
        durationMs,
        output: summary || `${findings.length} findings`,
        metadata: {
          resultCount: findings.length,
          summary,
        },
      },
    });

    return [summary, ...findings.map((f) => `- ${f}`)].filter(Boolean).join('\n');
  }

  private async collectResearchContext(
    llm: NonNullable<ReturnType<typeof useLLM>>,
    tools: LLMTool[],
    config: {
      task: string;
      sessionId: string;
      mode: AgentMode;
      complexity?: 'simple' | 'medium' | 'complex';
      toolRegistry?: ToolRegistry;
      onEvent?: AgentEventCallback;
      agentId?: string;
      parentAgentId?: string;
      tracer?: Tracer;
      tier?: LLMTier;
    }
  ): Promise<string> {
    const deterministicEvidence = await this.collectDeterministicResearchEvidence(config);
    const baselineContext = await this.runResearchPhase(llm, tools, config.task, config.mode, config.complexity, config);
    const mergedBaseline = [deterministicEvidence, baselineContext].filter(Boolean).join('\n');
    if (config.mode !== 'plan' || !config.toolRegistry) {
      return mergedBaseline;
    }

    const gaps = this.selectResearchGaps(config.task, mergedBaseline).slice(0, 2);
    if (gaps.length === 0) {
      return mergedBaseline;
    }

    const delegated = await this.runDelegatedResearchPhase(llm, tools, {
      task: config.task,
      sessionId: config.sessionId,
      complexity: config.complexity,
      gaps,
      onEvent: config.onEvent,
      agentId: config.agentId,
      parentAgentId: config.parentAgentId,
      tier: config.tier,
    });

    const delegatedContext = [delegated.summary, ...delegated.findings.map((f) => `- ${f}`)]
      .filter(Boolean)
      .join('\n');
    if (!delegatedContext) {
      return mergedBaseline;
    }
    return [mergedBaseline, '', 'Delegated gap-focused findings:', delegatedContext]
      .filter(Boolean)
      .join('\n');
  }

  private async collectDeterministicResearchEvidence(config: {
    task: string;
    sessionId: string;
    mode: AgentMode;
    complexity?: 'simple' | 'medium' | 'complex';
    toolRegistry?: ToolRegistry;
    onEvent?: AgentEventCallback;
    agentId?: string;
    parentAgentId?: string;
    tracer?: Tracer;
  }): Promise<string> {
    if (!config.toolRegistry) {
      return '';
    }

    const evidence: string[] = [];
    const registry = config.toolRegistry;
    const toolNames = new Set(registry.getToolNames());
    const start = Date.now();
    const bootstrapToolCallId = this.newToolCallId('plan_research_bootstrap');
    this.emitStatus(config, 'researching', 'Collecting deterministic research evidence from available tools');
    this.emitEvent(config, {
      type: 'tool:start',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      toolCallId: bootstrapToolCallId,
      data: {
        toolName: 'plan_research_bootstrap',
        input: {
          availableTools: Array.from(toolNames),
        },
      },
    });

    const pathHints = this.extractPathHints(config.task);

    if (toolNames.has('fs_list')) {
      try {
        const result = await registry.execute('fs_list', { path: '.', limit: 40 });
        const output = typeof (result as { output?: unknown }).output === 'string'
          ? (result as { output: string }).output
          : '';
        if (output) {
          evidence.push(`Deterministic fs_list evidence:\n${output.split('\n').slice(0, 20).join('\n')}`);
        }
      } catch {
        // Best effort evidence collection; do not fail planning flow.
      }
    }

    if (toolNames.has('glob_search') && pathHints.length > 0) {
      for (const hint of pathHints.slice(0, 3)) {
        try {
          const pattern = hint.includes('.') ? `*${hint.split('/').pop()}` : `*${hint}*`;
          const result = await registry.execute('glob_search', { pattern, directory: '.', limit: 20 });
          const output = typeof (result as { output?: unknown }).output === 'string'
            ? (result as { output: string }).output
            : '';
          if (output) {
            evidence.push(`Deterministic glob_search evidence for "${hint}":\n${output.split('\n').slice(0, 12).join('\n')}`);
          }
        } catch {
          // Best effort evidence collection; do not fail planning flow.
        }
      }
    }

    if (toolNames.has('grep_search')) {
      const keywords = this.extractKeywordHints(config.task).slice(0, 2);
      for (const keyword of keywords) {
        try {
          const result = await registry.execute('grep_search', {
            pattern: keyword,
            directory: '.',
            limit: 10,
            mode: 'literal',
          });
          const output = typeof (result as { output?: unknown }).output === 'string'
            ? (result as { output: string }).output
            : '';
          if (output && !/No matches|No files/i.test(output)) {
            evidence.push(`Deterministic grep_search evidence for "${keyword}":\n${output.split('\n').slice(0, 10).join('\n')}`);
          }
        } catch {
          // Best effort evidence collection; do not fail planning flow.
        }
      }
    }

    this.emitEvent(config, {
      type: 'tool:end',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      toolCallId: bootstrapToolCallId,
      startedAt: new Date(start).toISOString(),
      data: {
        toolName: 'plan_research_bootstrap',
        success: true,
        durationMs: Date.now() - start,
        output: `Collected ${evidence.length} deterministic evidence snippet(s)`,
      },
    });

    return evidence.join('\n\n');
  }

  private async runDelegatedResearchPhase(
    llm: NonNullable<ReturnType<typeof useLLM>>,
    tools: LLMTool[],
    config: {
      task: string;
      sessionId: string;
      complexity?: 'simple' | 'medium' | 'complex';
      gaps: Array<{ key: string; title: string; prompt: string }>;
      onEvent?: AgentEventCallback;
      agentId?: string;
      parentAgentId?: string;
      tier?: LLMTier;
    }
  ): Promise<DelegatedResearchOutput> {
    const subtasks = config.gaps;
    const findings: string[] = [];
    const summaries: string[] = [];

    this.emitStatus(config, 'researching', `Delegating targeted research for ${subtasks.length} gap(s)`);
    this.emitProgress(config, 'plan-research', 55, 'Starting gap-focused delegated research');

    for (let index = 0; index < subtasks.length; index++) {
      const subtask = subtasks[index]!;
      const subtaskId = `plan-research-${index + 1}-${Date.now().toString(36)}`;
      const startedAt = new Date().toISOString();
      this.emitEvent(config, {
        type: 'subtask:start',
        timestamp: startedAt,
        sessionId: config.sessionId,
        data: {
          subtaskId,
          description: `${subtask.title} (${subtask.key})`,
          index,
          total: subtasks.length,
        },
      });

      try {
        const focusedTask = `${config.task}\n\nFocused research gap: ${subtask.title}\n${subtask.prompt}`;
        const context = await this.runResearchPhase(
          llm,
          tools,
          focusedTask,
          'plan',
          config.complexity,
          config,
        );
        const output = this.normalizeChildResearchOutput(context);
        if (output.summary) {
          summaries.push(`${subtask.title}: ${output.summary}`);
        }
        findings.push(...output.findings.map((f) => `[${subtask.title}] ${f}`));
        this.emitEvent(config, {
          type: 'subtask:end',
          timestamp: new Date().toISOString(),
          sessionId: config.sessionId,
          startedAt,
          data: {
            subtaskId,
            success: true,
            summary: output.summary || 'Gap research completed',
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        findings.push(`[${subtask.title}] Failed: ${message}`);
        this.emitEvent(config, {
          type: 'subtask:end',
          timestamp: new Date().toISOString(),
          sessionId: config.sessionId,
          startedAt,
          data: {
            subtaskId,
            success: false,
            summary: message,
          },
        });
      }

      const progress = Math.round(55 + ((index + 1) / subtasks.length) * 15);
      this.emitProgress(config, 'plan-research', progress, `Delegated subtask ${index + 1}/${subtasks.length} completed`);
    }

    return {
      summary: summaries.join('\n'),
      findings,
    };
  }

  private selectResearchGaps(task: string, baselineContext: string): Array<{ key: string; title: string; prompt: string }> {
    const text = `${task}\n${baselineContext}`.toLowerCase();
    const gaps: Array<{ key: string; title: string; prompt: string }> = [];
    const isRefactor = this.isRefactorTask(task);

    // For refactoring tasks, prefer a single focused "solution gap" instead of broad audits.
    if (isRefactor) {
      const hasConcreteDecisions = /(extract|split|rename|decouple|replace|interface|module boundary|target file|fs:edit|fs:write)/.test(text);
      if (!hasConcreteDecisions) {
        gaps.push({
          key: 'refactor-decisions',
          title: 'Refactor Decisions',
          prompt: [
            'Derive concrete refactoring decisions (not analysis plan).',
            'Return 3-6 decision bullets:',
            '- exact files/modules to change',
            '- concrete change type (extract/split/rename/decouple/replace)',
            '- expected effect on maintainability/testability',
            '- key risk and validation command',
          ].join('\n'),
        });
      }
      return gaps;
    }

    const hasArchitecture = /(module|boundary|architecture|component|layer|responsib)/.test(text);
    const hasContracts = /(interface|type|contract|api|schema|input|output|flow)/.test(text);
    const hasVerification = /(test|verify|validation|build|lint|check|rollback)/.test(text);
    const hasRisks = /(risk|tradeoff|debt|constraint|coupling|regression)/.test(text);

    if (!hasArchitecture) {
      gaps.push({
        key: 'architecture',
        title: 'Architecture & Boundaries',
        prompt: 'Find module boundaries, responsibilities, and concrete files likely to change.',
      });
    }
    if (!hasContracts) {
      gaps.push({
        key: 'contracts',
        title: 'Data Flow & Contracts',
        prompt: 'Map input->processing->output flow, key interfaces/types/contracts, and coupling points.',
      });
    }
    if (!hasVerification || !hasRisks) {
      gaps.push({
        key: 'verification-risks',
        title: 'Verification & Risks',
        prompt: 'Identify verification commands, regression risks, and rollback constraints for refactoring.',
      });
    }

    return gaps;
  }

  private normalizeChildResearchOutput(summary: string): DelegatedResearchOutput {
    const lines = summary
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const findings = lines
      .filter((line) => /^[-*•]/.test(line) || /^[0-9]+\./.test(line))
      .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^[0-9]+\.\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 24);
    const topSummary = lines
      .filter((line) => !/^[-*•]/.test(line) && !/^[0-9]+\./.test(line))
      .slice(0, 3)
      .join(' ');
    return {
      summary: topSummary || lines.slice(0, 2).join(' '),
      findings,
    };
  }

  private async regeneratePlanWithQualityFeedback(config: {
    llm: NonNullable<ReturnType<typeof useLLM>>;
    tools: LLMTool[];
    task: string;
    mode: AgentMode;
    complexity?: 'simple' | 'medium' | 'complex';
    researchContext?: string;
    issues: string[];
    sessionId: string;
    onEvent?: AgentEventCallback;
    agentId?: string;
    parentAgentId?: string;
    tracer?: Tracer;
    planToolName: 'plan_generate' | 'plan_generate_refactor';
    planningProfile: PlanningProfile;
    tier?: LLMTier;
  }): Promise<GeneratedPlanData | null> {
    const started = Date.now();
    const retryMessages = [
      {
        role: 'system' as const,
        content: `${this.buildSystemPrompt(
          config.task,
          config.mode,
          config.complexity,
          config.researchContext,
          config.planToolName,
          config.planningProfile,
        )}

QUALITY GATE FEEDBACK FROM PREVIOUS DRAFT:
${config.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

You MUST fix these issues and return a concrete implementation/refactoring plan.`,
      },
      {
        role: 'user' as const,
        content: `Regenerate the plan to fix quality issues and return an executable markdown draft for: ${config.task}`,
      },
    ];
    const retryOptions = {
      tools: config.tools,
      temperature: 0.1,
      toolChoice: { type: 'function' as const, function: { name: config.planToolName } },
    };
    const retryToolCallId = this.newToolCallId(config.planToolName);
    this.emitEvent(config, {
      type: 'llm:start',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      data: {
        tier: config.tier || 'large',
        messageCount: retryMessages.length,
      },
    });
    this.emitEvent(config, {
      type: 'tool:start',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      toolCallId: retryToolCallId,
      data: {
        toolName: config.planToolName,
        input: {
          task: config.task,
          mode: config.mode,
          complexity: config.complexity,
          retry: true,
        },
      },
    });

    let response: LLMToolCallResponse;
    try {
      response = await config.llm.chatWithTools!(
        retryMessages,
        retryOptions,
      );
    } catch (error) {
      this.emitEvent(config, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: config.sessionId,
        toolCallId: retryToolCallId,
        data: {
          toolName: config.planToolName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }

    const durationMs = Date.now() - started;
    this.emitEvent(config, {
      type: 'llm:end',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      startedAt: new Date(started).toISOString(),
      data: {
        tokensUsed: this.getTokensUsed(response),
        durationMs,
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
      },
    });
    this.traceLLMCall(config, {
      iteration: 1,
      tools: config.tools,
      temperature: retryOptions.temperature,
      response,
      startedAtMs: started,
      endedAtMs: started + durationMs,
    });

    const retryCall = response.toolCalls?.find((tc: { name: string; input: unknown }) => tc.name === config.planToolName);
    const retryData = retryCall?.input as GeneratedPlanData | undefined;
    if (!retryData) {
      this.emitEvent(config, {
        type: 'tool:error',
        timestamp: new Date().toISOString(),
        sessionId: config.sessionId,
        toolCallId: retryToolCallId,
        data: {
          toolName: config.planToolName,
          error: `Retry did not return ${config.planToolName} tool input`,
        },
      });
      return null;
    }

    this.emitEvent(config, {
      type: 'tool:end',
      timestamp: new Date().toISOString(),
      sessionId: config.sessionId,
      toolCallId: retryToolCallId,
      startedAt: new Date(started).toISOString(),
      data: {
        toolName: config.planToolName,
        success: true,
        durationMs,
        output: 'Plan regenerated after quality gate',
      },
    });

    return retryData;
  }

  private emitStatus(
    config: {
      sessionId?: string;
      onEvent?: AgentEventCallback;
      agentId?: string;
      parentAgentId?: string;
      tracer?: Tracer;
    } | undefined,
    status: 'idle' | 'thinking' | 'executing' | 'waiting' | 'done' | 'error' | 'analyzing' | 'planning' | 'researching' | 'finalizing',
    message: string
  ): void {
    this.emitEvent(config, {
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId: config?.sessionId,
      data: { status, message },
    });
  }

  private emitProgress(
    config: {
      sessionId?: string;
      onEvent?: AgentEventCallback;
      agentId?: string;
      parentAgentId?: string;
      tracer?: Tracer;
    } | undefined,
    phase: string,
    progress: number,
    message: string
  ): void {
    this.emitEvent(config, {
      type: 'progress:update',
      timestamp: new Date().toISOString(),
      sessionId: config?.sessionId,
      data: { phase, progress, message },
    });
  }

  private emitEvent(
    config: {
      sessionId?: string;
      onEvent?: AgentEventCallback;
      agentId?: string;
      parentAgentId?: string;
      tracer?: Tracer;
    } | undefined,
    event: AgentEvent
  ): void {
    if (!config?.onEvent) {
      return;
    }
    config.onEvent({
      ...event,
      agentId: config.agentId,
      parentAgentId: config.parentAgentId,
    });
  }

  private getTokensUsed(response: { usage?: { promptTokens?: number; completionTokens?: number } } | undefined): number {
    if (!response?.usage) {
      return 0;
    }
    return (response.usage.promptTokens || 0) + (response.usage.completionTokens || 0);
  }

  private traceLLMCall(
    config: { tracer?: Tracer } | undefined,
    input: {
      iteration: number;
      tools: LLMTool[];
      temperature: number;
      response: LLMToolCallResponse;
      startedAtMs: number;
      endedAtMs: number;
    }
  ): void {
    if (!config?.tracer) {
      return;
    }
    try {
      config.tracer.trace(
        createLLMCallEvent({
          iteration: input.iteration,
          model: input.response.model || 'unknown',
          temperature: input.temperature,
          maxTokens: 4096,
          tools: input.tools.map((tool) => tool.name),
          response: input.response,
          startTime: input.startedAtMs,
          endTime: input.endedAtMs,
        })
      );
    } catch {
      // Tracing must never break planning flow.
    }
  }

  private newToolCallId(toolName: string): string {
    return `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private assessPlanQuality(task: string, planData: GeneratedPlanData): PlanQualityAssessment {
    const isRefactor = this.isRefactorTask(task);
    const markdown = typeof planData.markdown === 'string' ? planData.markdown.trim() : '';
    const phases = Array.isArray(planData.phases) ? planData.phases : [];
    const steps = phases.flatMap((phase: unknown) => Array.isArray((phase as Record<string, unknown>)?.steps) ? (phase as Record<string, unknown>).steps as unknown[] : []);
    const refactorDecisions = Array.isArray(planData.refactorDecisions) ? planData.refactorDecisions : [];
    const changeSets = Array.isArray(planData.changeSets) ? planData.changeSets : [];
    const verification = Array.isArray(planData.verification) ? planData.verification : [];
    const issues: string[] = [];
    const severeIssues: string[] = [];

    if (phases.length === 0 || steps.length === 0) {
      const markdownHasStructure = Boolean(
        markdown
        && /(^|\n)##\s+steps\b/i.test(markdown)
        && /(^|\n)###\s+/i.test(markdown)
        && /(^|\n)\s*[-*]\s+/.test(markdown)
      );
      if (markdownHasStructure) {
        issues.push('Structured phases are omitted; they will be derived from markdown headings.');
        return {
          score: this.clamp01(0.55),
          issues,
          severeIssues,
          metrics: {
            phaseCount: 0,
            stepCount: 4,
            changeStepCount: 1,
            readOnlyStepCount: 0,
            changeRatio: 0.25,
            hasPlaceholders: false,
            analysisPhaseCount: 0,
            solutionStepRatio: 0.35,
          },
        };
      }

      if (isRefactor && changeSets.length > 0) {
        issues.push('Refactoring plan omitted phases; phases will be synthesized from changeSets.');
        const synthesizedStepCount = changeSets.length * 2;
        const synthesizedChangeCount = changeSets.length;
        return {
          score: this.clamp01(0.45 + Math.min(0.2, synthesizedStepCount / 30)),
          issues,
          severeIssues,
          metrics: {
            phaseCount: 0,
            stepCount: synthesizedStepCount,
            changeStepCount: synthesizedChangeCount,
            readOnlyStepCount: 0,
            changeRatio: 1,
            hasPlaceholders: false,
            analysisPhaseCount: 0,
            solutionStepRatio: 0.6,
          },
        };
      }
      const reason = 'Plan has no executable phases/steps.';
      issues.push(reason);
      severeIssues.push(reason);
      return {
        score: 0,
        issues,
        severeIssues,
        metrics: {
          phaseCount: phases.length,
          stepCount: steps.length,
          changeStepCount: 0,
          readOnlyStepCount: 0,
          changeRatio: 0,
          hasPlaceholders: false,
          analysisPhaseCount: 0,
          solutionStepRatio: 0,
        },
      };
    }

    if (verification.length === 0) {
      issues.push('Plan does not include explicit verification checks; ensure runtime validation is covered in steps.');
    }
    if (!markdown) {
      issues.push('Plan tool output is missing markdown draft.');
    }

    const textFields = steps.map((step: unknown) => {
      const s = step as Record<string, unknown>;
      return `${s?.action || ''} ${s?.expectedOutcome || ''} ${JSON.stringify(s?.args || {})}`;
    });
    const hasPlaceholders = textFields.some((text) => /<[^>]+>|\bTBD\b|\bTODO\b/.test(text));
    if (hasPlaceholders) {
      const reason = 'Plan contains placeholders instead of concrete file/module references.';
      issues.push(reason);
      severeIssues.push(reason);
    }

    const readOnlyTools = new Set([
      'mind:rag-query', 'mind_rag_query',
      'fs:read', 'fs_read',
      'fs:list', 'fs_list',
      'fs:search', 'glob_search', 'grep_search', 'find_definition',
      'browser_snapshot', 'browser_read', 'mcp_query',
    ]);
    const changeTools = new Set([
      'fs:edit', 'fs_patch', 'mass_replace', 'fs:write', 'fs_write', 'shell:exec', 'shell_exec',
      'browser_click', 'browser_type', 'browser_fill', 'browser_submit',
      'mcp_invoke', 'plugin_invoke',
    ]);
    const readOnlyCount = steps.filter((step: unknown) => readOnlyTools.has(String((step as Record<string, unknown>)?.tool || ''))).length;
    const changeCount = steps.filter((step: unknown) => changeTools.has(String((step as Record<string, unknown>)?.tool || ''))).length;
    const changeRatio = steps.length > 0 ? changeCount / steps.length : 0;
    const analysisPhases = phases.filter((phase: unknown) => /(discovery|inventory|audit|analysis|research)/i.test(String((phase as Record<string, unknown>)?.name || ''))).length;
    const solutionStepCount = steps.filter((step: unknown) => {
      const s = step as Record<string, unknown>;
      return /(extract|split|rename|decouple|inject|interface|abstraction|remove|replace|refactor|test|coverage|consolidate|modular)/i
        .test(`${s?.action || ''} ${s?.expectedOutcome || ''}`);
    }).length;
    const solutionStepRatio = steps.length > 0 ? solutionStepCount / steps.length : 0;

    const missingToolCount = steps.filter((step: unknown) => { const s = step as Record<string, unknown>; return typeof s?.tool !== 'string' || String(s.tool).trim().length === 0; }).length;
    if (missingToolCount > 0) {
      issues.push('Some plan steps are missing explicit tools.');
    }

    const missingActionOrOutcomeCount = steps.filter((step: unknown) => {
      const s = step as Record<string, unknown>;
      return typeof s?.action !== 'string'
        || (s.action as string).trim().length === 0
        || typeof s?.expectedOutcome !== 'string'
        || (s.expectedOutcome as string).trim().length === 0;
    }).length;
    if (missingActionOrOutcomeCount > 0) {
      const reason = 'Some plan steps are missing action/expectedOutcome.';
      issues.push(reason);
      severeIssues.push(reason);
    }

    if (!isRefactor) {
      const score = this.clamp01(
        0.25
        + (steps.length >= 4 ? 0.2 : 0)
        + (changeRatio >= 0.25 ? 0.15 : 0)
        + (solutionStepRatio >= 0.2 ? 0.1 : 0)
        + (verification.length > 0 ? 0.1 : 0)
        + (analysisPhases <= 1 ? 0.05 : 0)
        - (hasPlaceholders ? 0.35 : 0)
        - (missingToolCount > 0 ? 0.25 : 0)
        - (missingActionOrOutcomeCount > 0 ? 0.25 : 0)
      );
      return {
        score,
        issues,
        severeIssues,
        metrics: {
          phaseCount: phases.length,
          stepCount: steps.length,
          changeStepCount: changeCount,
          readOnlyStepCount: readOnlyCount,
          changeRatio,
          hasPlaceholders,
          analysisPhaseCount: analysisPhases,
          solutionStepRatio,
        },
      };
    }

    if (refactorDecisions.length === 0) {
      issues.push('Refactoring plan does not include explicit refactorDecisions; rely on concrete phase steps.');
    }
    if (changeSets.length === 0) {
      issues.push('Refactoring plan does not include explicit changeSets; rely on concrete phase steps.');
    }

    if (changeCount === 0) {
      const reason = 'Refactoring plan contains no concrete execution steps (change tools or executable actions).';
      issues.push(reason);
      severeIssues.push(reason);
    }
    if (changeRatio < 0.4) {
      issues.push('Refactoring plan is too discovery-heavy and lacks implementation-heavy refactor actions.');
    }
    if (readOnlyCount / steps.length > 0.6) {
      issues.push('Too many read/search steps for a refactoring plan.');
    }

    if (analysisPhases > 1) {
      issues.push('Refactoring plan has multiple analysis-only phases; keep at most one short analysis phase.');
    }

    if (solutionStepRatio < 0.35) {
      issues.push('Refactoring plan does not describe enough concrete design/implementation decisions.');
    }

    const score = this.clamp01(
      0.2
      + Math.min(0.2, steps.length / 30)
      + (changeRatio * 0.35)
      + (solutionStepRatio * 0.25)
      + (analysisPhases <= 1 ? 0.1 : 0)
      + (verification.length > 0 ? 0.05 : 0)
      - (hasPlaceholders ? 0.35 : 0)
      - (changeCount === 0 ? 0.35 : 0)
      - (missingToolCount > 0 ? 0.25 : 0)
      - (missingActionOrOutcomeCount > 0 ? 0.25 : 0)
    );

    return {
      score,
      issues,
      severeIssues,
      metrics: {
        phaseCount: phases.length,
        stepCount: steps.length,
        changeStepCount: changeCount,
        readOnlyStepCount: readOnlyCount,
        changeRatio,
        hasPlaceholders,
        analysisPhaseCount: analysisPhases,
        solutionStepRatio,
      },
    };
  }

  private assessFreeformMarkdown(markdown: string): { score: number; issues: string[]; severeIssues: string[] } {
    const text = (markdown || '').replace(/\r\n/g, '\n').trim();
    const issues: string[] = [];
    const severeIssues: string[] = [];

    if (!text) {
      const reason = 'Markdown plan is empty.';
      issues.push(reason);
      severeIssues.push(reason);
      return { score: 0, issues, severeIssues };
    }

    // Delegate to PlanValidator for rubric-based scoring
    const validator = new PlanValidator();
    const validation = validator.validate(text);

    // Map validator issues back to legacy format
    for (const issue of validation.issues) {
      issues.push(issue.message);
      if (issue.severity === 'error') {
        severeIssues.push(issue.message);
      }
    }

    // Legacy structural checks for backward compatibility
    if (text.length < 160) {
      const reason = 'Markdown plan is too short to be actionable.';
      if (!issues.includes(reason)) {
        issues.push(reason);
        severeIssues.push(reason);
      }
    }

    if (/(placeholder|need research first|\btbd\b|\btodo\b)/i.test(text)) {
      const reason = 'Markdown plan contains placeholder content.';
      if (!issues.includes(reason)) {
        issues.push(reason);
        severeIssues.push(reason);
      }
    }

    // Use validator score as the primary score
    return { score: validation.score, issues, severeIssues };
  }

  private isRefactorTask(task: string): boolean {
    return /\brefactor|refactoring|restructure|cleanup|maintainability|testability\b/i.test(task);
  }

  private shouldRetryPlan(task: string, quality: PlanQualityAssessment): boolean {
    // Retry should be rare: only when draft is structurally unusable.
    if (quality.severeIssues.length === 0) {
      return false;
    }

    const isRefactor = this.isRefactorTask(task);
    const hardFailures = quality.severeIssues.some((issue) =>
      /no executable phases\/steps|no concrete execution steps|missing action\/expectedOutcome|did not contain/i
        .test(issue)
    );

    if (!hardFailures) {
      return false;
    }

    // Additional guard: avoid retries for mostly-usable drafts.
    if (quality.metrics.stepCount >= 4 && quality.metrics.changeStepCount >= 2 && quality.score >= (isRefactor ? 0.45 : 0.5)) {
      return false;
    }

    return true;
  }

  private clamp01(value: number): number {
    if (value < 0) {return 0;}
    if (value > 1) {return 1;}
    return Number(value.toFixed(3));
  }

  private createResearchTool(): LLMTool {
    return {
      name: 'plan_research',
      description: 'Submit structured research findings that will be used as context for plan generation',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Concise research summary grounded in codebase evidence',
          },
          findings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concrete findings with file/module references',
          },
          openQuestions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Known unknowns to track in the plan',
          },
        },
        required: ['summary', 'findings'],
      },
    };
  }

  /**
   * Create the plan generation tool
   */
  private createPlanTool(profile: PlanningProfile): LLMTool {
    return {
      name: 'plan_generate',
      description: `Generate an executable plan for domain "${profile.domain}" with concise phases and concrete tool-driven steps.`,
      inputSchema: {
        type: 'object',
        properties: {
          complexity: {
            type: 'string',
            enum: ['simple', 'medium', 'complex'],
            description: 'Task complexity assessment',
          },
          estimatedDuration: {
            type: 'string',
            description: 'Estimated implementation time (e.g., "2 hours", "1 day")',
          },
          markdown: {
            type: 'string',
            description: 'Human-readable markdown plan. Keep concise and practical.',
          },
          objective: {
            type: 'object',
            properties: {
              currentState: { type: 'string' },
              targetState: { type: 'string' },
              constraints: { type: 'array', items: { type: 'string' } },
            },
            required: ['currentState', 'targetState'],
          },
          evidence: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                source: { type: 'string' },
                artifact: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['id', 'source', 'artifact'],
            },
          },
          decisions: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                statement: { type: 'string' },
                rationale: { type: 'string' },
                evidenceIds: { type: 'array', items: { type: 'string' } },
                expectedImpact: { type: 'string' },
              },
              required: ['id', 'statement', 'rationale', 'evidenceIds', 'expectedImpact'],
            },
          },
          alternatives: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                option: { type: 'string' },
                whyRejected: { type: 'string' },
              },
              required: ['option', 'whyRejected'],
            },
          },
          changeSets: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                decisionId: { type: 'string' },
                capability: { type: 'string' },
                targets: { type: 'array', items: { type: 'string' } },
                operations: { type: 'array', items: { type: 'string' } },
                validation: { type: 'string' },
              },
              required: ['id', 'decisionId', 'capability', 'operations', 'validation'],
            },
          },
          verification: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                check: { type: 'string' },
                commandOrMethod: { type: 'string' },
                successSignal: { type: 'string' },
              },
              required: ['id', 'check', 'commandOrMethod', 'successSignal'],
            },
          },
          rollback: {
            type: 'object',
            properties: {
              trigger: { type: 'string' },
              steps: { type: 'array', items: { type: 'string' } },
            },
            required: ['trigger', 'steps'],
          },
          phases: {
            type: 'array',
            description: 'Execution phases with dependencies',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique phase ID (e.g., "phase-1")' },
                name: { type: 'string', description: 'Phase name' },
                description: { type: 'string', description: 'What this phase accomplishes' },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'IDs of phases that must complete first',
                },
                steps: {
                  type: 'array',
                  description: 'Concrete executable steps',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Unique step ID (e.g., "step-1-1")' },
                      action: { type: 'string', description: 'Concrete action using a specific tool' },
                      tool: {
                        type: 'string',
                        description: 'Tool to execute this step (must be one of available tools)',
                      },
                      args: {
                        type: 'object',
                        description: 'Tool arguments (optional)',
                      },
                      expectedOutcome: {
                        type: 'string',
                        description: 'Measurable result of this step',
                      },
                    },
                    required: ['id', 'action', 'expectedOutcome'],
                  },
                },
              },
              required: ['id', 'name', 'description', 'steps'],
            },
          },
        },
        required: ['markdown'],
      },
    };
  }

  private createRefactorPlanTool(profile: PlanningProfile): LLMTool {
    return {
      name: 'plan_generate_refactor',
      description: `Generate an executable refactoring plan for domain "${profile.domain}" focused on concrete change steps and validation.`,
      inputSchema: {
        type: 'object',
        properties: {
          complexity: {
            type: 'string',
            enum: ['simple', 'medium', 'complex'],
            description: 'Task complexity assessment',
          },
          estimatedDuration: {
            type: 'string',
            description: 'Estimated implementation time (e.g., "2 hours", "1 day")',
          },
          markdown: {
            type: 'string',
            description: 'Human-readable markdown refactor plan. Keep concise and actionable.',
          },
          objective: {
            type: 'object',
            properties: {
              currentState: { type: 'string' },
              targetState: { type: 'string' },
              constraints: { type: 'array', items: { type: 'string' } },
            },
            required: ['currentState', 'targetState'],
          },
          evidence: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                source: { type: 'string' },
                artifact: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['id', 'source', 'artifact'],
            },
          },
          refactorDecisions: {
            type: 'array',
            minItems: 3,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                target: { type: 'string', description: 'Exact file/module target' },
                action: {
                  type: 'string',
                  enum: ['extract', 'split', 'rename', 'decouple', 'replace', 'consolidate'],
                },
                rationale: { type: 'string' },
                expectedImpact: { type: 'string' },
                validation: { type: 'string' },
              },
              required: ['id', 'target', 'action', 'rationale', 'expectedImpact', 'validation'],
            },
          },
          changeSets: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                decisionId: { type: 'string' },
                targetFiles: { type: 'array', items: { type: 'string' } },
                operations: { type: 'array', items: { type: 'string' } },
                validation: { type: 'string' },
              },
              required: ['id', 'decisionId', 'targetFiles', 'operations', 'validation'],
            },
          },
          phases: {
            type: 'array',
            description: 'Execution phases with dependencies',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique phase ID (e.g., "phase-1")' },
                name: { type: 'string', description: 'Phase name' },
                description: { type: 'string', description: 'What this phase accomplishes' },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'IDs of phases that must complete first',
                },
                steps: {
                  type: 'array',
                  description: 'Concrete executable steps',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Unique step ID (e.g., "step-1-1")' },
                      action: { type: 'string', description: 'Concrete action using a specific tool' },
                      tool: {
                        type: 'string',
                        description: 'Tool to execute this step (must be one of available tools)',
                      },
                      args: {
                        type: 'object',
                        description: 'Tool arguments (optional)',
                      },
                      expectedOutcome: {
                        type: 'string',
                        description: 'Measurable result of this step',
                      },
                    },
                    required: ['id', 'action', 'expectedOutcome'],
                  },
                },
              },
              required: ['id', 'name', 'description', 'steps'],
            },
          },
        },
        required: ['markdown'],
      },
    };
  }

  private createPlanUpdateTool(): LLMTool {
    return {
      name: 'plan_update',
      description: 'Update an existing plan based on user feedback while keeping it executable and tool-driven',
      inputSchema: {
        type: 'object',
        properties: {
          complexity: {
            type: 'string',
            enum: ['simple', 'medium', 'complex'],
            description: 'Updated complexity assessment',
          },
          estimatedDuration: {
            type: 'string',
            description: 'Updated estimated implementation time',
          },
          revisionSummary: {
            type: 'string',
            description: 'Short summary of what changed in this revision',
          },
          markdown: {
            type: 'string',
            description: 'Updated human-readable markdown plan.',
          },
          phases: {
            type: 'array',
            description: 'Revised execution phases',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                dependencies: { type: 'array', items: { type: 'string' } },
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      action: { type: 'string' },
                      tool: {
                        type: 'string',
                        description: 'Tool to execute this step',
                      },
                      args: { type: 'object' },
                      expectedOutcome: { type: 'string' },
                    },
                    required: ['id', 'action', 'expectedOutcome'],
                  },
                },
              },
              required: ['id', 'name', 'description', 'steps'],
            },
          },
        },
        required: ['markdown'],
      },
    };
  }

  /**
   * Get research tools from registry (read-only tools for investigation)
   */
  private getResearchTools(registry: ToolRegistry): LLMTool[] {
    const tools: LLMTool[] = [];

    // Get all available tools and filter for research tools
    const researchToolNames = [
      'mind:rag-query',
      'mind_rag_query',
      'fs:read',
      'fs_read',
      'fs:list',
      'fs_list',
      'glob_search',
      'grep_search',
      'find_definition',
      'browser_navigate',
      'browser_snapshot',
      'mcp_query',
      'mcp_invoke',
    ];

    for (const toolName of researchToolNames) {
      const tool = registry.get(toolName);
      if (tool) {
        // Convert from agent tool definition to LLM tool format
        tools.push({
          name: tool.definition.function.name,
          description: tool.definition.function.description || '',
          inputSchema: tool.definition.function.parameters,
        });
      }
    }

    return tools;
  }

  /**
   * Normalize phases from tool call
   */
  private normalizePhasesFromTool(phases: unknown[]): Phase[] {
    return phases.map((phase, idx) => {
      const p = phase as Record<string, unknown>;
      return {
        id: typeof p.id === 'string' ? p.id : `phase-${idx + 1}`,
        name: this.normalizePhaseName(p.name, p.description, p.steps, idx + 1),
        description: this.normalizePhaseDescription(p.description, p.steps),
        dependencies: Array.isArray(p.dependencies) ? p.dependencies as string[] : [],
        status: 'pending' as const,
        steps: (Array.isArray(p.steps) ? p.steps : []).map((step: unknown, stepIdx: number) => {
          const s = step as Record<string, unknown>;
          return {
            id: typeof s.id === 'string' ? s.id : `step-${idx + 1}-${stepIdx + 1}`,
            action: this.normalizeStepAction(s.action),
            tool: typeof s.tool === 'string' ? s.tool : undefined,
            args: (s.args && typeof s.args === 'object' ? s.args : {}) as Record<string, unknown>,
            expectedOutcome: this.normalizeExpectedOutcome(s.expectedOutcome, s.action),
            status: 'pending' as const,
          };
        }),
      };
    });
  }

  private parsePhasesFromMarkdown(markdown: string): Phase[] {
    const source = typeof markdown === 'string' ? markdown.replace(/\r\n/g, '\n') : '';
    if (!source.trim()) {
      return [];
    }

    const lines = source.split('\n');
    const headingMeta: Array<{ index: number; level: 2 | 3; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const match = /^(##|###)\s+(.+?)\s*$/.exec(lines[i] || '');
      if (!match) {continue;}
      headingMeta.push({
        index: i,
        level: match[1] === '###' ? 3 : 2,
        text: (match[2] || '').trim(),
      });
    }

    const isGenericSubsection = (text: string): boolean => /^(steps?|validation|goal|risks?|verification|approval|objective|task|context|summary)\b/i.test(text);
    const isPhaseHeading = (level: 2 | 3, text: string): boolean =>
      (level === 2 && /^phase\b/i.test(text))
      || (level === 3 && !isGenericSubsection(text));

    const phaseHeadingIndexes = headingMeta
      .filter((heading) => isPhaseHeading(heading.level, heading.text))
      .map((heading) => heading.index);

    const sectionStart = lines.findIndex((line) => /^##\s+(steps?|execution plan|phases?)\b/i.test(line.trim()));
    const sectionEnd = sectionStart >= 0
      ? lines.findIndex((line, idx) => idx > sectionStart && /^##\s+/.test(line.trim()))
      : -1;

    const extractStepBullets = (body: string[]): string[] => body
      .map((line) => {
        const bullet = /^\s*[-*]\s+(.+)\s*$/.exec(line);
        if (bullet?.[1]) {return bullet[1].trim();}
        const numbered = /^\s*\d+\.\s+(.+)\s*$/.exec(line);
        return numbered?.[1]?.trim() || '';
      })
      .filter(Boolean);

    if (phaseHeadingIndexes.length === 0) {
      if (sectionStart < 0) {return [];}
      const stepSection = lines.slice(sectionStart + 1, sectionEnd >= 0 ? sectionEnd : lines.length);
      const bullets = extractStepBullets(stepSection);
      if (bullets.length === 0) {return [];}
      return [{
        id: 'phase-1',
        name: 'Implementation Steps',
        description: 'Execute the planned changes from the markdown draft.',
        dependencies: [],
        status: 'pending',
        steps: bullets.map((item, idx) => ({
          id: `step-1-${idx + 1}`,
          action: item,
          expectedOutcome: this.extractOutcomeFromAction(item),
          status: 'pending' as const,
        })),
      }];
    }

    return phaseHeadingIndexes.map((start, idx) => {
      const nextPhaseStart = phaseHeadingIndexes[idx + 1] ?? lines.length;
      const nextTopLevelSection = headingMeta
        .find((heading) => heading.index > start && heading.level === 2 && !/^phase\b/i.test(heading.text))
        ?.index;
      const end = Math.min(nextPhaseStart, nextTopLevelSection ?? lines.length);
      const heading = (lines[start] || '').replace(/^(##|###)\s+/, '').trim() || `Step Group ${idx + 1}`;
      const body = lines.slice(start + 1, end);
      const bullets = extractStepBullets(body);

      const steps = (bullets.length > 0 ? bullets : ['Execute planned changes for this section']).map((item, stepIdx) => ({
        id: `step-${idx + 1}-${stepIdx + 1}`,
        action: item,
        expectedOutcome: this.extractOutcomeFromAction(item),
        status: 'pending' as const,
      }));

      const descriptionLine = body.find((line) => line.trim().length > 0 && !/^\s*[-*]\s+/.test(line))?.trim();

      return {
        id: `phase-${idx + 1}`,
        name: this.normalizePhaseName(heading, descriptionLine, steps, idx + 1),
        description: this.normalizePhaseDescription(descriptionLine, steps),
        dependencies: idx === 0 ? [] : [`phase-${idx}`],
        status: 'pending' as const,
        steps,
      };
    });
  }

  private normalizePlanMarkdown(task: string, markdown: unknown, phases: Phase[]): string {
    const text = typeof markdown === 'string' ? markdown.replace(/\r\n/g, '\n').trim() : '';
    const looksLikePlaceholder = /(placeholder|need research first|\btbd\b|\btodo\b)/i.test(text);
    if (text && !looksLikePlaceholder) {
      return text;
    }

    const renderedPhases = phases.map((phase) => [
      `### ${phase.name}`,
      '',
      phase.description,
      '',
      ...phase.steps.map((step) => `- ${step.action}`),
    ].join('\n')).join('\n\n');

    return [
      `# Plan: ${task || 'Untitled Task'}`,
      '',
      '## Task',
      '',
      task || '(not specified)',
      '',
      '## Steps',
      '',
      renderedPhases || '### Core Work\n\n- Define and execute the main implementation steps.',
      '',
      '## Risks',
      '',
      '- Unknown dependencies may require scoped adjustments.',
      '',
      '## Verification',
      '',
      '- Run focused checks for touched scope.',
      '',
      '## Approval',
      '',
      '- Approve this plan for execution?',
    ].join('\n').trim();
  }

  private createFallbackPhases(task: string): Phase[] {
    const taskLabel = (task || 'the requested task').trim();
    return [{
      id: 'phase-1',
      name: 'Execute Core Work',
      description: 'Fallback executable sequence when model output is missing structured phases.',
      dependencies: [],
      status: 'pending',
      steps: [
        {
          id: 'step-1-1',
          action: `Identify concrete files/modules and boundaries for ${taskLabel}`,
          expectedOutcome: 'Relevant scope and change points are identified',
          status: 'pending',
        },
        {
          id: 'step-1-2',
          action: `Implement the required changes for ${taskLabel}`,
          expectedOutcome: 'Requested behavior or structure is implemented',
          status: 'pending',
        },
        {
          id: 'step-1-3',
          action: `Run focused verification for ${taskLabel}`,
          tool: 'shell:exec',
          args: { command: 'pnpm test --filter planning || pnpm test' },
          expectedOutcome: 'Verification commands pass for touched scope',
          status: 'pending',
        },
      ],
    }];
  }

  private synthesizeRefactorPhasesFromChangeSets(changeSets: unknown[] | undefined): Phase[] {
    if (!Array.isArray(changeSets) || changeSets.length === 0) {
      return [];
    }

    return changeSets
      .filter((item): item is {
        id?: string;
        targetFiles?: unknown;
        operations?: unknown;
        validation?: string;
      } => typeof item === 'object' && item !== null)
      .slice(0, 8)
      .map((set, idx) => {
        const targetFiles = Array.isArray(set.targetFiles)
          ? set.targetFiles.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        const operations = Array.isArray(set.operations)
          ? set.operations.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        const stepPrefix = `step-${idx + 1}`;
        const steps: Phase['steps'] = [];

        if (targetFiles.length > 0) {
          steps.push({
            id: `${stepPrefix}-1`,
            action: `Apply refactor edits in files: ${targetFiles.join(', ')}`,
            tool: 'fs:edit',
            args: { paths: targetFiles },
            expectedOutcome: 'Refactor edits applied to target files',
            status: 'pending',
          });
        }

        if (operations.length > 0) {
          steps.push({
            id: `${stepPrefix}-2`,
            action: `Implement operations: ${operations.join('; ')}`,
            tool: 'fs:edit',
            args: { operations },
            expectedOutcome: 'Declared refactor operations implemented',
            status: 'pending',
          });
        }

        steps.push({
          id: `${stepPrefix}-3`,
          action: `Run validation for ${set.id || `change-set-${idx + 1}`}`,
          tool: 'shell:exec',
          args: { command: set.validation || 'pnpm test' },
          expectedOutcome: 'Validation command completes successfully',
          status: 'pending',
        });

        return {
          id: `phase-${idx + 1}`,
          name: this.normalizePhaseName(
            set.id || `Change Set ${idx + 1}`,
            `Implement and validate ${set.id || `change set ${idx + 1}`}`,
            steps,
            idx + 1
          ),
          description: `Implement and validate ${set.id || `change set ${idx + 1}`}`,
          dependencies: idx === 0 ? [] : [`phase-${idx}`],
          status: 'pending',
          steps,
        };
      });
  }

  private normalizePhaseName(
    rawName: unknown,
    rawDescription: unknown,
    rawSteps: unknown,
    _index: number
  ): string {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';
    const steps = Array.isArray(rawSteps) ? rawSteps : [];

    const genericName = /^phase\s+\d+(\s*:\s*(cs\d+|change set \d+|changeset \d+))?$/i.test(name)
      || /^cs\d+$/i.test(name)
      || /^change set \d+$/i.test(name);
    if (!name || genericName) {
      const candidateFromDescription = this.extractHumanLabel(description);
      if (candidateFromDescription) {return candidateFromDescription;}
      const firstAction = typeof steps[0]?.action === 'string' ? steps[0].action : '';
      const candidateFromAction = this.extractHumanLabel(firstAction);
      if (candidateFromAction) {return candidateFromAction;}
      return 'Key Changes';
    }
    return name;
  }

  private normalizePhaseDescription(rawDescription: unknown, rawSteps: unknown): string {
    const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';
    if (description) {
      return description;
    }
    const steps = Array.isArray(rawSteps) ? rawSteps : [];
    const firstAction = typeof steps[0]?.action === 'string' ? steps[0].action.trim() : '';
    return firstAction || 'Deliver the planned changes for this phase.';
  }

  private normalizeStepAction(rawAction: unknown): string {
    const action = typeof rawAction === 'string' ? rawAction.trim() : '';
    if (!action) {
      return 'Apply planned changes for this step';
    }
    return action;
  }

  private normalizeExpectedOutcome(rawExpected: unknown, rawAction: unknown): string {
    const expected = typeof rawExpected === 'string' ? rawExpected.trim() : '';
    if (
      expected &&
      !/^(declared refactor operations implemented|validation command completes successfully|changes applied)$/i.test(expected)
    ) {
      return expected;
    }
    const action = typeof rawAction === 'string' ? rawAction.trim() : '';
    if (action) {
      return this.extractOutcomeFromAction(action);
    }
    return 'Step completed with measurable result.';
  }

  private extractHumanLabel(input: string): string {
    const compact = input
      .replace(/^implement operations:\s*/i, '')
      .replace(/^run validation for\s*/i, 'Validation: ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!compact) {return '';}
    const firstChunk = compact.split(';')[0]?.trim() || '';
    if (!firstChunk) {return '';}
    return firstChunk.length > 64 ? `${firstChunk.slice(0, 61)}...` : firstChunk;
  }

  private extractOutcomeFromAction(action: string): string {
    const normalized = action
      .replace(/^run validation for\s*/i, 'Validation completed for ')
      .replace(/^implement operations:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) {
      return 'Step completed with measurable result.';
    }
    const chunk = normalized.split(';')[0]?.trim() || normalized;
    return chunk.length > 110 ? `${chunk.slice(0, 107)}...` : chunk;
  }

  /**
   * Build system prompt for plan generation
   */
  private buildSystemPrompt(
    task: string,
    mode: AgentMode,
    complexity?: 'simple' | 'medium' | 'complex',
    researchContext?: string,
    planToolName: 'plan_generate' | 'plan_generate_refactor' = 'plan_generate',
    planningProfile?: PlanningProfile,
  ): string {
    const modeContext = this.getModeContext(mode);
    const profile = planningProfile || this.buildPlanningProfile(task);
    const availableTools = profile.availableTools.length > 0 ? profile.availableTools : ['fs_read', 'fs_patch', 'fs_write', 'fs_list', 'shell_exec', 'glob_search', 'grep_search'];
    const preferredTools = profile.preferredTools.length > 0 ? profile.preferredTools : availableTools.slice(0, 6);
    const capabilities = profile.capabilities.length > 0 ? profile.capabilities : ['analysis', 'implementation', 'verification'];

    // Build research context section if available
    const researchSection = researchContext
      ? `\n\nRESEARCH FINDINGS:
The following information was gathered by research agents analyzing the codebase:

${researchContext}

Use this research to inform your implementation plan. Focus on ACTIONABLE IMPLEMENTATION STEPS, not meta-level research.`
      : '';

    return `You are an AI planning orchestrator creating an EXECUTABLE plan.

Task: ${task}

Mode: ${mode}
${modeContext}
Domain: ${profile.domain}
Capabilities: ${capabilities.join(', ')}
Available tools: ${availableTools.join(', ')}
Preferred tools for this task: ${preferredTools.join(', ')}

${complexity ? `Complexity hint: ${complexity}` : ''}${researchSection}

CRITICAL CONSTRAINTS:
1. Generate an outcome-driven plan from CURRENT STATE (A) to TARGET STATE (B). No meta-plan about "how to plan".
2. Every step must be executable with available tools. No placeholders, no "someone else will do X".
3. Keep it domain-appropriate:
   - If task is code-centric, use code/search/shell tools.
   - If task is browser/MCP-centric, use browser/MCP tools when available.
   - Do not force file-edit steps when the task domain is not coding.
4. For refactoring tasks:
   - Include concrete design decisions and exact refactor actions (e.g., extract class/function, split module, add interface, replace dependency).
   - Keep discovery steps minimal; majority of steps should drive actual changes.

PLAN LANGUAGE: Write the plan body text in the SAME language as the task description. Section headings can stay in English, but descriptions and prose MUST match the user's language.

PLAN STYLE — the plan is for a HUMAN reader:
- Write like you're explaining the plan to a colleague. A real person will read this to verify you understood the task and didn't miss anything.
- For each phase/step, briefly explain WHY — not just what to change, but what it achieves and why it's needed.
- Show you understood the current code: describe what exists now before explaining what changes.
- Use short prose between steps to connect the narrative flow — not a raw checklist.
- Keep code snippets to 3-5 lines max. Reference line numbers instead of pasting large blocks.
- Every step MUST reference a real file path or a shell command.
  BAD:  "Update the configuration file"
  GOOD: "Edit packages/agent-core/src/planning/plan-generator.ts — add specificity scoring"
  BAD:  "Run tests"
  GOOD: "pnpm --filter @kb-labs/agents/core test"

TOOL OUTPUT REQUIREMENT:
- Return a complete markdown draft in the "markdown" field through ${planToolName}.
- Markdown must include at minimum: Task, Steps, Risks, Verification, Approval.
- You may additionally include structured phases/steps fields, but markdown is mandatory.

PREFERRED MARKDOWN SKELETON:
# <Short plan title>
## Table of Contents
- [Task](#task)
- [Steps](#steps)
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)

## Task
- Current state (A):
- Target state (B):
- Scope boundaries:

## Steps
### Phase 1: <Name>
- Goal:
- Actions:
- Expected outcome:

### Phase 2: <Name>
- Goal:
- Actions:
- Expected outcome:

## Risks
- Risk:
- Mitigation:

## Verification
- Command/check:
- Success signal:

## Approval
- Ready for approval: yes/no
- Open questions (if any):
`;
  }

  private buildResearchSystemPrompt(
    task: string,
    mode: AgentMode,
    complexity?: 'simple' | 'medium' | 'complex'
  ): string {
    return `You are planning research for autonomous implementation.

Task: ${task}
Mode: ${mode}
${complexity ? `Complexity hint: ${complexity}` : ''}

Collect concrete implementation-relevant findings and submit them using the plan_research tool.
Avoid generic statements. Focus on files, modules, boundaries, and likely change points.`;
  }

  private buildUpdateSystemPrompt(
    plan: TaskPlan,
    feedback: string,
    mode: AgentMode,
    researchContext?: string
  ): string {
    const researchSection = researchContext
      ? `\n\nAdditional research findings for this revision:\n${researchContext}`
      : '';

    return `You are updating an execution plan from user feedback.

Current plan task: ${plan.task}
Mode: ${mode}
Feedback: ${feedback}

Current phases:
${plan.phases.map((phase, idx) => `${idx + 1}. ${phase.name}: ${phase.description}`).join('\n')}

${researchSection}

Return ONLY updated plan data through plan_update tool.
Keep the revision human-readable and concise; preserve only essential structure and concrete outcomes.
Return updated markdown in the "markdown" field (mandatory).`;
  }

  private buildPlanningProfile(task: string, toolRegistry?: ToolRegistry): PlanningProfile {
    const text = task.toLowerCase();
    const availableTools = toolRegistry?.getToolNames() || [];

    const domain = /mcp\b|model context protocol|server tools|external server/.test(text)
      ? 'mcp'
      : /browser|ui|website|page|dom|click|form|navigation|scrape/.test(text)
        ? 'browser'
        : /refactor|code|typescript|module|api|test|build|lint|package/.test(text)
          ? 'code'
          : 'general';

    const capabilities = new Set<string>();
    for (const tool of availableTools) {
      if (/^fs_|^glob_search$|^grep_search$|^find_definition$/.test(tool)) {capabilities.add('filesystem-analysis');}
      if (/^fs_patch$|^fs_write$|^mass_replace$/.test(tool)) {capabilities.add('code-modification');}
      if (/^shell_exec$/.test(tool)) {capabilities.add('command-execution');}
      if (/^browser_/.test(tool)) {capabilities.add('browser-automation');}
      if (/^mcp_/.test(tool)) {capabilities.add('mcp-integration');}
      if (/^mind/.test(tool)) {capabilities.add('semantic-search');}
      if (/^ask_user$/.test(tool)) {capabilities.add('clarification');}
    }

    const preferredByDomain: Record<PlanningProfile['domain'], string[]> = {
      code: ['find_definition', 'grep_search', 'glob_search', 'fs_read', 'fs_patch', 'mass_replace', 'shell_exec'],
      browser: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_submit'],
      mcp: ['mcp_query', 'mcp_invoke', 'grep_search', 'shell_exec'],
      general: ['grep_search', 'glob_search', 'fs_list', 'shell_exec', 'ask_user'],
    };

    const preferredTools = preferredByDomain[domain].filter((tool) => availableTools.includes(tool));

    return {
      domain,
      availableTools,
      preferredTools,
      capabilities: Array.from(capabilities),
    };
  }

  private extractPathHints(task: string): string[] {
    const matches = task.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) || [];
    return Array.from(new Set(matches.map((value) => value.trim()).filter(Boolean))).slice(0, 8);
  }

  private extractKeywordHints(task: string): string[] {
    const words = task
      .toLowerCase()
      .replace(/[^a-z0-9_\s/-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4);
    const stop = new Set(['create', 'plan', 'executable', 'improve', 'with', 'from', 'this', 'that', 'into', 'mode', 'task']);
    return Array.from(new Set(words.filter((token) => !stop.has(token)))).slice(0, 10);
  }

  /**
   * Get mode-specific context for plan generation
   */
  private getModeContext(mode: AgentMode): string {
    switch (mode) {
      case 'plan':
        return 'Focus on generating a comprehensive plan without execution. Include research, design, and implementation phases.';
      case 'edit':
        return 'Focus on file modifications. Start with reading existing files, then editing them. No new file creation unless necessary.';
      case 'debug':
        return 'Focus on error investigation. Include trace analysis, root cause identification, and fix implementation.';
      case 'execute':
      default:
        return 'Focus on complete task execution from start to finish.';
    }
  }

  private getPlanToolName(task: string): 'plan_generate' | 'plan_generate_refactor' {
    return this.isRefactorTask(task) ? 'plan_generate_refactor' : 'plan_generate';
  }

}
