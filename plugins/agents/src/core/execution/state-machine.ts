export type ExecutionPhase =
  | 'init'
  | 'scoping'
  | 'planning_lite'
  | 'executing'
  | 'converging'
  | 'verifying'
  | 'reporting'
  | 'completed'
  | 'failed';

type PhaseTransition = {
  from: ExecutionPhase;
  to: ExecutionPhase;
  timestamp: string;
  reason?: string;
};

const ALLOWED_TRANSITIONS: Record<ExecutionPhase, ExecutionPhase[]> = {
  init: ['scoping', 'planning_lite', 'executing', 'failed'],
  scoping: ['planning_lite', 'executing', 'failed'],
  planning_lite: ['executing', 'failed'],
  executing: ['converging', 'verifying', 'reporting', 'failed'],
  converging: ['executing', 'verifying', 'reporting', 'failed'],
  verifying: ['reporting', 'failed'],
  reporting: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export class ExecutionStateMachine {
  private current: ExecutionPhase = 'init';
  private transitions: PhaseTransition[] = [];
  private enteredAt = new Map<ExecutionPhase, number>([['init', Date.now()]]);
  private durationsMs = new Map<ExecutionPhase, number>();

  getCurrent(): ExecutionPhase {
    return this.current;
  }

  getTransitions(): PhaseTransition[] {
    return [...this.transitions];
  }

  transition(to: ExecutionPhase, reason?: string): void {
    if (to === this.current) {
      return;
    }

    const allowed = ALLOWED_TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid state transition: ${this.current} -> ${to}`);
    }

    const now = Date.now();
    const entered = this.enteredAt.get(this.current);
    if (entered != null) {
      const elapsed = now - entered;
      this.durationsMs.set(this.current, (this.durationsMs.get(this.current) ?? 0) + elapsed);
    }

    this.transitions.push({
      from: this.current,
      to,
      timestamp: new Date(now).toISOString(),
      reason,
    });

    this.current = to;
    this.enteredAt.set(to, now);
  }

  getPhaseDurationsMs(now = Date.now()): Record<ExecutionPhase, number> {
    const out: Record<ExecutionPhase, number> = {
      init: this.durationsMs.get('init') ?? 0,
      scoping: this.durationsMs.get('scoping') ?? 0,
      planning_lite: this.durationsMs.get('planning_lite') ?? 0,
      executing: this.durationsMs.get('executing') ?? 0,
      converging: this.durationsMs.get('converging') ?? 0,
      verifying: this.durationsMs.get('verifying') ?? 0,
      reporting: this.durationsMs.get('reporting') ?? 0,
      completed: this.durationsMs.get('completed') ?? 0,
      failed: this.durationsMs.get('failed') ?? 0,
    };

    const entered = this.enteredAt.get(this.current);
    if (entered != null) {
      out[this.current] += now - entered;
    }

    return out;
  }
}

