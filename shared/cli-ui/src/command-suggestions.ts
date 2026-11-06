/**
 * Command suggestions and validation utilities
 */

export interface CommandSuggestion {
  id: string;
  command: string;
  args: string[];
  description: string;
  impact: 'safe' | 'disruptive';
  when: string;
  available?: boolean;
}

export interface CommandRegistry {
  commands: Set<string>;
  groups: Map<string, Set<string>>;
}

/**
 * Create a command registry from available commands
 */
export function createCommandRegistry(commands: string[]): CommandRegistry {
  const commandSet = new Set(commands);
  const groups = new Map<string, Set<string>>();
  
  // Group commands by prefix (e.g., "devlink:apply" -> group "devlink")
  for (const cmd of commands) {
    const [group, ...rest] = cmd.split(':');
    if (group && rest.length > 0) {
      if (!groups.has(group)) {
        groups.set(group, new Set());
      }
      groups.get(group)!.add(rest.join(':'));
    }
  }
  
  return {
    commands: commandSet,
    groups
  };
}

/**
 * Check if a command is available in the registry
 */
export function isCommandAvailable(
  command: string, 
  registry: CommandRegistry
): boolean {
  // Handle full command strings like "kb devlink apply"
  if (command.startsWith('kb ')) {
    const parts = command.split(' ');
    if (parts.length >= 3 && parts[1] && parts[2]) {
      const group = parts[1];
      const subcommand = parts[2];
      const fullCommand = `${group}:${subcommand}`;
      return registry.commands.has(fullCommand);
    }
  }
  
  // Handle direct command names like "devlink:apply"
  return registry.commands.has(command);
}

/**
 * Validate suggestions against available commands
 */
export function validateSuggestions(
  suggestions: CommandSuggestion[],
  registry: CommandRegistry
): CommandSuggestion[] {
  return suggestions.map(suggestion => ({
    ...suggestion,
    available: isCommandAvailable(suggestion.command, registry)
  })).filter(suggestion => suggestion.available);
}

/**
 * Generate common devlink suggestions
 */
export function generateDevlinkSuggestions(
  warningCodes: Set<string>,
  context: { undo?: { available: boolean } },
  registry: CommandRegistry
): CommandSuggestion[] {
  const suggestions: CommandSuggestion[] = [];

  // LOCK_MISMATCH -> apply
  if (warningCodes.has('LOCK_MISMATCH')) {
    suggestions.push({
      id: 'SYNC_LOCK',
      command: 'kb devlink apply',
      args: ['--yes'],
      description: 'Apply changes to sync manifests',
      impact: 'safe',
      when: 'LOCK_MISMATCH'
    });
  }

  // BACKUP_MISSING -> freeze
  if (warningCodes.has('BACKUP_MISSING')) {
    suggestions.push({
      id: 'CREATE_BACKUP',
      command: 'kb devlink lock create',
      args: ['--replace'],
      description: 'Create a fresh backup',
      impact: 'safe',
      when: 'BACKUP_MISSING'
    });
  }

  // STALE_LOCK -> freeze
  if (warningCodes.has('STALE_LOCK')) {
    suggestions.push({
      id: 'REFRESH_LOCK',
      command: 'kb devlink lock create',
      args: ['--pin=caret'],
      description: 'Refresh lock file',
      impact: 'safe',
      when: 'STALE_LOCK'
    });
  }

  // STALE_YALC_ARTIFACTS -> clean
  if (warningCodes.has('STALE_YALC_ARTIFACTS')) {
    suggestions.push({
      id: 'CLEAN_YALC',
      command: 'kb devlink clean',
      args: [],
      description: 'Remove yalc artifacts',
      impact: 'safe',
      when: 'STALE_YALC_ARTIFACTS'
    });
  }

  // PROTOCOL_CONFLICTS -> clean --hard
  if (warningCodes.has('PROTOCOL_CONFLICTS')) {
    suggestions.push({
      id: 'FIX_PROTOCOLS',
      command: 'kb devlink clean',
      args: ['--hard'],
      description: 'Reset all protocols and reapply',
      impact: 'disruptive',
      when: 'PROTOCOL_CONFLICTS'
    });
  }

  // Undo suggestion
  if (context.undo?.available) {
    suggestions.push({
      id: 'UNDO_LAST',
      command: 'kb devlink rollback',
      args: [],
      description: 'Revert last operation',
      impact: 'safe',
      when: 'BACKUP_AVAILABLE'
    });
  }

  // Validate and return only available suggestions
  return validateSuggestions(suggestions, registry);
}


/**
 * Generate quick actions for common scenarios
 */
export function generateQuickActions(
  hasWarnings: boolean,
  registry: CommandRegistry,
  group: string = 'devlink'
): CommandSuggestion[] {
  if (!hasWarnings) {return [];}

  const quickActions: CommandSuggestion[] = [
    {
      id: 'QUICK_CLEAN',
      command: `kb ${group} clean`,
      args: [],
      description: 'Clean artifacts',
      impact: 'safe',
      when: 'QUICK_ACTIONS'
    },
    {
      id: 'QUICK_PLAN',
      command: `kb ${group} plan`,
      args: [],
      description: 'Create plan',
      impact: 'safe',
      when: 'QUICK_ACTIONS'
    },
    {
      id: 'QUICK_APPLY',
      command: `kb ${group} apply`,
      args: [],
      description: 'Apply changes',
      impact: 'safe',
      when: 'QUICK_ACTIONS'
    }
  ];

  return validateSuggestions(quickActions, registry);
}
