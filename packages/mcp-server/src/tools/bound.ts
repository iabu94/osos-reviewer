export const MAX_PAYLOAD_CHARS = 12_000;

const FIELD_CAP_STEPS = [1500, 1000, 600, 300, 150, 50, 0] as const;

export function clip(value: string, cap: number): string {
  return value.length > cap ? value.slice(0, cap) : value;
}

/** Bounds an ok-payload array: shrink fields, then drop trailing items (keep ≥1). */
export function boundArray<T>(
  dataKey: string,
  items: T[],
  shrink: (item: T, cap: number) => T,
): T[] {
  const payloadSize = (list: T[]): number =>
    JSON.stringify({ status: "ok", data: { [dataKey]: list } }).length;

  let bounded = items;
  for (const cap of FIELD_CAP_STEPS) {
    if (payloadSize(bounded) < MAX_PAYLOAD_CHARS) return bounded;
    bounded = items.map((item) => shrink(item, cap));
  }
  while (payloadSize(bounded) >= MAX_PAYLOAD_CHARS && bounded.length > 1) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}