import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/page-interactions.html`;
  const card = page.getByRole("status", { name: "未提交改动" });
  const submit = card.getByRole("button", { name: "一键提交改动" });
  for (const scenario of ["running", "disabled", "shared"]) {
    await page.goto(`${fixture}?scenario=${scenario}`);
    await submit.waitFor();
    assert.equal(await submit.isDisabled(), true, scenario);
    assert.equal(await card.locator(".is-spinning").count(), 0, "禁用不是正在提交");
    assert.equal(await card.getByRole("button", { name: "刷新未提交改动" }).isEnabled(), true);
    assert.doesNotMatch(await card.innerText(), /提交中…/);
    if (scenario === "running") assert.match(await card.innerText(), /正常现象/);
    if (scenario === "shared") assert.match(await card.innerText(), /共用项目目录/);
  }
  await page.clock.install();
  await page.goto(`${fixture}?scenario=failure`);
  await submit.waitFor();
  await submit.click();
  await card.getByRole("alert").waitFor();
  assert.match(await card.getByRole("alert").innerText(), /配置 Git 用户信息/);
  await page.evaluate(() => {
    const original = window.fetch;
    window.scmPolls = 0;
    window.fetch = async (...args) => {
      if (String(args[0]).endsWith("/tasks/demo/scm")) window.scmPolls += 1;
      return original(...args);
    };
  });
  await page.clock.fastForward(15_001);
  await page.waitForFunction(() => window.scmPolls > 0);
  assert.match(await card.getByRole("alert").innerText(), /配置 Git 用户信息/, "成功轮询不能清除提交失败原因");
  await card.getByRole("button", { name: "刷新未提交改动" }).click();
  await page.waitForFunction(() => window.scmPolls > 1);
  assert.match(await card.getByRole("alert").innerText(), /配置 Git 用户信息/);
  await submit.click();
  await page.getByTestId("result").filter({ hasText: "任务改动已提交" }).waitFor();
  await card.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("alert").count(), 0, "成功重试后清除提交错误");
  assert.deepEqual(errors, []);
  console.log("acceptance workspace DOM: shared scope, disabled vs busy, persistent failure across polling and successful retry passed");
} finally {
  await browser?.close();
  await server.close();
}
