export function parseLastJsonObject(text: string): Record<string, unknown> | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  for (let start = cleaned.lastIndexOf("{"); start >= 0; start = cleaned.lastIndexOf("{", start - 1)) {
    try {
      const value: unknown = JSON.parse(cleaned.slice(start));
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* CLI 有时先输出说明，再输出最终 JSON。 */ }
    if (start === 0) break;
  }
  return undefined;
}
