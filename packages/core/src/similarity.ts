// Lookalike / impersonation detection. Names are ASCII-only, so the risk is visual confusion
// (0/o, 1/l/i, rn/m, vv/w) and near-miss typos of existing names.

/** Visual skeleton: hyphens dropped, confusables folded. Equal skeleton => visually confusable. */
export function skeleton(label: string): string {
  let s = label.toLowerCase().replace(/-/g, "");
  s = s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
  s = s.replace(/0/g, "o").replace(/[1il]/g, "l").replace(/5/g, "s");
  return s;
}

export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
      rowMin = Math.min(rowMin, dp[j]);
    }
    if (rowMin > max) return max + 1;
  }
  return dp[b.length];
}

export interface Lookalike {
  name: string;
  reason: "confusable" | "near-typo";
}

/** Compare `label` with registered labels. Only flags names that are at least 4 chars to limit noise. */
export function findLookalikes(label: string, existing: Iterable<string>, limit = 5): Lookalike[] {
  const out: Lookalike[] = [];
  const sk = skeleton(label);
  for (const other of existing) {
    if (other === label) continue;
    if (skeleton(other) === sk) {
      out.push({ name: other, reason: "confusable" });
    } else if (label.length >= 5 && other.length >= 5 && editDistance(label, other, 1) <= 1) {
      out.push({ name: other, reason: "near-typo" });
    }
    if (out.length >= limit) break;
  }
  return out;
}
