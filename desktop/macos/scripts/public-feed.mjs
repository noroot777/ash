import { setTimeout as delay } from "node:timers/promises";

export async function readPublicFeed(repo, path, branch, { fetchImpl = fetch, sleep = delay } = {}) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${encoded}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    let text;
    try {
      response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      text = await response.text();
    } catch (error) {
      if (attempt === 2) throw new Error(`读取公开更新源失败：${url}：${error.message}`, { cause: error });
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return { text };
    if (response.status === 404) return null;
    if (attempt === 2 || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`读取公开更新源 ${url} → HTTP ${response.status}：${text.slice(0, 200)}`);
    }
    const retryAfter = Number(response.headers.get("retry-after") ?? NaN);
    await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 10_000) : 1000 * 2 ** attempt);
  }
}
