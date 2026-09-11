import type { PreviewPageImage } from "@ash/shared/page-annotation";
import { readPreview } from "./preview-store.js";

const unavailable = (reason: string): PreviewPageImage => ({ capturedAt: Date.now(), missing: ["非用户现场；无用户登录态、输入或交互状态", reason] });
const active = new Set<string>();

export async function captureAnnotationReference(taskId: string, input: {
  gen?: string; serviceId?: string; route?: string; viewport?: { width?: number; height?: number }; scroll?: { x?: number; y?: number };
}): Promise<PreviewPageImage> {
  if (!input || active.has(taskId) || active.size >= 2) return unavailable("参考渲染繁忙，本条跳过；发送不受影响");
  const record = readPreview(taskId);
  const service = record?.services?.find((entry) => entry.id === input.serviceId && entry.status === "ready");
  if (!record || !input.gen || record.gen !== input.gen || !service?.port) return unavailable("预览已切换或服务不可用");
  if (typeof input.route !== "string" || !input.route.startsWith("/") || input.route.startsWith("//") || /[\\\r\n]/.test(input.route)) return unavailable("路由无效");
  const origin = `http://127.0.0.1:${service.port}`;
  const target = new URL(input.route, origin);
  if (target.origin !== origin) return unavailable("路由越界");
  active.add(taskId);
  let browser: import("playwright-core").Browser | undefined;
  const deadline = setTimeout(() => { void browser?.close().catch(() => {}); }, 15_000);
  try {
    // playwright-core has no browser download; an absent package/executable degrades to the other evidence sources.
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, timeout: 5000, ...(process.env.ASH_ANNOTATION_BROWSER ? { executablePath: process.env.ASH_ANNOTATION_BROWSER } : {}) });
    const size = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(1, Math.min(1920, value))) : fallback;
    const context = await browser.newContext({ viewport: { width: size(input.viewport?.width, 1280), height: size(input.viewport?.height, 800) }, serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === origin ? route.continue() : route.abort();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 5000 });
    const coord = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1e6, n)) : 0;
    await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: coord(input.scroll?.x), y: coord(input.scroll?.y) });
    const capturedAt = Date.now();
    const png = await page.screenshot({ timeout: 3000 });
    if (png.length > 2_000_000) return unavailable("参考图过大，本条跳过");
    return { capturedAt, dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      missing: ["非用户现场；独立临时浏览器，无用户登录凭证、输入或交互状态", "仅允许预览服务同源资源；外部图片与字体可能缺失", "服务端渲染时刻与标注创建时刻不同"] };
  } catch {
    return unavailable("未安装可用的无头浏览器，或参考渲染失败/超时；可粘贴现场截图");
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => {});
    active.delete(taskId);
  }
}
