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
  await page.route("**/api/events", route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
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
    if (scenario === "running") {
      assert.match(await card.innerText(), /正常现象/);
      assert.match(await card.innerText(), /验收时将跳过自动提交：任务正在运行/);
      assert.doesNotMatch(await card.innerText(), /会先提交|预检通过/);
    }
    if (scenario === "shared") assert.match(await card.innerText(), /共用项目目录/);
  }
  await page.goto(`${fixture}?scenario=outcome`);
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "验收通过", exact: true }).click();
  const outcome = page.getByRole("status", { name: "验收自动提交结果" });
  await outcome.waitFor();
  assert.match(await outcome.innerText(), /已跳过验收前自动提交：此任务共用项目目录/);
  await page.getByTestId("result").filter({ hasText: "已跳过验收前自动提交" }).waitFor();
  assert.match(await page.getByTestId("result").innerText(), /验收通过；已跳过验收前自动提交/);
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
