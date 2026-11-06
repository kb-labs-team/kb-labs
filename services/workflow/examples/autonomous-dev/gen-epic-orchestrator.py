#!/usr/bin/env python3
"""L2 fan-out generator.

Reads a tech-lead decomposition (JSON with tickets[].{id,depends_on}) and emits
an epic-orchestrator workflow: one job per ticket whose shell step triggers a
child run (`kb workflow run`) and waits for it, with `needs:` encoding the
dependency DAG. Independent tickets run in parallel (engine schedules ready jobs
concurrently); each child run gets its own isolated worktree.

Usage: python3 gen-epic-orchestrator.py <decomp.json> <child-workflow-id> > epic-orchestrator.yml
"""
import sys, json, re

decomp_path, child_id = sys.argv[1], sys.argv[2]
with open(decomp_path) as f:
    decomp = json.load(f)
tickets = decomp["tickets"]


def jobkey(tid: str) -> str:
    # job keys: keep alnum + hyphen, lowercased for safety
    return re.sub(r"[^a-zA-Z0-9_-]", "-", tid).lower()


lines = [
    "# L2 epic-orchestrator — GENERATED from tech-lead decomposition.",
    f"# Fans out {len(tickets)} tickets to child workflow '{child_id}', one job each,",
    "# `needs:` encoding the dependency DAG. Independent jobs run in parallel.",
    f"name: epic-orchestrator",
    "version: 0.1.0",
    f"description: Fan-out {len(tickets)} tickets to {child_id} (DAG-ordered)",
    "on:",
    "  manual: true",
    "",
    "jobs:",
]

for t in tickets:
    tid = t["id"]
    jk = jobkey(tid)
    deps = [jobkey(d) for d in (t.get("depends_on") or [])]
    lines.append(f"  {jk}:")
    lines.append(f"    runsOn: local")
    if deps:
        lines.append(f"    needs: [{', '.join(deps)}]")
    lines.append(f"    steps:")
    lines.append(f"      - name: L3 run for {tid}")
    lines.append(f"        timeoutMs: 600000")
    lines.append(f"        run: |")
    # NB: child input task_id carries the ticket id; swap child_id for a real L3.
    body = f'''          RID=$(kb workflow run --workflow-id {child_id} --input '{{"task_id":"{tid}"}}' --json 2>/dev/null | grep '^{{' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['runId'])")
          echo "{tid} -> child run $RID"
          ST=""
          for i in $(seq 1 120); do
            ST=$(kb workflow runs status "$RID" --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['status'])" 2>/dev/null)
            [ "$ST" = "success" ] && break
            [ "$ST" = "failed" ] && {{ echo "{tid} child FAILED"; exit 1; }}
            sleep 3
          done
          [ "$ST" = "success" ] || {{ echo "{tid} timed out (last=$ST)"; exit 1; }}
          echo "{tid} child $RID succeeded"'''
    lines.append(body)
    lines.append("")

sys.stdout.write("\n".join(lines) + "\n")
