import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { TaskPlan } from '../../contracts/index.js';
import { PlanDocumentService } from '../planning/plan-document-service.js';
import { SessionManager } from '../planning/session-manager.js';

export interface PlanArtifactWriteResult {
  planPath: string;
  documentPath: string;
  markdown: string;
}

export class PlanArtifactWriter {
  constructor(
    private readonly workingDir: string,
    private readonly sessionManager = new SessionManager(workingDir),
    private readonly documentService = new PlanDocumentService(workingDir),
  ) {}

  async write(sessionId: string, plan: TaskPlan): Promise<PlanArtifactWriteResult> {
    const planPath = this.sessionManager.getSessionPlanPath(sessionId);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    const draft = await this.documentService.createDraft(plan);
    return {
      planPath,
      documentPath: draft.path,
      markdown: draft.markdown,
    };
  }
}
