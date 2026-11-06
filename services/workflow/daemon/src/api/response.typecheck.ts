import type { FastifyReply } from 'fastify';
import { fail } from './response.js';

declare const reply: FastifyReply;

// @ts-expect-error Workflow responses may only carry details declared for their code.
fail(reply, { code: 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', message: 'Workflow run was not found.', details: { runId: 'run-1', reason: 'missing' } });
