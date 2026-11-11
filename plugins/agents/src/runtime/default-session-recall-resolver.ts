import type { KernelState, ToolCallRecord } from '../contracts/index.js';
import type { SessionRecallResolver } from '../sdk/index.js';

export function createDefaultSessionRecallResolver(): SessionRecallResolver {
  return {
    id: 'default-session-recall-resolver',
    resolve(input) {
      const fileAnswer = resolveFileRecallAnswer(input.task, input.state, input.toolRecords);
      if (fileAnswer) {
        return {
          answer: fileAnswer.answer,
          confidence: 0.98,
          filesRead: fileAnswer.files,
        };
      }

      if (!input.responseRequirements?.requirements.allowsMemoryOnlyRecall) {
        return null;
      }

      const commandAnswer = resolveCommandRecallAnswer(input.task, input.state, input.toolRecords);
      if (commandAnswer) {
        return {
          answer: commandAnswer.answer,
          confidence: 0.98,
          filesRead: [],
        };
      }

      return null;
    },
  };
}

function resolveFileRecallAnswer(
  task: string,
  kernel: KernelState,
  toolRecords: ToolCallRecord[],
): { answer: string; files: string[] } | null {
  if (!/(which files|what files|did you inspect|did you read|files have you inspected|какие файлы|что ты читал|какие файлы ты смотрел)/i.test(task)) {
    return null;
  }

  const files = uniqueStrings([
    ...toolRecords
      .filter((record) => record.toolName === 'fs_read')
      .map((record) => typeof record.input.path === 'string' ? record.input.path : undefined),
    ...kernel.memory.evidence
      .filter((item) => item.toolName === 'fs_read')
      .map((item) => item.toolInputSummary),
    ...(kernel.handoff?.filesRead ?? []),
  ]);

  if (files.length === 0) {
    return null;
  }

  return {
    answer: files.length === 1
      ? `I inspected exactly this file in the session: ${files[0]}.`
      : `I inspected these files in the session:\n- ${files.join('\n- ')}`,
    files,
  };
}

function resolveCommandRecallAnswer(
  task: string,
  kernel: KernelState,
  toolRecords: ToolCallRecord[],
): { answer: string } | null {
  if (!/(which commands|what commands|previous shell command|latest shell command|какую команду|какие команды)/i.test(task)) {
    return null;
  }

  const commands = uniqueStrings([
    ...toolRecords
      .filter((record) => record.toolName === 'shell_exec')
      .map((record) => typeof record.input.command === 'string' ? record.input.command : undefined),
    ...kernel.memory.evidence
      .filter((item) => item.toolName === 'shell_exec')
      .map((item) => item.toolInputSummary),
  ]);

  if (commands.length === 0) {
    return null;
  }

  return {
    answer: commands.length === 1
      ? `I used this shell command in the session: ${commands[0]}.`
      : `I used these shell commands in the session:\n- ${commands.join('\n- ')}`,
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const normalized = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(normalized)];
}
