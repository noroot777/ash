// 三段胶囊选完执行器再选模型时，智能体不许被同一轮的第二次回调打回原样。
// 2026-08-13：派审查里选 grok、选了 grok-4.5，胶囊却弹回 codex@local。
// 跑法：npm -w web-next run test:executor-picker-field
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
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  await page.route("**/api/llm-providers", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/executor-picker-field.html`);

  const agentTrigger = page.getByRole("button", { name: /智能体：/ });
  const modelTrigger = page.getByRole("button", { name: /模型：/ });
  const draft = page.getByTestId("draft");

  await agentTrigger.waitFor();
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：codex/);

  // 换智能体：这一步就得落住，模型/智能水平打回「跟随执行器」。
  await agentTrigger.click();
  await page.getByRole("option", { name: /@grok/ }).click();
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：grok/);
  assert.match(await modelTrigger.getAttribute("aria-label") ?? "", /模型：跟随执行器/);

  // 接着在自动展开的模型段里选一个模型：智能体必须还是 grok。
  await page.getByPlaceholder("筛选 grok 的模型…").waitFor();
  await page.getByRole("option", { name: /^grok-4\.5/ }).click();
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：grok/);
  assert.match(await modelTrigger.getAttribute("aria-label") ?? "", /模型：grok-4\.5/);

  const state = JSON.parse(await draft.textContent() ?? "{}");
  assert.equal(state.target, "grok-local", "草稿里存的应是 grok 的执行器");
  assert.equal(state.model, "grok-4.5");
  assert.equal(state.effort, "", "换了执行器，智能水平应回到跟随执行器");

  // 只改智能水平不该顺手动执行器或模型（模型选定后第三段已自动展开）。
  await page.getByRole("listbox", { name: "智能水平" }).waitFor();
  await page.getByRole("option", { name: /^high/ }).click();
  const after = JSON.parse(await draft.textContent() ?? "{}");
  assert.deepEqual(
    [after.target, after.model, after.effort],
    ["grok-local", "grok-4.5", "high"],
  );

  console.log("executor picker field test passed");
} finally {
  await browser?.close();
  await server.close();
}
