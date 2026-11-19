import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import type { BrowserObservation, BrowserUserAction, TaskBrowserState } from "@ash/shared/task-runtime";
import { bus } from "./bus.js";
import { alive, readAnyPreview } from "./preview-store.js";
import { browserFile, browserFrame, lastBrowser, saveBrowser } from "./task-browser-store.js";
import { browserPath, browserViewport, inspectBrowserPage, operateBrowserPage } from "./task-browser-page.js";

interface LiveBrowser {
  state: TaskBrowserState;
  browser: Browser | null;
  page: Page | null;
  gen: string;
  base: string;
  prefix: string;
  touched: number;
  controlVersion: number;
}

const browsers = new Map<string, LiveBrowser>();
const queues = new Map<string, Promise<unknown>>();
const now = () => new Date().toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function queued<Result>(taskId: string, action: () => Promise<Result>): Promise<Result> {
  const result = (queues.get(taskId) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(taskId, result);
  void result.finally(() => { if (queues.get(taskId) === result) queues.delete(taskId); }).catch(() => {});
  return result;
}

function publish(taskId: string, live: LiveBrowser): void {
  saveBrowser(taskId, live.state);
  bus.publish({ type: "task.review", taskId });
}

function activity(live: LiveBrowser, action: string, error?: string): void {
  live.state.activity = [...live.state.activity, { at: now(), action, ...(error ? { error } : {}) }].slice(-30);
  live.state.updatedAt = now();
}

export function taskBrowserState(taskId: string): TaskBrowserState | null {
  const live = browsers.get(taskId);
  if (live) return live.state;
  const last = lastBrowser(taskId);
  if (last && (last.status === "ready" || last.status === "starting")) return { ...last, status: "closed", error: "共享浏览器会话已结束，最后画面已保留" };
  return last;
}

async function capture(taskId: string, live: LiveBrowser): Promise<void> {
  if (!live.page || live.page.isClosed()) return;
  const frame = await live.page.screenshot({ type: "png", timeout: 8000 });
  const file = browserFile(taskId, "png");
  writeFileSync(`${file}.tmp`, frame);
  renameSync(`${file}.tmp`, file);
  const size = live.page.viewportSize()!;
  Object.assign(live.state, { ...size, url: live.page.url(), title: await live.page.title(), hasFrame: true, revision: live.state.revision + 1, updatedAt: now() });
  saveBrowser(taskId, live.state);
}

async function launch(): Promise<Browser> {
  const errors: string[] = [];
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch { throw new Error("共享浏览器不可用：服务器缺少可选依赖 playwright-core，请重新安装服务器依赖"); }
  const choices = process.env.CHROME_BIN ? [{ executablePath: process.env.CHROME_BIN }] : [{ channel: "chrome" }, { channel: "msedge" }, {}];
  for (const choice of choices) {
    try { return await chromium.launch({ ...choice, headless: true, args: ["--no-proxy-server"] }); }
    catch (error) { errors.push(message(error).split("\n")[0]); }
  }
  throw new Error(`共享浏览器不可用：请安装 Chrome/Chromium，或通过 CHROME_BIN 指定路径。${errors.join("；")}`);
}

async function closeLive(taskId: string, live: LiveBrowser, reason: string): Promise<void> {
  live.state.status = "closed";
  activity(live, reason);
  const browser = live.browser;
  try { await browser?.close(); }
  catch (error) {
    live.state.status = "failed";
    live.state.error = `浏览器关闭失败，可再次停止服务重试：${message(error)}`;
    publish(taskId, live);
    throw error;
  }
  live.browser = null;
  live.page = null;
  if (browsers.get(taskId) === live) browsers.delete(taskId);
  publish(taskId, live);
}

export async function closeTaskBrowser(taskId: string, reason = "浏览器已关闭"): Promise<void> {
  const live = browsers.get(taskId);
  if (live) live.state.control = "user";
  await queued(taskId, async () => { const current = browsers.get(taskId); if (current) await closeLive(taskId, current, reason); });
}

export async function refreshBrowserFrame(taskId: string, browserId: string): Promise<Buffer | null> {
  return queued(taskId, async () => {
    if (taskBrowserState(taskId)?.id !== browserId) return null;
    const live = browsers.get(taskId);
    if (live?.state.status === "ready") {
      live.touched = Date.now();
      try { await capture(taskId, live); }
      catch (error) { live.state.error = message(error); publish(taskId, live); }
    }
    return browserFrame(taskId);
  });
}

export async function taskBrowserAction(taskId: string, input: BrowserUserAction, options: {
  agent: boolean; id?: string; screenshot?: boolean; authorize: () => Promise<void>;
}): Promise<BrowserObservation> {
  const controlVersion = browsers.get(taskId)?.controlVersion;
  if (input.action === "takeover") {
    if (options.agent) throw new Error("只有用户可以接管浏览器");
    await options.authorize();
    const current = browsers.get(taskId);
    if (current && current.state.id === options.id) { current.controlVersion += 1; current.state.control = "user"; publish(taskId, current); }
  }
  return queued(taskId, async () => {
    await options.authorize();
    let live = browsers.get(taskId);
    if (input.action === "open") {
      if (live?.state.status === "ready") {
        if (live.state.control === "user" && options.agent) throw new Error("用户已接管此页面，等待用户交还后再操作");
      } else {
        if (browsers.size >= 4) throw new Error("已有 4 个共享浏览器，请关闭不用的会话后重试");
        const record = readAnyPreview(taskId);
        if (!record?.gen || record.state !== "ready" || !record.url || !alive(record.pid)) throw new Error("请先启动此任务的托管服务，健康检查通过后再打开浏览器");
        const size = browserViewport(input.width ?? 1280, input.height ?? 800);
        live = { gen: record.gen, base: record.url, prefix: "", touched: Date.now(), controlVersion: 0, browser: null, page: null,
          state: { id: randomUUID(), status: "starting", control: options.agent ? "agent" : "user", url: record.url,
            title: "", ...size, revision: 0, updatedAt: now(), hasFrame: false, error: null, activity: [] } };
        browsers.set(taskId, live);
        publish(taskId, live);
        try {
          live.browser = await launch();
          await options.authorize();
          if (readAnyPreview(taskId)?.gen !== live.gen) throw new Error("服务已停止或替换，浏览器启动已取消");
          const context = await live.browser.newContext({ viewport: size, serviceWorkers: "block", acceptDownloads: false });
          await context.route("**/*", async (route) => {
            if (route.request().isNavigationRequest() && new URL(route.request().url()).origin !== new URL(live!.base).origin) {
              activity(live!, "已阻止离开任务服务", route.request().url());
              publish(taskId, live!);
              await route.abort();
            } else await route.continue();
          });
          live.page = await context.newPage();
          live.page.setDefaultTimeout(8000);
          live.page.setDefaultNavigationTimeout(15000);
          context.on("page", (page) => {
            if (page !== live!.page) { void page.close(); activity(live!, "新窗口已阻止，请在当前页导航"); publish(taskId, live!); }
          });
          live.page.on("dialog", (dialog) => { activity(live!, "页面弹窗已取消", dialog.message()); void dialog.dismiss(); publish(taskId, live!); });
          live.page.on("pageerror", (error) => { activity(live!, "页面错误", error.message); publish(taskId, live!); });
          const watched = live;
          live.browser.on("disconnected", () => {
            if (browsers.get(taskId) !== watched || watched.state.status === "closed") return;
            watched.state.status = "failed";
            watched.state.error = "浏览器连接已断开，最后画面已保留";
            browsers.delete(taskId);
            publish(taskId, watched);
          });
          await live.page.goto(browserPath(input.path ?? "/", record.url), { waitUntil: "domcontentloaded" });
          live.state.status = "ready";
        } catch (error) {
          const failed = live;
          failed.state.status = "closed";
          await failed.browser?.close().catch(() => {});
          failed.state.status = "failed";
          failed.state.error = message(error);
          browsers.delete(taskId);
          activity(failed, "打开浏览器失败", failed.state.error);
          publish(taskId, failed);
          throw error;
        }
      }
    }
    if (!live?.page || live.state.status !== "ready") throw new Error("共享浏览器未连接，请重新打开；已保留上次画面与错误");
    if (input.action !== "open" && options.id !== live.state.id) throw new Error("浏览器会话已更换，请刷新后使用当前 id");
    if (options.agent && controlVersion !== undefined && live.controlVersion !== controlVersion) throw new Error("用户接管已取消排队中的操作，请重新 snapshot 后再操作");
    if (readAnyPreview(taskId)?.gen !== live.gen) { await closeLive(taskId, live, "托管服务已停止或替换"); throw new Error("服务已停止，浏览器已关闭"); }
    if (options.agent && (input.action === "release" || input.action === "pointer" || input.action === "type")) throw new Error("此操作只对用户开放；智能体请使用 snapshot 返回的 ref");
    if (options.agent && live.state.control === "user" && input.action !== "snapshot") throw new Error("用户已接管此页面，等待用户交还后再操作");
    if (!options.agent && !["snapshot", "takeover", "release", "close", "open"].includes(input.action) && live.state.control !== "user") throw new Error("请先接管浏览器，避免和智能体同时操作");
    if (input.action === "release") live.state.control = "agent";
    if (input.action === "close") {
      await closeLive(taskId, live, "浏览器已关闭，服务继续运行");
      return { state: live.state, text: "", targets: [] };
    }
    try {
      await operateBrowserPage(live.page, input, live.base, live.prefix);
      live.touched = Date.now();
      live.state.error = null;
      activity(live, input.action);
      live.prefix = randomUUID().slice(0, 8);
      const snapshot = await inspectBrowserPage(live.page, live.prefix);
      await capture(taskId, live);
      publish(taskId, live);
      return { state: live.state, ...snapshot, ...(options.screenshot ? { image: browserFrame(taskId)?.toString("base64") } : {}) };
    } catch (error) {
      live.state.error = message(error);
      activity(live, input.action, live.state.error);
      await capture(taskId, live).catch(() => {});
      publish(taskId, live);
      throw error;
    }
  });
}

const sweep = setInterval(() => {
  for (const [taskId, live] of browsers) if (Date.now() - live.touched > 30 * 60_000 || readAnyPreview(taskId)?.gen !== live.gen) {
    void closeTaskBrowser(taskId, "浏览器空闲超时或托管服务已结束，最后画面已保留").catch(() => {});
  }
}, 60_000);
sweep.unref();
