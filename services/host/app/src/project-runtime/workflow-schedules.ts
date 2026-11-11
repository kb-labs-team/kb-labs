import type { IProjectRegistry } from "@kb-labs/core-project-registry";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { RuntimeProject } from "./manager.js";

/** Return registered projects with enabled project cron schedules. */
export async function findScheduledProjects(
  registry: Pick<IProjectRegistry, "list">,
): Promise<RuntimeProject[]> {
  const { projects } = await registry.list();
  const scheduled: RuntimeProject[] = [];
  for (const view of projects) {
    const project = view.project;
    if (project.status !== "active" || !view.pathExists) { continue; }
    const cronDir = join(project.path, ".kb", "crons");
    const count = await countEnabledSchedules(cronDir, isEnabledCron);
    if (count > 0) {
      scheduled.push({ id: project.id, root: project.path, keptRunningSchedules: count });
    }
  }
  return scheduled;
}

async function countEnabledSchedules(
  directory: string,
  accepts: (definition: Record<string, unknown>) => boolean,
): Promise<number> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return 0;
  }

  let count = 0;
  for (const file of files.filter((name) => name.endsWith(".yml"))) {
    try {
      const definition: unknown = YAML.parse(await readFile(join(directory, file), "utf8"));
      if (definition && typeof definition === "object" && accepts(definition as Record<string, unknown>)) {
        count += 1;
      }
    } catch {
      // The workflow daemon reports invalid definitions; they cannot schedule.
    }
  }
  return count;
}

function isEnabledCron(definition: Record<string, unknown>): boolean {
  return typeof definition.schedule === "string"
    && (typeof definition.workflow === "string" || typeof definition.handler === "string")
    && definition.enabled !== false;
}
