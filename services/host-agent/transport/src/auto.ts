/**
 * createTransport — factory that picks the right ILocalTransport
 * based on config.mode (or platform when mode === 'auto').
 *
 * auto resolution:
 *   Windows  → NamedPipeTransport
 *   Linux/Mac → UnixSocketTransport
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ILocalTransport, TransportConfig } from './transport.js';
import { UnixSocketTransport } from './unix-socket.js';
import { NamedPipeTransport } from './named-pipe.js';
import { TcpTransport } from './tcp.js';

const DEFAULT_SOCKET_PATH = join(homedir(), '.kb', 'agent.sock');
const DEFAULT_PIPE_NAME = 'kb-agent';
const DEFAULT_TCP_PORT = 7779;
const DEFAULT_TCP_HOST = '127.0.0.1';

export function createTransport(config: TransportConfig): ILocalTransport {
  const mode = config.mode === 'auto'
    ? (process.platform === 'win32' ? 'named-pipe' : 'unix')
    : config.mode;

  switch (mode) {
    case 'unix':
      return new UnixSocketTransport(config.socketPath ?? DEFAULT_SOCKET_PATH);
    case 'named-pipe':
      return new NamedPipeTransport(config.pipeName ?? DEFAULT_PIPE_NAME);
    case 'tcp':
      return new TcpTransport(
        config.port ?? DEFAULT_TCP_PORT,
        config.host ?? DEFAULT_TCP_HOST,
      );
    default:
      throw new Error(`Unknown transport mode: ${String(mode)}`);
  }
}
