// 上下文水位胶囊里的「压缩设置」快捷入口。这一档配置的老问题是**静默失败**：
// 界面上写着「已覆盖 80%」而 CLI 那边压根没收到变量。快捷入口把同一份字段搬到了
// 第二个表面，所以这里盯的正是「两个表面会不会给出不同答案」：
//   ① 只填百分比不许存 —— 跟设置页、跟后端 400 同一句判据（shared/cli-overrides）
//   ② 存下去的 PATCH 打给的是**这条会话的执行器 profile**，body 是那两个数
//   ③ 没有可覆盖项的 CLI（codex）压根不长这个入口
//   ④ 保存后必须说清楚「下一轮生效」——当前这一轮的进程早带着旧环境变量起跑了
//
// 跑法：npm -w web run test:context-compact-quick
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const PROFILE = {
  id: "claude-official",
  name: "claude@官方·opus",
  type: "claude",
  model: "opus-5",
  extraArgs: [],
  providerId: null,
  configOverrides: { autoCompactWindow: 400_000 },
  isDefault: true,
};

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const patches = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes("/api/agents/cli-env")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"maxOutputTokens":null}' });
    }
    if (url.includes("/api/agents/") && request.method() === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}");
      patches.push({ url, body });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...PROFILE, configOverrides: body.configOverrides }),
      });
    }
    if (url.includes("/api/agents")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([PROFILE]) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/context-compact-quick.html`);

  // ③ codex 那颗：面板里只有明细，没有快捷设置。
  await page.locator('[data-testid="codex-chip"] .context-meter-chip').click();
  await page.locator(".token-usage-panel").waitFor();
  assert.equal(await page.locator(".context-compact-toggle").count(), 0, "没有可覆盖项的 CLI 不该出现快捷设置");
  await page.keyboard.press("Escape");

  // claude 那颗：明细照旧，底下多一行「压缩设置」。
  await page.locator('[data-testid="claude-chip"] .context-meter-chip').click();
  const panel = page.locator(".token-usage-panel");
  await panel.waitFor();
  assert.match(await panel.innerText(), /距压缩/, "快捷设置不该挤掉原来的明细");
  await page.locator(".context-compact-toggle").click();

  const windowInput = page.locator(".context-compact-row").nth(0).locator("input");
  const percentInput = page.locator(".context-compact-row").nth(1).locator("input");
  await windowInput.waitFor();
  // 展开时带出的是这个 profile 已存的值，不是空表单。
  assert.equal(await windowInput.inputValue(), "400000", "应回填执行器已存的窗口");
  assert.equal(await percentInput.inputValue(), "", "没配过的项留空 = 跟随 CLI");

  const save = page.locator(".context-compact-save");
  const status = page.locator(".context-compact-actions > span");
  assert.equal(await save.isDisabled(), true, "没改动时不该可保存");

  // ① 只填百分比：跟设置页同一句话拦住，且一个请求都不发。
  await windowInput.fill("");
  await percentInput.fill("80");
  assert.match(await status.innerText(), /要配合/, "只填百分比必须报「要配合窗口一起填」");
  assert.equal(await save.isDisabled(), true, "空转的配置不许存下去");

  // ② 两个数都填齐 → PATCH 打给这条会话的执行器 profile。
  await windowInput.fill("400000");
  assert.match(await status.innerText(), /claude@官方·opus/, "按下去之前要说清楚改的是哪个执行器");
  assert.match(await panel.innerText(), /压缩\(窗口 400k 的/, "要把算出来的触发水位摆在旁边");
  await save.click();

  await page.waitForFunction(() => document.querySelector(".context-compact-actions > span")?.textContent?.includes("已保存"));
  assert.equal(patches.length, 1, `应该只发一次 PATCH：${JSON.stringify(patches)}`);
  assert.match(patches[0].url, /\/api\/agents\/claude-official$/, "改的必须是这条会话记下的那个 profile");
  assert.deepEqual(patches[0].body, { configOverrides: { autoCompactWindow: 400_000, autoCompactPercent: 80 } });
  // ④ 当前这一轮的 CLI 进程早就带着旧环境变量起跑了，不说这句就是在骗人。
  assert.match(await status.innerText(), /下一轮生效/, "保存后必须说明什么时候生效");

  console.log("context compact quick settings test passed");
} finally {
  await browser?.close();
  await server.close();
}
