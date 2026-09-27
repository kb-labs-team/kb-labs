import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executionFactoryEntry = fileURLToPath(import.meta.resolve('@kb-labs/plugin-execution-factory'));
const source = join(dirname(executionFactoryEntry), 'backends', 'worker-pool', 'worker-script.js');
const target = join(process.cwd(), 'dist', 'backends', 'worker-pool', 'worker-script.js');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
