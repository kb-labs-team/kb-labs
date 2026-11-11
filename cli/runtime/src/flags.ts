import { CliError, CLI_ERROR_CODES } from "./errors";
import { getLogger } from "./platform-logger.js";

const logger = getLogger("cli:flags");

/**
 * Convert kebab-case flag name to camelCase
 * Examples: "task-id" → "taskId", "dry-run" → "dryRun"
 */
function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export type GlobalFlags = {
  json?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  profile?: string;
  profilesDir?: string;
  gatewayUrl?: string;
  noColor?: boolean;
  verbose?: boolean; // Deprecated: use --debug instead
  debug?: boolean | "verbose" | "inspect" | "profile";
  help?: boolean;
  version?: boolean;
  quiet?: boolean;
  dryRun?: boolean; // New: dry-run mode
  saveSnapshot?: boolean; // New: explicit snapshot save
  mock?: boolean; // New: use mock fixtures
  recordMocks?: boolean; // New: record operations to mocks
};

export function validateCommandFlags(
  flags: Record<string, unknown>,
  schema: Array<{ name: string; type: string; choices?: string[] }>,
): void {
  for (const def of schema) {
    const value = flags[def.name];
    if (value === undefined) {
      continue;
    }

    // Type validation
    if (def.type === "boolean" && typeof value !== "boolean") {
      const errorMsg = [
        `❌ Invalid type for --${def.name}`,
        "",
        `Expected: boolean`,
        `Got: ${typeof value}`,
        "",
        "Hint: Try --help for more information",
      ].join("\n");

      throw new CliError(CLI_ERROR_CODES.E_INVALID_FLAGS, errorMsg);
    }

    // Choice validation
    if (def.choices && !def.choices.includes(String(value))) {
      const errorMsg = [
        `❌ Invalid value for --${def.name}: ${value}`,
        "",
        `Must be one of: ${def.choices.join(", ")}`,
        "",
        "Hint: Try --help for more information",
      ].join("\n");

      throw new CliError(CLI_ERROR_CODES.E_INVALID_FLAGS, errorMsg);
    }
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export function parseArgs(argv: string[]): {
  cmdPath: string[];
  rest: string[];
  global: GlobalFlags;
  flagsObj: Record<string, unknown>;
} {
  const args = [...argv];
  const global: GlobalFlags = {};
  const flagsObj: Record<string, unknown> = {};
  const cmdPath: string[] = [];

  while (args.length) {
    const a = args[0]!;
    if (a === "--") {
      args.shift();
      break;
    }
    if (a.startsWith("-")) {
      args.shift();
      switch (a) {
        case "--json":
          global.json = true;
          break;
        case "--help":
          global.help = true;
          break;
        case "--version":
          if (cmdPath.length > 0) {
            const value = args[0];
            flagsObj.version = value !== undefined && !value.startsWith("-") ? args.shift() : true;
          } else {
            global.version = true;
          }
          break;
        case "--no-color":
          global.noColor = true;
          break;
        case "--quiet":
          global.quiet = true;
          break;
        case "--dry-run":
          global.dryRun = true;
          flagsObj["dry-run"] = true; // Also add to command flags
          break;
        case "--save-snapshot":
          global.saveSnapshot = true;
          break;
        case "--mock":
          global.mock = true;
          break;
        case "--record-mocks":
          global.recordMocks = true;
          break;
        case "--debug":
          // Support --debug or --debug=level
          const nextArg = args[0];
          if (
            nextArg &&
            !nextArg.startsWith("-") &&
            ["verbose", "inspect", "profile"].includes(nextArg)
          ) {
            global.debug = args.shift() as "verbose" | "inspect" | "profile";
            global.logLevel = "debug";
          } else {
            global.debug = true;
            global.logLevel = "debug";
          }
          break;
        case "--verbose":
          // Deprecated: show warning and map to --debug
          logger.warn(
            "[DEPRECATED] --verbose is deprecated. Use --debug instead.",
          );
          global.debug = true;
          global.verbose = true; // Keep for backward compatibility
          global.logLevel = "debug";
          break;
        case "--log-level":
          global.logLevel = String(args.shift()) as
            | "debug"
            | "info"
            | "warn"
            | "error";
          break;
        case "--profile":
          global.profile = String(args.shift());
          break;
        case "--profiles-dir":
          global.profilesDir = String(args.shift());
          break;
        case "--gateway-url": {
          const value = args.shift();
          if (!value || value.startsWith("-")) {
            throw new CliError(CLI_ERROR_CODES.E_INVALID_FLAGS, "--gateway-url requires an HTTP URL value.");
          }
          global.gatewayUrl = value;
          break;
        }
        default: {
          // generic key/value or boolean
          // Support both --flag=value and --flag value syntax
          const stripped = a.replace(/^--/, "");

          if (stripped.includes("=")) {
            // --flag=value syntax
            const [key, ...valueParts] = stripped.split("=");
            if (key) {
              const value = valueParts.join("="); // rejoin in case value contains =

              // Special handling for --debug=level
              if (
                key === "debug" &&
                ["verbose", "inspect", "profile"].includes(value)
              ) {
                global.debug = value as "verbose" | "inspect" | "profile";
                global.logLevel = "debug";
              } else if (key === "gateway-url") {
                global.gatewayUrl = value;
              } else {
                flagsObj[key] = value;
              }
            }
          } else {
            // --flag value or --flag (boolean) syntax
            const key = stripped;
            const maybe = args[0];
            if (!maybe || String(maybe).startsWith("-")) {
              flagsObj[key] = true;
            } else {
              flagsObj[key] = args.shift();
            }
          }
        }
      }
    } else {
      cmdPath.push(String(args.shift()));
      // поддерживаем команды из 1–2 слов: e.g. "init", "init", "profile"
      // НЕ останавливаем обработку после команды, чтобы обрабатывать флаги
    }
  }
  const rest = args;

  if (cmdPath.length > 0 && global.version) {
    flagsObj.version = true;
    delete global.version;
  }

  // Fallback to KB_PROFILE env var if --profile not provided
  // Priority: --profile flag > KB_PROFILE env var > default
  if (!global.profile && process.env.KB_PROFILE) {
    global.profile = process.env.KB_PROFILE;
  }

  // Normalize all kebab-case flag keys to camelCase
  // This ensures handlers can use camelCase consistently regardless of CLI input format
  // Examples: --task-id → taskId, --dry-run → dryRun
  const normalizedFlags: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flagsObj)) {
    const camelKey = kebabToCamel(key);
    normalizedFlags[camelKey] = value;

    // Also preserve original kebab-case key for backward compatibility
    if (camelKey !== key) {
      normalizedFlags[key] = value;
    }
  }

  return { cmdPath, rest, global, flagsObj: normalizedFlags };
}
