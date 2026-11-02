/**
 * @module @kb-labs/core/config/runtime
 * Infrastructure-only config pipeline (no domain keys).
 * Provides: nearest config discovery, safe JSON read with diagnostics,
 * deep merge that ignores `undefined`, and a generic resolver (defaults→file→env→cli).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { Diagnostic, FindNearestConfigOpts, JsonReadResult, ProfilesConfig, KBConfig } from "../types";

/** Find nearest config file walking up from startDir until stopDir or FS root. */
export async function findNearestConfig(opts: FindNearestConfigOpts): Promise<{ path: string | null; tried: string[] }> {
    const start = path.resolve(opts.startDir ?? process.cwd());
    const stop = opts.stopDir ? path.resolve(opts.stopDir) : null;

    const tried: string[] = [];
    let dir = start;

    while (true) {
        for (const name of opts.filenames) {
            const candidate = path.join(dir, name);
            tried.push(candidate);
            try {
                await fsp.access(candidate);
                return { path: candidate, tried };
            } catch { /* continue */ }
        }
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        if (stop && (dir === stop || parent === stop)) { break; }
        dir = parent;
    }
    return { path: null, tried };
}

/** Read JSON with explicit diagnostics (no silent nulls). */
/** Strip single-line (//) and multi-line (/* *\/) comments from a JSON string. */
function stripJsonComments(src: string): string {
    let out = '';
    let i = 0;
    const len = src.length;
    while (i < len) {
        if (src[i] === '"') {
            // String literal — copy verbatim until closing quote.
            out += src[i++];
            while (i < len) {
                if (src[i] === '\\') { out += src[i++]; out += src[i++]; continue; }
                out += src[i];
                if (src[i++] === '"') {break;}
            }
        } else if (src[i] === '/' && src[i + 1] === '/') {
            // Single-line comment — skip to end of line.
            while (i < len && src[i] !== '\n') {i++;}
        } else if (src[i] === '/' && src[i + 1] === '*') {
            // Multi-line comment — skip to *\/
            i += 2;
            while (i < len && !(src[i] === '*' && src[i + 1] === '/')) {i++;}
            i += 2;
        } else {
            out += src[i++];
        }
    }
    // Remove trailing commas before } or ] (not valid JSON but allowed in JSONC).
    return out.replace(/,(\s*[}\]])/g, '$1');
}

export async function readJsonWithDiagnostics<T = unknown>(p: string, onInputRead?: (filePath: string, bytes: Buffer) => void): Promise<JsonReadResult<T>> {
    const diagnostics: Diagnostic[] = [];
    try {
        const bytes = await fsp.readFile(p);
        onInputRead?.(p, bytes);
        const raw = bytes.toString("utf8");
        try {
            const stripped = p.endsWith('.jsonc') ? stripJsonComments(raw) : raw;
            const data = JSON.parse(stripped) as T;
            return { ok: true, data, diagnostics };
        } catch (e) {
            diagnostics.push({ level: "error", code: "JSON_PARSE_FAILED", message: `Failed to parse JSON: ${p}`, detail: String(e), path: p, hint: `Run \`python3 -m json.tool "${p}"\`, then repair the config.` });
            return { ok: false, diagnostics };
        }
    } catch (e) {
        diagnostics.push({ level: "error", code: "FILE_READ_FAILED", message: `Failed to read file: ${p}`, detail: String(e), path: p, hint: `Check access with \`ls -l "${p}"\`, then repair the config.` });
        return { ok: false, diagnostics };
    }
}

/** Shallow pick of defined fields only. */
export function pickDefined<T extends Record<string, unknown>>(obj: T | undefined): Partial<T> {
    if (!obj) { return {}; }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) { out[k] = v; }
    }
    return out as Partial<T>;
}

/** Deep merge (objects/arrays), ignoring `undefined` on the overlay. */
export function mergeDefined<T>(base: T, over?: Partial<T>): T {
    if (!over) { return base; }
    if (Array.isArray(base) && Array.isArray(over)) {
        return [...base, ...over.filter(v => v !== undefined)] as unknown as T;
    }
    if (isPlainObject(base) && isPlainObject(over)) {
        const baseObj: Record<string, unknown> = base;
        const out: Record<string, unknown> = { ...baseObj };
        for (const [k, v] of Object.entries(over)) {
            if (v === undefined) { continue; }
            if (isPlainObject(baseObj[k]) && isPlainObject(v)) {
                out[k] = mergeDefined(baseObj[k], v);
            } else if (Array.isArray(baseObj[k]) && Array.isArray(v)) {
                out[k] = mergeDefined(baseObj[k], v);
            } else {
                out[k] = v;
            }
        }
        return out as T;
    }
    // Different types → overlay wins if defined
    return (over as T) ?? base;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * Policy for a single top-level field during platform ← project merge.
 *  - `platform-only`  — ignore the project layer's value (emit warning upstream).
 *  - `mergeable`      — deep-merge (project overrides platform).
 *  - `project-only`   — take the project value as-is; platform layer is dropped.
 */
export type FieldMergePolicy = "platform-only" | "mergeable" | "project-only";

export interface MergeWithFieldPolicyResult<T> {
    /** Merged config object. */
    value: T;
    /** Top-level field names where the project layer was ignored because the field is `platform-only`. */
    ignoredProjectFields: string[];
    /** Per-field provenance: `'platform'`, `'project'`, or `'both'`. */
    sources: Record<string, "platform" | "project" | "both">;
}

/**
 * Merge two config layers using a per-field policy map.
 *
 * The `policy` map is keyed by top-level field names on the config object.
 * Fields missing from the map default to `mergeable` — i.e. deep-merge with
 * project overriding platform.
 */
export function mergeWithFieldPolicy<T extends object>(
    platform: Partial<T> | undefined,
    project: Partial<T> | undefined,
    policy: Partial<Record<keyof T, FieldMergePolicy>>,
): MergeWithFieldPolicyResult<T> {
    const out: Record<string, unknown> = {};
    const sources: Record<string, "platform" | "project" | "both"> = {};
    const ignoredProjectFields: string[] = [];

    const keys = new Set<string>([
        ...Object.keys(platform ?? {}),
        ...Object.keys(project ?? {}),
    ]);

    for (const key of keys) {
        const platformValue = (platform as Record<string, unknown> | undefined)?.[key];
        const projectValue = (project as Record<string, unknown> | undefined)?.[key];
        const fieldPolicy = (policy as Record<string, FieldMergePolicy | undefined>)[key] ?? "mergeable";

        const hasPlatform = platformValue !== undefined;
        const hasProject = projectValue !== undefined;

        if (fieldPolicy === "platform-only") {
            if (hasProject) { ignoredProjectFields.push(key); }
            if (hasPlatform) {
                out[key] = platformValue;
                sources[key] = "platform";
            }
            continue;
        }

        if (fieldPolicy === "project-only") {
            if (hasProject) {
                out[key] = projectValue;
                sources[key] = "project";
            } else if (hasPlatform) {
                // Platform layer carries a value for a project-only field — drop it silently;
                // it has no semantic meaning at the platform layer.
                continue;
            }
            continue;
        }

        // mergeable
        if (hasPlatform && hasProject) {
            out[key] = mergeDefined(platformValue as never, projectValue as never);
            sources[key] = "both";
        } else if (hasPlatform) {
            out[key] = platformValue;
            sources[key] = "platform";
        } else if (hasProject) {
            out[key] = projectValue;
            sources[key] = "project";
        }
    }

    return { value: out as T, ignoredProjectFields, sources };
}

const SYSTEM_DEFAULTS = {
    profiles: { rootDir: '.kb/profiles', defaultName: 'default', strict: true }
} as const;

export interface ResolveConfigArgs<TConfig, _TEnvMap = unknown> {
    defaults: TConfig;
    fileConfig?: Partial<TConfig>;
    envMapper?: (env: NodeJS.ProcessEnv) => Partial<TConfig> | undefined; // product supplies mapping
    cliOverrides?: Partial<TConfig>;
    validate?: (cfg: TConfig) => { ok: boolean; diagnostics?: Diagnostic[] }; // product supplies validation
}

/**
 * Generic resolver: defaults → fileConfig → envMapper(process.env) → cliOverrides.
 * No domain keys inside; mapping/validation provided by the product/shared layer.
 */
export function resolveConfig<TConfig>(args: ResolveConfigArgs<TConfig>): { value: TConfig; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const envPart = args.envMapper?.(process.env) ?? {};

    const merged = mergeDefined(
        mergeDefined(
            mergeDefined(mergeDefined(structuredClone(SYSTEM_DEFAULTS) as unknown as Partial<TConfig>, structuredClone(args.defaults)), args.fileConfig),
            envPart,
        ),
        args.cliOverrides,
    ) as TConfig;

    if (args.validate) {
        const res = args.validate(merged);
        if (!res.ok) {
            diagnostics.push({ level: "error", code: "CONFIG_VALIDATION_FAILED", message: "Configuration did not pass validation." });
            if (res.diagnostics) { diagnostics.push(...res.diagnostics); }
        } else if (res.diagnostics?.length) {
            diagnostics.push(...res.diagnostics);
        }
    }

    return { value: merged, diagnostics };
}

export { SYSTEM_DEFAULTS };
export type { ProfilesConfig, KBConfig };
