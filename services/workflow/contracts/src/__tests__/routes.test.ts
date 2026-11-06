import { describe, expect, it } from 'vitest';
import { projectWorkflowEndpoint, projectWorkflowRoute } from '../routes.js';

describe('project workflow routes', () => {
  it('builds the host route and Studio hook endpoint from the same project path', () => {
    expect(projectWorkflowRoute('prj_0123456789abcdef', '/runs')).toBe(
      '/api/v1/projects/prj_0123456789abcdef/workflow/runs',
    );
    expect(projectWorkflowEndpoint('prj_0123456789abcdef', 'runs')).toBe(
      '/v1/projects/prj_0123456789abcdef/workflow/runs',
    );
  });

  it('encodes project IDs as a path segment', () => {
    expect(projectWorkflowRoute('prj/unsafe')).toBe(
      '/api/v1/projects/prj%2Funsafe/workflow',
    );
  });
});
