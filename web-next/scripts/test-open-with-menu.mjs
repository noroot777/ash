// 「打开方式」菜单的交互回归（web-next/src/files/OpenWithMenu.tsx）。
//
// 回归的那个 bug：探测请求放在 effect 里，又拿 loading 当「别重复请求」的守卫并列进
// 依赖数组 —— setLoading(true) 自己触发重跑，cleanup 把在途请求的 alive 置 false，
// 响应回来谁都不写、loading 也不复位，菜单永远停在「正在查本机装了哪些应用…」。
// 后端一切正常（探测 60ms 返回 20 个应用），纯前端把自己饿死，所以只有真点一次才看得见。
//
// 这里断言的是那条完整链路：点开 → 加载态消失 → 至少一个应用项 → 点它真的发出
// POST /file/open 且带对 appId。fixture 用 StrictMode（双跑最容易照出这类写法）。
// 跑：npm -w web-next run test:open-with
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  chromium.executablePath(),
].filter(Boolean);

async function executablePath() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local Chrome/Chromium candidate.
    }
  }
  throw new Error("找不到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定路径");
}

const PROBE = {
  platform: "darwin",
  canReveal: true,
  note: null,
  apps: [
    { id: "/Applications/Visual Studio Code.app", name: "Code", detail: "com.microsoft.VSCode", match: "extension", isDefault: true },
    { id: "/System/Applications/TextEdit.app", name: "TextEdit", detail: "com.apple.TextEdit", match: "type", isDefault: false },
  ],
};

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

  browser = await chromium.launch({ executablePath: await executablePath(), headless: true });
  const page = await browser.newPage();

  const probeCalls = [];
  const openCalls = [];
  await page.route("**/api/tasks/*/file/openers**", async (route) => {
    probeCalls.push(new URL(route.request().url()).searchParams.get("path"));
    // 慢一点，好让「加载态 → 应用清单」这个过渡真的发生过而不是一步到位
    await new Promise((done) => setTimeout(done, 120));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PROBE) });
  });
  await page.route("**/api/tasks/*/file/open", async (route) => {
    openCalls.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, absPath: "/tmp/AGENTS.md" }) });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/open-with-menu.html`);

  const trigger = page.getByRole("button", { name: /打开方式/ });
  await trigger.waitFor();
  assert.equal(await page.getByText("正在查本机装了哪些应用…").count(), 0, "没点开之前不该发起探测");

  await trigger.click();
  const loading = page.getByText("正在查本机装了哪些应用…");
  await loading.waitFor();

  // 这就是回归点：加载态必须能走完，且落到真实的应用清单上
  const codeItem = page.getByRole("menuitem", { name: /Code/ });
  await codeItem.waitFor({ timeout: 5000 });
  assert.equal(await loading.count(), 0, "拿到清单后加载提示必须消失");
  assert.equal(await page.getByRole("menuitem", { name: /TextEdit/ }).count(), 1);
  assert.equal(await page.getByText("支持这种扩展名").count(), 1);
  assert.equal(probeCalls.length, 1, `点一次只该探一次，实际 ${probeCalls.length} 次`);

  await codeItem.click();
  await page.waitForFunction(() => document.querySelector("[data-testid=toast]")?.textContent);
  assert.deepEqual(openCalls, [
    { path: "AGENTS.md", appId: "/Applications/Visual Studio Code.app" },
  ], "点应用要带着它自己的 appId 发出打开请求");
  assert.equal(await page.getByTestId("toast").textContent(), "已用 Code 打开");
  assert.equal(await page.getByRole("menuitem", { name: /Code/ }).count(), 0, "打开后菜单应收起");

  // 复开不该重复探测（清单缓存在组件里）
  await trigger.click();
  await page.getByRole("menuitem", { name: /Code/ }).waitFor();
  assert.equal(probeCalls.length, 1, "同一个文件重开菜单不该再探一次");
  await page.keyboard.press("Escape");

  // 换文件：清单作废，重探一次，并且探的是新路径
  await page.getByRole("button", { name: "换文件" }).click();
  await trigger.click();
  await page.getByRole("menuitem", { name: /Code/ }).waitFor({ timeout: 5000 });
  assert.deepEqual(probeCalls, ["AGENTS.md", "readme.md"], "换文件后要按新路径重探");

  console.log("✓ open-with 菜单：加载态能走完、应用可点、按 appId 发出打开、换文件重探");
} finally {
  await browser?.close();
  await server.close();
}
