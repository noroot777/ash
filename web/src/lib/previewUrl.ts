export function browserPreviewUrl(value: string): string {
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);
    if (loopback.has(url.hostname) && !loopback.has(window.location.hostname)) url.hostname = window.location.hostname;
    return url.href;
  } catch { return value; }
}
