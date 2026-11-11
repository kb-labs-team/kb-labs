/**
 * Unified diff generator for file change snapshots.
 * Pure implementation — no external dependencies.
 */

/**
 * Compute longest common subsequence lengths for Myers diff algorithm.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp;
}

type DiffOp = { op: '+' | '-' | ' '; line: string };

/**
 * Compute line-level diff between two texts using LCS.
 */
function lineDiff(oldText: string, newText: string): DiffOp[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];

  // Remove trailing empty line from split if original had no trailing newline
  if (oldLines[oldLines.length - 1] === '') {oldLines.pop();}
  if (newLines[newLines.length - 1] === '') {newLines.pop();}

  const dp = lcsTable(oldLines, newLines);

  const ops: DiffOp[] = [];

  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ op: ' ', line: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ op: '+', line: newLines[j - 1]! });
      j--;
    } else {
      ops.push({ op: '-', line: oldLines[i - 1]! });
      i--;
    }
  }

  ops.reverse();
  return ops;
}

/**
 * Generate a unified diff string from before/after content.
 * Context lines: 3 lines before and after each change hunk.
 */
export function generateUnifiedDiff(
  filePath: string,
  beforeContent: string | undefined,
  afterContent: string,
  operation: 'write' | 'patch' | 'delete'
): string {
  if (operation === 'delete') {
    const lines = (beforeContent ?? '').split('\n');
    if (lines[lines.length - 1] === '') {lines.pop();}
    const header = `--- ${filePath}\t(before)\n+++ /dev/null\t(deleted)\n`;
    const hunk = lines.length > 0
      ? `@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join('\n')}\n`
      : `@@ -0,0 +0,0 @@\n`;
    return header + hunk;
  }

  const oldText = beforeContent ?? '';
  const newText = afterContent;
  const ops = lineDiff(oldText, newText);

  const CONTEXT = 3;
  const header = `--- ${filePath}\t(before)\n+++ ${filePath}\t(after)\n`;

  // Build hunks from ops
  type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] };
  const hunks: Hunk[] = [];

  const oldLine = 1;
  const newLine = 1;

  // Identify change ranges (with context)
  type ChangeRange = { start: number; end: number };
  const changeRanges: ChangeRange[] = [];

  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx]!.op !== ' ') {
      const rangeStart = Math.max(0, idx - CONTEXT);
      const rangeEnd = Math.min(ops.length - 1, idx + CONTEXT);

      if (changeRanges.length > 0 && rangeStart <= changeRanges[changeRanges.length - 1]!.end) {
        changeRanges[changeRanges.length - 1]!.end = rangeEnd;
      } else {
        changeRanges.push({ start: rangeStart, end: rangeEnd });
      }
    }
  }

  // Merge overlapping ranges
  const merged: ChangeRange[] = [];
  for (const r of changeRanges) {
    if (merged.length > 0 && r.start <= merged[merged.length - 1]!.end + 1) {
      merged[merged.length - 1]!.end = Math.max(merged[merged.length - 1]!.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  // Build actual line counters per op
  const opOldLine: number[] = [];
  const opNewLine: number[] = [];
  let ol = 1;
  let nl = 1;
  for (const op of ops) {
    opOldLine.push(ol);
    opNewLine.push(nl);
    if (op.op === ' ' || op.op === '-') {ol++;}
    if (op.op === ' ' || op.op === '+') {nl++;}
  }

  if (merged.length === 0) {
    // No changes
    return header + `@@ -1,${ol - 1} +1,${nl - 1} @@\n` +
      ops.map((o) => ` ${o.line}`).join('\n') + (ops.length > 0 ? '\n' : '');
  }

  for (const range of merged) {
    const slicedOps = ops.slice(range.start, range.end + 1);
    const firstOldLine = opOldLine[range.start] ?? 1;
    const firstNewLine = opNewLine[range.start] ?? 1;

    let oldCount = 0;
    let newCount = 0;
    const hunkLines: string[] = [];
    for (const op of slicedOps) {
      if (op.op === ' ') { oldCount++; newCount++; hunkLines.push(` ${op.line}`); }
      else if (op.op === '-') { oldCount++; hunkLines.push(`-${op.line}`); }
      else { newCount++; hunkLines.push(`+${op.line}`); }
    }

    hunks.push({
      oldStart: firstOldLine,
      oldCount,
      newStart: firstNewLine,
      newCount,
      lines: hunkLines,
    });
  }

  // Silence unused variable warning
  void oldLine;
  void newLine;

  const hunkStr = hunks.map((h) => {
    const header2 = `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;
    return header2 + '\n' + h.lines.join('\n') + '\n';
  }).join('');

  return header + hunkStr;
}

/**
 * Count added and removed lines from a unified diff string.
 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n');
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {added++;}
    if (line.startsWith('-') && !line.startsWith('---')) {removed++;}
  }
  return { added, removed };
}
