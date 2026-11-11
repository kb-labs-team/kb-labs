import { resolve } from 'node:path';
import { defineSystemCommand, type SystemCommandContext } from '@kb-labs/shared-command-kit';
import { handleError, type CommandResult } from '@kb-labs/sdk';
import { scanRoot, type Finding } from '@kb-labs/scaffold-core';

type DoctorResult = { root: string; packagesScanned: number; findings: Finding[] };

export const scaffoldDoctor = defineSystemCommand<{
  path: { type: 'string'; description?: string };
  json: { type: 'boolean'; description?: string };
}, CommandResult<DoctorResult>>({
  name: 'doctor',
  scope: 'project',
  jsonTest: { safeArgs: ['--path', '.kb/plugins'] },
  description: 'Scan user-authored plugins for common issues',
  category: 'scaffold',
  flags: {
    path: { type: 'string', description: 'Path to scan (default: .kb/plugins)' },
    json: { type: 'boolean', description: 'Emit JSON instead of text' },
  },
  examples: ['kb scaffold doctor', 'kb scaffold doctor --path ./plugins', 'kb scaffold doctor --json'],
  async handler(ctx: SystemCommandContext, _argv, input): Promise<CommandResult<DoctorResult>> {
      const root = resolve(input.path ?? '.kb/plugins');
      const workspaceRoot = ctx.cwd ?? process.cwd();
      let scan: Awaited<ReturnType<typeof scanRoot>>;
      try {
        scan = await scanRoot(root, { workspaceRoot });
      } catch (err) {
        return handleError(err);
      }

      const { errorCount, warnCount } = scan.findings.reduce(
        (acc, f) => {
          if (f.severity === 'error') { acc.errorCount++; }
          else if (f.severity === 'warn') { acc.warnCount++; }
          return acc;
        },
        { errorCount: 0, warnCount: 0 },
      );
      const hasErrors = errorCount > 0;
      const result = {
        root,
        packagesScanned: scan.packagesScanned,
        findings: scan.findings,
      };

      if (!input.json && scan.findings.length === 0) {
        ctx.ui?.success?.(`Scanned ${scan.packagesScanned} package(s) — no issues found.`, {
          title: 'scaffold doctor',
          sections: [
            { items: [`Path: ${root}`] },
          ],
        });
      } else if (!input.json) {
        const byPkg = new Map<string, Finding[]>();
        for (const f of scan.findings) {
          const list = byPkg.get(f.package) ?? [];
          list.push(f);
          byPkg.set(f.package, list);
        }

        const sections = Array.from(byPkg.entries()).map(([pkg, findings]) => ({
          header: pkg,
          items: findings.map((f) => `${f.severity.toUpperCase()}  ${f.message}`),
        }));

        if (!hasErrors) {
          ctx.ui?.warn?.(`Found ${warnCount} warning(s) in ${scan.packagesScanned} package(s).`, {
            title: 'scaffold doctor',
            sections,
          });
        }
      }

      return hasErrors
        ? {
            ok: false,
            error: {
              code: 'KB_RUNTIME_COMMAND_FAILED',
              message: `${errorCount} error(s) found`,
              hint: 'Inspect error.diagnostics above and fix the affected plugin manifests, then rerun `kb scaffold doctor`.',
              diagnostics: scan.findings.filter((finding) => finding.severity !== 'info').map((finding) => ({
                code: 'KB_SCAFFOLD_DOCTOR_FINDING',
                severity: finding.severity === 'warn' ? 'warning' as const : 'error' as const,
                message: `${finding.package}: ${finding.message}`,
              })),
            },
          }
        : result;
  },
});
