export function browserPreviewUrl(value: string, pageUrl = globalThis.location?.href): string {
  if (!pageUrl) return value;
  try {
    const page = new URL(pageUrl);
    const url = new URL(value, page.origin);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);
    if (loopback.has(url.hostname) && !loopback.has(page.hostname)) url.hostname = page.hostname;
    return url.href;
  } catch { return value; }
}

export function previewNoticeText(text: string, pageUrl = globalThis.location?.href): string {
  const gateway = /(^|[\s：:(])(\/api\/tasks\/[A-Za-z0-9_-]{1,80}\/preview\/open\/[A-Za-z0-9_-]{1,64})/g;
  const direct = /(^|[\s：:(（])(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?(?=$|[\s/?#`"'<>()（）。，；！？,;!?])(?:[/?#][^\s`"'<>()（）。，；！？]*)?)/gi;
  const resolve = (_all: string, before: string, address: string) => before + browserPreviewUrl(address, pageUrl);
  return text.replace(gateway, resolve).replace(direct, resolve);
}
