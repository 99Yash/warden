/** `plural(1, "file", "files")` → "1 file"; any other count takes `many`. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
