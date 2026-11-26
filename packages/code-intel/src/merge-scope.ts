import type { CodeSymbolRecord } from "@osos-reviewer/shared";

function symbolKey(row: CodeSymbolRecord): string {
  return `${row.repo}\0${row.filePath}\0${row.symbolName}`;
}

/** Merge duplicate symbols, preferring PR-indexed rows over baseline. */
export function mergePreferPr(symbols: CodeSymbolRecord[]): CodeSymbolRecord[] {
  const groups = new Map<string, CodeSymbolRecord[]>();
  for (const row of symbols) {
    const key = symbolKey(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const out: CodeSymbolRecord[] = [];
  for (const rows of groups.values()) {
    const pr = rows.find((r) => r.indexScope === "pr");
    out.push(pr ?? rows.find((r) => r.indexScope === "baseline") ?? rows[0]);
  }
  return out;
}