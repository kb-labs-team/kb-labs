import { test, expect, type APIRequestContext } from '@playwright/test';
import { GATEWAY, WORKFLOW } from '@kb-labs/e2e-shared/urls.js';

const journeyEnabled = process.env.KB_STUDIO_FIRST_TIER_JOURNEY === '1';
const accessMode = process.env.KB_ACCESS_MODE ?? 'local';
const projectId = process.env.KB_STUDIO_PROJECT_ID;
const projectBId = process.env.KB_STUDIO_PROJECT_B_ID;
const healthyRunId = process.env.KB_STUDIO_HEALTHY_PROJECT_RUN_ID;
const failedRunId = process.env.KB_STUDIO_DIAGNOSTIC_RUN_ID;

async function openWorkflowRuns(page: import('@playwright/test').Page, selectedProjectId: string) {
  await page.addInitScript((id) => localStorage.setItem('kb.workflow.projectId', id), selectedProjectId);
  await page.goto(`${GATEWAY}/`);
  if (accessMode === 'secured') {
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill(process.env.KB_STUDIO_ADMIN_EMAIL!);
    await page.getByLabel('Password').fill(process.env.KB_STUDIO_ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(page).not.toHaveURL(/\/login$/);
  }
  await page.goto(`${GATEWAY}/p/workflows/runs`);
  await expect(page.getByRole('heading', { name: 'Workflow Runs', exact: true })).toBeVisible();
}

/**
 * Studio workflow pages smoke tests.
 *
 * Checks that the built-in Studio workflow route and daemon API are available.
 *
 * Missing Studio or workflow routes fail because both are required services.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

async function studioIsUp(
  request: APIRequestContext,
): Promise<boolean> {
  try {
    const res = await request.get(`${GATEWAY}/`, { timeout: 3000 });
    return res.status() === 200;
  } catch {
    return false;
  }
}

async function workflowIsUp(
  request: APIRequestContext,
): Promise<boolean> {
  try {
    const res = await request.get(`${WORKFLOW}/health`, { timeout: 3000 });
    return res.status() === 200;
  } catch {
    return false;
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('SW-01: built-in Studio serves the workflow runs page', async ({ page }) => {
  await page.goto(`${GATEWAY}/p/workflows/runs`);
  await expect(page.getByRole('heading', { name: 'Workflow Runs', exact: true })).toBeVisible();
});

test('SW-02: Studio SPA shell responds for /workflows route', async ({ request }) => {
  const up = await studioIsUp(request);
  expect(!up, 'Studio not available — run kb-dev start').toBe(false);

  // In a SPA all routes serve the same index.html — 404 would mean the route
  // is not caught by the gateway proxy/static fallback.
  const res = await request.get(`${GATEWAY}/workflows`);
  expect([200, 301, 302]).toContain(res.status());
  if (res.status() === 200) {
    const text = await res.text();
    expect(text.toLowerCase()).toContain('<html');
  }
});

test('SW-03: Studio SPA shell responds for /workflows/runs route', async ({ request }) => {
  const up = await studioIsUp(request);
  expect(!up, 'Studio not available — run kb-dev start').toBe(false);

  const res = await request.get(`${GATEWAY}/workflows/runs`);
  expect([200, 301, 302]).toContain(res.status());
});

test('SW-04: Workflow daemon API — /api/v1/runs used by runs list page', async ({ request }) => {
  const up = await workflowIsUp(request);
  expect(up, 'Workflow daemon is required by this journey').toBe(true);

  const res = await request.get(`${WORKFLOW}/api/v1/runs`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const runs = body.data?.runs ?? body.data ?? body.runs;
  expect(Array.isArray(runs)).toBe(true);
});

test('SW-05: Workflow daemon API — /api/v1/workflows used by definitions page', async ({ request }) => {
  const up = await workflowIsUp(request);
  expect(up, 'Workflow daemon is required by this journey').toBe(true);

  const res = await request.get(`${WORKFLOW}/api/v1/workflows`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const workflows = body.data?.workflows ?? body.data ?? body.workflows;
  expect(Array.isArray(workflows)).toBe(true);
});

test('SW-06: Workflow daemon API — /api/v1/cron used by cron jobs page', async ({ request }) => {
  const up = await workflowIsUp(request);
  expect(up, 'Workflow daemon is required by this journey').toBe(true);

  const res = await request.get(`${WORKFLOW}/api/v1/crons`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const crons = body.data?.crons ?? body.crons ?? body.data ?? [];
  expect(Array.isArray(crons)).toBe(true);
});

test('selected project workflow history shows its successful and failed runs @S-021.1', async ({ page }) => {
  test.skip(!journeyEnabled, 'Enabled by the installed Studio journey hook');
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  expect(healthyRunId, 'workflow journey must provide a successful run ID').toBeTruthy();
  expect(failedRunId, 'workflow journey must provide a failed run ID').toBeTruthy();

  await openWorkflowRuns(page, projectId!);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.getByText(healthyRunId!.slice(0, 16), { exact: false })).toBeVisible();
  await expect(page.getByText(failedRunId!.slice(0, 16), { exact: false })).toBeVisible();
  await expect(page.getByText('journey-hello@1', { exact: true })).toBeVisible();
  await expect(page.getByText('journey-fails@1', { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Status', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Started At', exact: true })).toBeVisible();
  await expect(page.getByText('Done', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();
});

test('workflow run details expose terminal status and captured step logs @S-021.2 @S-021.3 @S-021.4', async ({ page }) => {
  test.skip(!journeyEnabled, 'Enabled by the installed Studio journey hook');
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  expect(healthyRunId, 'workflow journey must provide a successful run ID').toBeTruthy();
  expect(failedRunId, 'workflow journey must provide a failed run ID').toBeTruthy();

  await openWorkflowRuns(page, projectId!);
  await page.goto(`${GATEWAY}/p/workflows/runs/${encodeURIComponent(healthyRunId!)}`);
  await expect(page.getByRole('heading', { name: 'journey-hello', exact: true })).toBeVisible();
  await expect(page.getByText(`Run ${healthyRunId!.slice(0, 12)}...`, { exact: true })).toBeVisible();
  await expect(page.getByText('Success', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Engineering', exact: true }).click();
  await expect(page.getByText('hello', { exact: false }).last()).toBeVisible();

  await page.goto(`${GATEWAY}/p/workflows/runs/${encodeURIComponent(failedRunId!)}`);
  await expect(page.getByRole('heading', { name: 'journey-fails', exact: true })).toBeVisible();
  await expect(page.getByText(`Run ${failedRunId!.slice(0, 12)}...`, { exact: true })).toBeVisible();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Engineering', exact: true }).click();
  await expect(page.getByText('Deliberate failure', { exact: false }).last()).toBeVisible();
  await expect(page.getByText('Shell command failed with exit code 23', { exact: false }).last()).toBeVisible();
  await expect(page.getByText('journey-failure-diagnostic', { exact: false }).last()).toBeVisible();
});

test('workflow history stays scoped when another selected project has no runs @S-021.5', async ({ page }) => {
  test.skip(!journeyEnabled, 'Enabled by the installed Studio journey hook');
  expect(projectBId, 'KB_STUDIO_PROJECT_B_ID must identify the empty workflow project').toBeTruthy();
  expect(healthyRunId, 'workflow journey must provide a successful run ID').toBeTruthy();
  expect(failedRunId, 'workflow journey must provide a failed run ID').toBeTruthy();

  await openWorkflowRuns(page, projectBId!);
  await expect(page.getByText('No runs found', { exact: true })).toBeVisible();
  await expect(page.getByText(healthyRunId!.slice(0, 16), { exact: false })).toHaveCount(0);
  await expect(page.getByText(failedRunId!.slice(0, 16), { exact: false })).toHaveCount(0);
});
