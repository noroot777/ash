// 来源机器地址完整路径回归：覆盖任务移回失败提示到真实设置页的导航、旧地址预填、
// 核对失败反馈、目标机地址同步，以及刷新后的读回。fixture 模拟设置页所需 API，
// 未识别的 /api 请求会明确失败，不会落到真实后端。跑：npm -w web run test:handoff-source-addresses
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalUrl = "http://192.168.1.51:4317";
const savedUrl = "http://192.168.1.187:4317";
const output = process.env.HANDOFF_SOURCE_SHOT_DIR;
if (output) await mkdir(output, { recursive: true });

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
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const fixture = `http://127.0.0.1:${address.port}/scripts/fixtures/handoff-source-addresses.html`
    + "?project=fixture-project&task=fixture-task";
  await page.goto(fixture);
  await page.evaluate(() => localStorage.removeItem("ash:fixture:handoff-source-address"));
  await page.reload();

  const routeLink = page.getByRole("link", { name: /设置 → 默认规则 → 任务接力 → 来源机器地址/ });
  await routeLink.waitFor();
  assert.match(await page.locator(".handoff-error").innerText(), /连不上来源机器/);
  const href = new URL(await routeLink.getAttribute("href"), page.url());
  assert.equal(href.searchParams.get("project"), "fixture-project", "设置链接应保留项目上下文");
  assert.equal(href.searchParams.get("task"), "fixture-task", "设置链接应保留任务上下文");
  assert.equal(href.searchParams.get("settings"), "defaults");
  assert.equal(href.hash, "#handoff-source-addresses");
  if (output) await page.screenshot({ path: `${output}/handoff-return-link.png`, fullPage: true });

  await routeLink.click();
  await page.waitForURL(/settings=defaults.*#handoff-source-addresses$/);
  assert.equal(new URL(page.url()).searchParams.get("task"), "fixture-task");
  assert.equal(await page.getByRole("heading", { name: "默认规则" }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "任务接力" }).count(), 1);
  const card = page.locator("#handoff-source-addresses");
  await card.waitFor();
  const input = page.getByRole("textbox", { name: "书房 Windows的 ash 地址" });
  await input.waitFor();
  assert.equal(await input.inputValue(), originalUrl, "服务端记录的原地址应预填");
  assert.match(await card.innerText(), /指纹 A1B2-C3D4-E5F6-0718-293A/);
  const targetInput = page.locator(".handoff-target-row input[placeholder='http://192.168.1.50:4317']");
  await targetInput.waitFor();
  assert.equal(await targetInput.inputValue(), originalUrl, "真实父组件应显示同一台接力目标机");

  await input.fill("not-a-url");
  assert.equal(await page.getByRole("button", { name: "核对并保存" }).isDisabled(), true, "非法地址不应提交");

  await input.fill("http://wrong-machine:4317");
  await page.getByRole("button", { name: "核对并保存" }).click();
  const error = page.getByRole("alert");
  await error.waitFor();
  assert.equal(await error.innerText(), "地址背后的机器指纹不一致，未保存");
  assert.equal(await input.inputValue(), "http://wrong-machine:4317", "失败时保留草稿方便修改");
  if (output) await card.screenshot({ path: `${output}/handoff-source-error.png` });

  await input.fill(`${savedUrl}/`);
  await page.getByRole("button", { name: "核对并保存" }).click();
  const status = page.getByRole("status");
  await status.waitFor();
  assert.match(await status.innerText(), /地址已保存，来源机指纹一致/);
  assert.equal(await input.inputValue(), savedUrl, "保存时应移除末尾斜杠");
  assert.equal(await targetInput.inputValue(), savedUrl, "来源地址保存后应同步更新接力目标机器");
  assert.equal(await page.evaluate(() => window.__handoffFixture?.storedUrl()), savedUrl);
  if (output) await page.screenshot({ path: `${output}/handoff-source-saved.png`, fullPage: true });

  await page.reload();
  await input.waitFor();
  assert.equal(await input.inputValue(), savedUrl, "刷新后应从模拟服务端读回新地址");
  const calls = await page.evaluate(() => window.__handoffFixture?.calls ?? []);
  assert.ok(calls.some((call) => call.method === "GET" && call.url === "/api/handoff/targets/sources"));
  assert.deepEqual(await page.evaluate(() => window.__handoffFixture?.unhandled ?? []), []);
  if (output) await page.screenshot({ path: `${output}/handoff-source-refreshed.png`, fullPage: true });

  for (const scenario of ["return", "pending-return", "pending-out"]) {
    await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/handoff-key-identity.html?scenario=${scenario}`);
    const keyInput = page.getByRole("textbox", { name: "你在对端的账号 key" });
    await keyInput.fill("wrong-key");
    await page.getByRole("button", { name: "保存并重新检查" }).click();
    await page.getByText("测试身份核对失败，key 未保存", { exact: true }).waitFor();
    assert.equal(await keyInput.inputValue(), "wrong-key", "身份核对失败保留草稿");
    await keyInput.fill("fixture-key");
    await page.getByRole("button", { name: "保存并重新检查" }).click();
    await page.getByLabel("保存结果").filter({ hasText: `${scenario} 已保存任务指纹 ${"a".repeat(64)}` }).waitFor();
    await page.waitForFunction(() => document.getElementById("handoff-peer-key")?.value === "");
    assert.equal(await keyInput.inputValue(), "", "成功保存清空 key 草稿，合成的任务目标仍可重新检查");
  }
} finally {
  await browser?.close();
  await server.close();
}

console.log("handoff source addresses browser flow ok");
