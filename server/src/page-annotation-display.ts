export function annotationBatchDisplayText(text: string): string | null {
  const value = text.trim();
  if (!value.startsWith("页面批注批次 ") || !value.includes("<preview_page_data")) return null;
  const items: Array<{ number: number; comment: string }> = [];
  let number: number | null = null;
  for (const line of value.split(/\r?\n/)) {
    const heading = /^批注 #(\d+)（/.exec(line);
    if (heading) {
      number = Number(heading[1]);
      continue;
    }
    if (number === null || !line.startsWith("用户意见：")) continue;
    try {
      const comment = JSON.parse(line.slice("用户意见：".length));
      if (typeof comment !== "string") return null;
      items.push({ number, comment });
      number = null;
    } catch {
      return null;
    }
  }
  if (!items.length) return null;
  return [`页面批注 · ${items.length} 条`, ...items.map((item) => `#${item.number} ${item.comment}`)].join("\n");
}
