/**
 * @module @kb-labs/commit/contracts/events
 * Studio event definitions for commit plugin
 */

/**
 * Event names for commit plugin widgets
 */
export const COMMIT_EVENTS = {
  /** Scope selector changed */
  SCOPE_CHANGED: "scope:changed",
  /** Form submitted (actions widget) */
  FORM_SUBMITTED: "form:submitted",
  /** Commit plan generated */
  PLAN_GENERATED: "plan:generated",
} as const;

export type CommitEventName =
  (typeof COMMIT_EVENTS)[keyof typeof COMMIT_EVENTS];

/**
 * Event payload types
 */

/** Payload for scope:changed event */
export interface ScopeChangedPayload {
  /** Selected scope ID */
  scope: string;
}

/** Payload for form:submitted event */
export interface FormSubmittedPayload {
  /** Action ID that was submitted */
  action: string;
  /** Form data (if any) */
  data?: Record<string, unknown>;
}

/** Payload for plan:generated event */
export interface PlanGeneratedPayload {
  /** The generated commit plan */
  plan: {
    commits: Array<{
      type: string;
      scope?: string;
      message: string;
      body?: string;
      files: string[];
    }>;
  };
  /** Scope where plan was generated */
  scope: string;
}

/**
 * Union type for all commit event payloads
 */
export type CommitEventPayload =
  | ScopeChangedPayload
  | FormSubmittedPayload
  | PlanGeneratedPayload;
