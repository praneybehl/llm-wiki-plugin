/**
 * Unified line diff (difflib.unified_diff layout, 3 lines of context).
 *
 * Common prefix and suffix lines are trimmed first; the middle runs through
 * Myers O(ND). When the edit distance passes `MAX_EDIT_DISTANCE`, the middle
 * is reported as one replace block, which keeps CPU bounded on large pages.
 */

const CONTEXT = 3;
const MAX_EDIT_DISTANCE = 500;

type Op = { kind: " " | "-" | "+"; line: string };

function splitKeepingEnds(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const out = lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
  if (out.at(-1) === "") out.pop();
  return out;
}

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset, d);
      }
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[x - 1]! });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ kind: "+", line: b[y - 1]! });
      y--;
    } else {
      ops.push({ kind: "-", line: a[x - 1]! });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", line: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

function lineOps(a: string[], b: string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const middle =
    myers(midA, midB) ?? [
      ...midA.map((line): Op => ({ kind: "-", line })),
      ...midB.map((line): Op => ({ kind: "+", line })),
    ];
  return [
    ...a.slice(0, prefix).map((line): Op => ({ kind: " ", line })),
    ...middle,
    ...a.slice(a.length - suffix).map((line): Op => ({ kind: " ", line })),
  ];
}

function range(start: number, length: number): string {
  // difflib: "start,length", start is 1-based; an empty range names the line before it.
  const first = length === 0 ? start : start + 1;
  return length === 1 ? `${first}` : `${first},${length}`;
}

function emit(line: string, kind: string): string {
  return line.endsWith("\n") ? `${kind}${line}` : `${kind}${line}\n\\ No newline at end of file\n`;
}

/** Unified diff of two texts; empty string when they are equal. */
export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string): string {
  if (before === after) return "";
  const ops = lineOps(splitKeepingEnds(before), splitKeepingEnds(after));
  const changes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== " ") changes.push(index);
  });
  if (changes.length === 0) return "";

  // Group changes into hunks with CONTEXT lines around them.
  const hunks: [number, number][] = [];
  let start = Math.max(0, changes[0]! - CONTEXT);
  let end = Math.min(ops.length, changes[0]! + CONTEXT + 1);
  for (const index of changes.slice(1)) {
    if (index - CONTEXT <= end) {
      end = Math.min(ops.length, index + CONTEXT + 1);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, index - CONTEXT);
      end = Math.min(ops.length, index + CONTEXT + 1);
    }
  }
  hunks.push([start, end]);

  // Line numbers before each op.
  const aLine: number[] = [];
  const bLine: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    aLine.push(ai);
    bLine.push(bi);
    if (op.kind !== "+") ai++;
    if (op.kind !== "-") bi++;
  }

  let out = `--- ${fromLabel}\n+++ ${toLabel}\n`;
  for (const [hs, he] of hunks) {
    const slice = ops.slice(hs, he);
    const aCount = slice.filter((op) => op.kind !== "+").length;
    const bCount = slice.filter((op) => op.kind !== "-").length;
    out += `@@ -${range(aLine[hs]!, aCount)} +${range(bLine[hs]!, bCount)} @@\n`;
    for (const op of slice) out += emit(op.line, op.kind);
  }
  return out;
}
