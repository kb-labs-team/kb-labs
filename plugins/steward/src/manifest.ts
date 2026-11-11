/**
 * V3 plugin manifest for steward — personal PM/CRM tool-layer for AI agents.
 * See docs/adr/0001-steward-design.md for the full design.
 *
 * The platform generates MCP tools for agents from `cli.commands` below, so
 * `describe`/`examples` double as the prompt an agent reads to pick a tool —
 * write them for a model, not just a human at a terminal.
 */
import { combinePermissions, kbPlatformPreset } from '@kb-labs/sdk';
import { cronDecl as dailyReviewCron } from './jobs/daily-review.js';
import { cronDecl as exportBackupCron } from './jobs/export-backup.js';

const JSON_FLAG = { name: 'json', type: 'boolean', description: 'Emit JSON instead of text' } as const;

const permissions = combinePermissions()
  .with(kbPlatformPreset)
  .withPlatform({
    database: {
      document: {
        collections: [
          'projects',
          'resources',
          'people',
          'companies',
          'project_members',
          'commitments',
          'events',
          'topics',
        ],
      },
    },
  })
  .build();

const baseManifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/steward',
  version: '0.1.0',
  display: {
    name: 'Steward',
    description:
      'Personal PM/CRM tool-layer for AI agents: projects, people, commitments, and routing across dozens of parallel projects.',
    tags: ['pm', 'crm', 'agents', 'productivity'],
  },
  platform: {
    requires: ['documentDatabase'],
  },
  cli: {
    groupMeta: [{ path: 'steward', describe: 'Personal PM/CRM for AI agents' }],
    commands: [
      // ── Project ──────────────────────────────────────────────────────
      {
        path: 'steward project add',
        describe: 'Create a new project',
        handler: './commands/project-add.js#default',
        flags: [
          { name: 'name', type: 'string', description: 'Project name', required: true },
          {
            name: 'status',
            type: 'string',
            description: 'active | paused | archived',
            default: 'active',
          },
          { name: 'description', type: 'string', description: 'Free-text description' },
          JSON_FLAG,
        ],
        examples: [
          'kb steward project add --name="Acme API" --description="Payments backend"',
        ],
      },
      {
        path: 'steward project get',
        describe: 'Get a project card: status, resources, and members',
        handler: './commands/project-get.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward project get "Acme API"', 'kb steward project get prj_01H...'],
      },
      {
        path: 'steward project list',
        describe: 'List projects, optionally filtered by status',
        handler: './commands/project-list.js#default',
        flags: [
          { name: 'status', type: 'string', description: 'active | paused | archived' },
          JSON_FLAG,
        ],
        examples: ['kb steward project list', 'kb steward project list --status=active'],
      },
      {
        path: 'steward project update',
        describe: 'Update a project\'s status or description',
        handler: './commands/project-update.js#default',
        flags: [
          { name: 'status', type: 'string', description: 'active | paused | archived' },
          { name: 'description', type: 'string', description: 'New description' },
          JSON_FLAG,
        ],
        examples: ['kb steward project update prj_01H... --status=paused'],
      },
      // ── Resource ─────────────────────────────────────────────────────
      {
        path: 'steward resource add',
        describe: 'Attach a resource to a project (repo, stand, dashboard, doc, ...)',
        handler: './commands/resource-add.js#default',
        flags: [
          { name: 'type', type: 'string', description: 'Free-form kind, e.g. repo, dev-stand, dashboard', required: true },
          { name: 'label', type: 'string', description: 'Human-readable label', required: true },
          { name: 'url', type: 'string', description: 'External link, if any' },
          { name: 'content', type: 'string', description: 'Stored markdown content, if any' },
          JSON_FLAG,
        ],
        examples: [
          'kb steward resource add prj_01H... --type=repo --url=https://github.com/acme/api',
        ],
      },
      {
        path: 'steward resource list',
        describe: 'List resources attached to a project',
        handler: './commands/resource-list.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward resource list prj_01H...'],
      },
      // ── Person / Company / Member ────────────────────────────────────
      {
        path: 'steward person add',
        describe: 'Add a contact. Returns a possibleDuplicates warning, not an error, on a name match',
        handler: './commands/person-add.js#default',
        flags: [
          { name: 'name', type: 'string', description: 'Full name', required: true },
          { name: 'topics', type: 'string', description: 'Comma-separated global competencies' },
          { name: 'company', type: 'string', description: 'Company id' },
          JSON_FLAG,
        ],
        examples: ['kb steward person add --name="Ivanov" --topics=frontend,architecture'],
      },
      {
        path: 'steward person update',
        describe: 'Update a contact\'s name, topics, or company',
        handler: './commands/person-update.js#default',
        flags: [
          { name: 'name', type: 'string', description: 'New name' },
          { name: 'topics', type: 'string', description: 'Comma-separated global competencies (replaces existing)' },
          { name: 'company', type: 'string', description: 'Company id' },
          JSON_FLAG,
        ],
        examples: ['kb steward person update per_01H... --topics=frontend,backend'],
      },
      {
        path: 'steward person get',
        describe: 'Get a contact by id or exact name',
        handler: './commands/person-get.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward person get "Ivanov"'],
      },
      {
        path: 'steward person list',
        describe: 'List every known contact',
        handler: './commands/person-list.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward person list'],
      },
      {
        path: 'steward company add',
        describe: 'Add a company (thin — just a name to link people to)',
        handler: './commands/company-add.js#default',
        flags: [
          { name: 'name', type: 'string', description: 'Company name', required: true },
          JSON_FLAG,
        ],
        examples: ['kb steward company add --name="Acme Corp"'],
      },
      {
        path: 'steward company list',
        describe: 'List companies',
        handler: './commands/company-list.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward company list'],
      },
      {
        path: 'steward member add',
        describe: 'Link a person to a project with a role and fallback priority',
        handler: './commands/member-add.js#default',
        flags: [
          { name: 'person', type: 'string', description: 'Person id', required: true },
          { name: 'project', type: 'string', description: 'Project id', required: true },
          { name: 'role', type: 'string', description: 'Role in this project', required: true },
          { name: 'topics', type: 'string', description: 'Comma-separated project-scoped competencies' },
          { name: 'priority', type: 'number', description: 'Lower = contacted first', default: 0 },
          JSON_FLAG,
        ],
        examples: ['kb steward member add --person=per_01H... --project=prj_01H... --role=lead --priority=0'],
      },
      {
        path: 'steward member list',
        describe: 'List members of a project, ordered by fallback priority',
        handler: './commands/member-list.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward member list prj_01H...'],
      },
      // ── Routing ──────────────────────────────────────────────────────
      {
        path: 'steward person search',
        describe:
          'Find who to contact about a topic. With --project, project-scoped members take priority (fallback chain); otherwise matches global competencies across every contact',
        handler: './commands/who.js#default',
        flags: [
          { name: 'project', type: 'string', description: 'Prefer members of this project' },
          JSON_FLAG,
        ],
        examples: ['kb steward person search "frontend" --project=prj_01H...', 'kb steward person search "grafana"'],
      },
      // ── Commitment ───────────────────────────────────────────────────
      {
        path: 'steward commitment add',
        describe: 'Record a promise made to a person, with an optional soft reminder date',
        handler: './commands/commitment-add.js#default',
        flags: [
          { name: 'text', type: 'string', description: 'What was promised', required: true },
          { name: 'person', type: 'string', description: 'Person id' },
          { name: 'project', type: 'string', description: 'Project id' },
          { name: 'remind-at', type: 'string', description: 'ISO date/time for the reminder' },
          { name: 'stale-after-days', type: 'number', description: 'Days of silence before it counts as stale', default: 14 },
          JSON_FLAG,
        ],
        examples: ['kb steward commitment add --text="Send X" --person=per_01H... --remind-at=2026-09-01'],
      },
      {
        path: 'steward commitment list',
        describe: 'List commitments, optionally only the stale (overdue, unsnoozed) ones',
        handler: './commands/commitment-list.js#default',
        flags: [
          { name: 'status', type: 'string', description: 'open | done | dropped' },
          { name: 'project', type: 'string', description: 'Project id' },
          { name: 'stale-only', type: 'boolean', description: 'Only overdue, unsnoozed, open commitments' },
          JSON_FLAG,
        ],
        examples: ['kb steward commitment list --stale-only'],
      },
      {
        path: 'steward commitment done set',
        describe: 'Mark a commitment fulfilled',
        handler: './commands/commitment-done.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward commitment done set cmt_01H...'],
      },
      {
        path: 'steward commitment remove',
        describe: 'Cancel a commitment — reason is required and recorded in history',
        handler: './commands/commitment-drop.js#default',
        flags: [
          { name: 'reason', type: 'string', description: 'Why it was dropped', required: true },
          JSON_FLAG,
        ],
        examples: ['kb steward commitment remove cmt_01H... --reason="No longer relevant"'],
      },
      {
        path: 'steward commitment reminder update',
        describe: 'Postpone a commitment\'s reminder without cancelling it',
        handler: './commands/commitment-snooze.js#default',
        flags: [
          { name: 'until', type: 'string', description: 'ISO date/time to snooze until', required: true },
          { name: 'reason', type: 'string', description: 'Why it was postponed' },
          JSON_FLAG,
        ],
        examples: ['kb steward commitment reminder update cmt_01H... --until=2026-09-15 --reason="Waiting on client"'],
      },
      // ── Event ────────────────────────────────────────────────────────
      {
        path: 'steward event add',
        describe: 'Record a manual note against a project, person, or commitment — the primary tool for backfill import',
        handler: './commands/event-add.js#default',
        flags: [
          { name: 'subject-type', type: 'string', description: 'project | person | commitment | company | resource', required: true },
          { name: 'subject-id', type: 'string', description: 'Id of the subject', required: true },
          { name: 'text', type: 'string', description: 'Note text' },
          { name: 'kind', type: 'string', description: 'Event kind', default: 'note' },
          JSON_FLAG,
        ],
        examples: ['kb steward event add --subject-type=person --subject-id=per_01H... --text="Talked at the conference"'],
      },
      {
        path: 'steward event list',
        describe: 'Read the history log for a subject — "what happened with X"',
        handler: './commands/event-list.js#default',
        flags: [
          { name: 'subject-type', type: 'string', description: 'project | person | commitment | company | resource' },
          { name: 'subject-id', type: 'string', description: 'Id of the subject' },
          { name: 'kind', type: 'string', description: 'Filter by event kind' },
          JSON_FLAG,
        ],
        examples: ['kb steward event list --subject-type=project --subject-id=prj_01H...'],
      },
      // ── Topic ────────────────────────────────────────────────────────
      {
        path: 'steward topic add',
        describe: 'Register a topic with aliases in the routing dictionary — do this deliberately, not automatically',
        handler: './commands/topic-add.js#default',
        flags: [
          { name: 'name', type: 'string', description: 'Canonical topic name', required: true },
          { name: 'aliases', type: 'string', description: 'Comma-separated aliases' },
          JSON_FLAG,
        ],
        examples: ['kb steward topic add --name=frontend --aliases=фронт,фронтенд,front-end'],
      },
      {
        path: 'steward topic list',
        describe: 'List the topic dictionary',
        handler: './commands/topic-list.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward topic list'],
      },
      // ── Review ───────────────────────────────────────────────────────
      {
        path: 'steward review show',
        describe:
          'Daily summary: stale commitments, upcoming reminders, active projects, and days since the last successful backup',
        handler: './commands/review.js#default',
        flags: [JSON_FLAG],
        examples: ['kb steward review show'],
      },
    ],
  },
  cron: {
    schedules: [dailyReviewCron, exportBackupCron],
  },
  jobs: {
    handlers: [
      {
        id: 'daily-review',
        describe: 'Writes .kb/steward/reviews/<date>.md',
        handler: './jobs/daily-review.js#default',
      },
      {
        id: 'export-backup',
        describe: 'Writes .kb/steward/exports/<date>.json — git commit/push happens at the workflow level',
        handler: './jobs/export-backup.js#default',
      },
    ],
  },
  artifacts: [
    {
      id: 'steward.review.md',
      pathTemplate: '.kb/steward/reviews/{date}.md',
      description: 'Daily review — stale commitments, upcoming reminders, backup health.',
    },
    {
      id: 'steward.export.json',
      pathTemplate: '.kb/steward/exports/{date}.json',
      description: 'Daily snapshot of every collection, for the private-repo backup.',
    },
  ],
} as const;

export const manifestWithPermissions: typeof baseManifest & { permissions: unknown } = { ...baseManifest, permissions };
export const manifest: typeof manifestWithPermissions = manifestWithPermissions;
