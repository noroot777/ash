// HTTP CSP is owned by the proxy; a second policy in HTML would intersect it and block the bridge.
export function neutralizePreviewMetaCsp(html: string): string {
  const decode = (value: string) => value.replace(/&#(x[\da-f]+|\d+);?|&(Tab|NewLine);/gi, (_all, code: string | undefined, named: string) => {
    if (!code) return named.toLowerCase() === "tab" ? "\t" : "\n";
    const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
  });
  return html.replace(/<!--[\s\S]*?-->|<(script|style|textarea|title|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>|<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    if (!/^<meta\b/i.test(tag)) return tag;
    const attributes = tag.slice(5).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g);
    for (const attribute of attributes) {
      if (attribute[1].toLowerCase() !== "http-equiv") continue;
      const value = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim().toLowerCase();
      return value === "content-security-policy" || value === "content-security-policy-report-only" ? "" : tag;
    }
    return tag;
  });
}
