/**
 * Plugin Configuration Contract
 *
 * Defines the shape of plugin configuration stored in kb.config.json
 * under plugins.template section.
 *
 * This type is the single source of truth for:
 * - defineSetup (setup handler knows what config to create)
 * - defineCommand (commands can access typed config)
 * - REST handlers (API can access typed config)
 */

/**
 * Greeting configuration
 */
export interface GreetingConfig {
  /** Path to greeting config file */
  configPath: string;
  /** Default name to greet */
  defaultName: string;
}

/**
 * Output configuration
 */
export interface OutputConfig {
  /** Output directory for generated files */
  directory: string;
}

/**
 * Plugin configuration stored in kb.config.json
 *
 * @example
 * ```json
 * {
 *   "plugins": {
 *     "template": {
 *       "enabled": true,
 *       "greeting": {
 *         "configPath": ".kb/template/hello-config.json",
 *         "defaultName": "KB Labs"
 *       },
 *       "output": {
 *         "directory": ".kb/template/output"
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface PluginConfig {
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Greeting configuration */
  greeting: GreetingConfig;
  /** Output configuration */
  output: OutputConfig;
}

/**
 * Default plugin configuration values
 */
export const defaultPluginConfig: PluginConfig = {
  enabled: true,
  greeting: {
    configPath: '.kb/template/hello-config.json',
    defaultName: 'KB Labs',
  },
  output: {
    directory: '.kb/template/output',
  },
};
