import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { z } from 'zod'

export const RemoteMarketplaceSourceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  ref: z.string().optional(), // branch/tag, default: 'main'
  path: z.string().optional(), // subdirectory in repo, default: '/'
})

export const BudgetConfigSchema = z.object({
  enabled: z.boolean().default(false),
  limit: z.number().positive().optional(), // Total budget limit (in cost units)
  period: z.enum(['run', 'day', 'week', 'month']).default('run'),
  action: z.enum(['warn', 'fail', 'cancel']).default('warn'),
  // Extension point: custom cost calculator plugin
  costCalculator: z.string().optional(),
})

export const WorkflowConfigSchema = z.object({
  workspaces: z.array(z.string()).default(['.kb/workflows/**/*.{yml,yaml}']),
  plugins: z.boolean().default(true),
  remotes: z.array(RemoteMarketplaceSourceSchema).optional(),
  maxDepth: z.number().int().positive().default(2),
  budget: BudgetConfigSchema.optional(),
  defaults: z
    .object({
      mode: z.enum(['wait', 'fire-and-forget']).default('wait'),
      inheritEnv: z.boolean().default(true),
    })
    .optional(),
})

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>
export type RemoteMarketplaceSource = z.infer<typeof RemoteMarketplaceSourceSchema>
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>

/**
 * Load workflow configuration from kb.config.json
 */
export async function loadWorkflowConfig(
  workspaceRoot: string,
): Promise<WorkflowConfig> {
  const configPath = join(workspaceRoot, 'kb.config.json')

  try {
    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as { workflow?: unknown }

    if (!config.workflow) {
      return WorkflowConfigSchema.parse({})
    }

    return WorkflowConfigSchema.parse(config.workflow)
  } catch (error) {
    // If file doesn't exist or is invalid, return defaults
    if (
      error instanceof Error &&
      (error.message.includes('ENOENT') ||
        error.message.includes('Unexpected token'))
    ) {
      return WorkflowConfigSchema.parse({})
    }
    throw error
  }
}

/**
 * Save workflow configuration to kb.config.json
 * Safely merges with existing config without overwriting other sections
 */
export async function saveWorkflowConfig(
  workspaceRoot: string,
  updates: Partial<WorkflowConfig>,
): Promise<void> {
  const configPath = join(workspaceRoot, 'kb.config.json')

  // Load existing config
  let existingConfig: Record<string, unknown> = {}
  try {
    const raw = await readFile(configPath, 'utf-8')
    existingConfig = JSON.parse(raw)
  } catch {
    // File doesn't exist or is invalid, start fresh
    existingConfig = {}
  }

  // Merge workflow section
  const currentWorkflow = (existingConfig.workflow ?? {}) as Record<string, unknown>
  const updatedWorkflow = {
    ...currentWorkflow,
    ...updates,
    // Deep merge for arrays (remotes)
    remotes: updates.remotes ?? currentWorkflow.remotes,
  }

  // Update config
  const updatedConfig = {
    ...existingConfig,
    workflow: updatedWorkflow,
  }

  // Ensure directory exists
  await mkdir(dirname(configPath), { recursive: true })

  // Write with pretty formatting
  await writeFile(
    configPath,
    JSON.stringify(updatedConfig, null, 2) + '\n',
    'utf-8',
  )
}

