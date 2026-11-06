/**
 * ILocalTransport — abstraction over the IPC channel between
 * CLI/Studio (client) and Host Agent daemon (server).
 *
 * Both sides use the same interface:
 * - Server: listen() + onMessage()
 * - Client: connect() + send()
 */

export interface ILocalTransport {
  /** Server side: start accepting connections */
  listen(): Promise<void>;
  /** Client side: connect to the server */
  connect(): Promise<void>;
  /** Send a message (both sides) */
  send(msg: unknown): void;
  /** Register a handler for incoming messages */
  onMessage(handler: (msg: unknown) => void): void;
  /** Close the connection / server */
  close(): void;
}

export type TransportMode = 'unix' | 'named-pipe' | 'tcp' | 'auto';

export interface TransportConfig {
  mode: TransportMode;
  /** Unix socket path (unix mode). Default: ~/.kb/agent.sock */
  socketPath?: string;
  /** Named pipe name (named-pipe mode). Default: kb-agent */
  pipeName?: string;
  /** TCP port (tcp mode). Default: 7779 */
  port?: number;
  /** TCP host (tcp mode). Default: 127.0.0.1 */
  host?: string;
}
