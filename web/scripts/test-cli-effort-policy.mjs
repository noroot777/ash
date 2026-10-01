// 「CLI 额度」在页面开着的时候被改掉,档位菜单必须当场跟着翻面 —— 两个方向都要。
// 跑法：npm -w web run test:cli-effort-policy
//
// 2026-10-01 第 2 轮审查复现:在设置页把额度从「每人自带 key」改成「共用这台机器的
// CLI 额度」,不刷新页面回到执行器设置,档位菜单仍列着 `ultra`(隔离档的兜底并集),
// 点下去保存返回 HTTP 400「codex 模型 codex-auto-review 不支持思考强度 ultra」,
// 刷新一次才对。服务端那半在第 1 轮已按当前政策翻面,翻不过来的是**已经打开的页面**
// 手里的目录缓存(只按 AgentType 存,额度切换不失效)。
//
// 这条测试走真链路:真 RunTargetPicker 的第三段 + 真 `api.patchSettings`。服务端用
// page.route 顶掉,按「当前额度档」给出两套不同的目录,就像真服务端那样。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const MODEL = "codex-auto-review";
// 共用档:服务端探到了 CLI 的原话。隔离档:一次都不问宿主机 CLI,只给内置快照,
// 档位退回规则表 —— `codex-auto-review` 没有规则命中,于是是 codex 的档位并集(含 ultra)。
const CATALOG = (shared) => [{
  type: "codex",
  models: [MODEL, "gpt-5.6"],
  defaultModel: null,
  source: shared ? "probe" : "preset",
  probeSupported: true,
  available: shared,
  probedAt: shared ? new Date().toISOString() : null,
  cliVersion: null,
  error: null,
  skipped: shared ? null : "多人模式下不问宿主机 CLI",
  ...(shared ? { modelEfforts: { [MODEL]: ["low", "medium", "high", "xhigh", "max"] } } : {}),
}];

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
  const page = await browser.newPage();

  // 服务端替身。`shared` 就是实例设置里那一档,PATCH 改它、GET 目录读它。
  let shared = false;
  const catalogRequests = [];
  // `holdNext` 为真时把下一个目录请求扣在手里(连同它那一刻该给的 body),
  // 留到③里再放 —— 用来模拟「切换前发出的那次请求结算得更晚」。
  let holdNext = false;
  let held = null;
  await page.route("**/api/agents/models**", (route) => {
    const body = JSON.stringify(CATALOG(shared));
    catalogRequests.push(shared ? "shared" : "isolated");
    if (holdNext) {
      holdNext = false;
      held = { route, body };
      return undefined;
    }
    return route.fulfill({ status: 200, contentType: "application/json", body });
  });
  await page.route("**/api/settings", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      const patch = JSON.parse(request.postData() ?? "{}");
      if (typeof patch.sharedHostCli === "boolean") shared = patch.sharedHostCli;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ instanceMode: "multi", sharedHostCli: shared }),
    });
  });
  await page.route("**/api/llm-providers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/cli-effort-policy.html`);

  const effortTrigger = page.getByRole("button", { name: /智能水平：/ });
  const toggle = page.getByTestId("toggle-quota");

  /** 打开档位浮层，读出候选，再收起来。 */
  const effortOptions = async () => {
    await effortTrigger.click();
    const panel = page.getByRole("listbox", { name: "智能水平" });
    await panel.waitFor();
    const names = await panel.getByRole("option").allInnerTexts();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    // 第一条是「跟随执行器」（= 不覆盖），不是档位名。
    return names.map((text) => text.split("\n")[0].trim()).filter((text) => !text.startsWith("跟随"));
  };

  // ── 隔离档:没有探针数据,候选是 codex 的档位并集,含 ultra ──────────────
  await effortTrigger.waitFor();
  const isolated = await effortOptions();
  assert.ok(isolated.includes("ultra"), `隔离档下该列出兜底并集（含 ultra），got: ${isolated.join("/")}`);
  const beforeSwitch = catalogRequests.length;
  assert.ok(beforeSwitch > 0, "挂载时就该取过一次目录");

  // ── 方向 A:隔离 → 共用。不刷新页面 ───────────────────────────────────
  await toggle.click();
  await page.getByTestId("quota-note").filter({ hasText: "共用" }).waitFor();
  // 目录必须被重取（而不是继续用隔离档那份缓存）。
  await page.waitForTimeout(400);
  assert.ok(
    catalogRequests.length > beforeSwitch,
    `额度切换后必须重取目录，实际请求序列：${catalogRequests.join(",")}`,
  );
  const sharedOptions = await effortOptions();
  assert.ok(
    !sharedOptions.includes("ultra"),
    `共用档下 ${MODEL} 只有 low..max，ultra 必须当场消失（无需刷新），got: ${sharedOptions.join("/")}`,
  );
  assert.deepEqual(sharedOptions, ["low", "medium", "high", "xhigh", "max"], `候选应逐条等于 CLI 报的那五档，got: ${sharedOptions.join("/")}`);

  // ── 方向 B:共用 → 隔离 ───────────────────────────────────────────────
  const beforeBack = catalogRequests.length;
  await toggle.click();
  await page.getByTestId("quota-note").filter({ hasText: "隔离" }).waitFor();
  await page.waitForTimeout(400);
  assert.ok(catalogRequests.length > beforeBack, "改回隔离档同样要重取目录");
  const backOptions = await effortOptions();
  assert.ok(
    backOptions.includes("ultra"),
    `改回隔离档后该回到兜底并集，got: ${backOptions.join("/")}`,
  );

  // ── ③ 切换前发出的请求结算得更晚,不许盖回旧政策的答案 ──────────────────
  // 隔离 → 共用,这一次目录请求被扣住(它带的是共用档的答案)。
  holdNext = true;
  await toggle.click();
  await page.getByTestId("quota-note").filter({ hasText: "共用" }).waitFor();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 40 && !held; i += 1) await page.waitForTimeout(50);
  assert.ok(held, "切到共用档时应发出一次目录请求（被测试扣住）");

  // 立刻改回隔离档:这一次正常结算,菜单回到含 ultra 的兜底并集。
  await toggle.click();
  await page.getByTestId("quota-note").filter({ hasText: "隔离" }).waitFor();
  await page.waitForTimeout(400);
  assert.ok((await effortOptions()).includes("ultra"), "改回隔离档后菜单应已是兜底并集");

  // 现在才放那个迟到的「共用档」响应。
  await held.route.fulfill({ status: 200, contentType: "application/json", body: held.body });
  await page.waitForTimeout(500);
  const afterLate = await effortOptions();
  assert.ok(
    afterLate.includes("ultra"),
    `切换前发出的那次请求结算得更晚，不许把菜单盖回旧政策的答案，got: ${afterLate.join("/")}`,
  );

  console.log("cli effort policy switch test passed");
} finally {
  await browser?.close();
  await server.close();
}
