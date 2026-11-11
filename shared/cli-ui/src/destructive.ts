import type { CommandFailure } from '@kb-labs/plugin-contracts';

/**
 * Destructive-action protocol (SOFT layer).
 *
 * A single, platform-wide way for a command to declare that an operation is
 * destructive — how bad, how broad, and whether it can be undone — and to gate
 * it behind explicit confirmation in EVERY mode (human and agent).
 *
 * This layer is intentionally SOFT: it informs and asks, it does not enforce.
 * Physical enforcement (can-this-token-even-invoke-this) is the platform's
 * future token/permission layer; it reads the SAME `severity`/`destructive`
 * declaration on the command. So one declaration drives both:
 *   - now:   this helper renders a clear signal + requires `--yes`;
 *   - later: the permission layer filters discovery + blocks invocation by right.
 *
 * Declaring it is OPTIONAL for external plugins (commands work without it) but
 * strongly recommended — agents can only reason about blast radius they're told.
 */

export type DestructiveSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Severity rubric — worst-case blast radius weighed against recovery cost
 * (keep consistent across plugins so agents can calibrate):
 *  - low      narrow scope AND trivially auto-rebuilt from source (idempotent)
 *  - medium   a bounded set is lost; rebuildable, but with effort/recompute
 *  - high     a WHOLE collection is destroyed (entire index/corpus), OR recovery
 *             is slow / manual — even if rebuildable, the loss is large and
 *             easy to mis-target
 *  - critical irreversible, NO recovery (prod data, tenant wipe)
 */
export interface DestructiveAction {
  /** Command identity, e.g. "mind index delete". */
  action: string;
  /** What is affected, e.g. 'index "code"'. */
  resource: string;
  /** Plain-language effect, e.g. "deletes all vectors + the manifest". */
  effect: string;
  /** Blast-radius tier. */
  severity: DestructiveSeverity;
  /** Whether the data can be recovered afterwards. */
  reversible: boolean;
  /** How to recover, if reversible (e.g. "re-run `kb mind index update --full`"). */
  recovery?: string;
  /** Quantified scope — how much, of what, how broad. */
  blastRadius?: { count?: number; unit?: string; scope?: string };
  /** Flag that confirms the action (default `--yes`). */
  confirmFlag?: string;
}

/** The machine-readable signal an agent receives when confirmation is missing. */
export interface ConfirmationRequired {
  ok: false;
  confirmationRequired: true;
  destructive: true;
  irreversible: boolean;
  severity: DestructiveSeverity;
  action: string;
  resource: string;
  effect: string;
  reversible: boolean;
  blastRadius?: { count?: number; unit?: string; scope?: string };
  recovery?: string;
  confirmWith: string;
  message: string;
}

/**
 * Build the machine-readable signal an agent receives when confirmation is
 * missing in json mode. Exported so a non-CLI surface (REST 409, MCP) can reuse
 * the exact shape instead of re-deriving it.
 */
export function buildConfirmationSignal(a: DestructiveAction): ConfirmationRequired {
  return {
    ok: false,
    confirmationRequired: true,
    destructive: true,
    irreversible: !a.reversible,
    severity: a.severity,
    action: a.action,
    resource: a.resource,
    effect: a.effect,
    reversible: a.reversible,
    ...(a.blastRadius && { blastRadius: a.blastRadius }),
    ...(a.recovery && { recovery: a.recovery }),
    confirmWith: a.confirmFlag ?? '--yes',
    message: renderDestructiveMessage(a),
  };
}

/** Render the one-line warning — leads with the scary part (irreversibility + severity). */
export function renderDestructiveMessage(a: DestructiveAction): string {
  const flag = a.confirmFlag ?? '--yes';
  const br = a.blastRadius;
  const blast = br
    ? ` (${[br.count != null ? `${br.count} ${br.unit ?? 'item(s)'}` : '', br.scope].filter(Boolean).join(' · ')})`
    : '';
  const lead = a.reversible ? `[${a.severity}]` : `⚠ IRREVERSIBLE [${a.severity}]`;
  const rec = a.recovery
    ? ` Recovery: ${a.recovery}.`
    : a.reversible
      ? ''
      : ' No recovery — data is permanently lost.';
  return `${lead} ${a.action} — ${a.effect} on ${a.resource}${blast}.${rec} Confirm with ${flag}.`;
}

/**
 * Gate a destructive command. Returns the command result to return immediately
 * when NOT confirmed (in every mode — agents get the structured signal, not a
 * silent execution), or `null` when confirmed so the caller proceeds.
 *
 *   const blocked = confirmDestructive({ confirmed: flags.yes, action });
 *   if (blocked) return blocked;
 */
export function confirmDestructive(
  opts: { confirmed: boolean; action: DestructiveAction },
): CommandFailure | null {
  if (opts.confirmed) {
    return null;
  }
  const a = opts.action;
  const signal = buildConfirmationSignal(a);
  return {
    ok: false,
    error: {
      code: 'KB_RUNTIME_CONFIRMATION_REQUIRED',
      kind: 'validation',
      message: signal.message,
      hint: 'Verify the target and effect, then rerun the command with --yes.',
      details: {
        action: signal.action,
        resource: signal.resource,
        effect: signal.effect,
        reversible: String(signal.reversible),
        irreversible: String(signal.irreversible),
        severity: signal.severity,
        confirmWith: signal.confirmWith,
        confirmationRequired: String(signal.confirmationRequired),
        destructive: String(signal.destructive),
        ...(signal.blastRadius ? {
          blastRadiusCount: String(signal.blastRadius.count ?? ''),
          blastRadiusUnit: signal.blastRadius.unit ?? '',
          blastRadiusScope: signal.blastRadius.scope ?? '',
        } : {}),
        ...(signal.recovery === undefined ? {} : { recovery: signal.recovery }),
      },
    },
  };
}
