import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  const caseId = `${process.pid}-${Date.now()}`;
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?case=${caseId}`);

  const preview = page.getByRole("textbox", { name: "启动脚本", exact: true });
  const name = page.locator("label", { hasText: "项目名称" }).locator("input");
  const repoPath = page.locator("label", { hasText: "工作目录" }).locator("input");
  const proxy = page.getByRole("combobox", { name: "通过 ash 反向代理访问" });
  const savePreview = page.getByRole("button", { name: "保存预览设置" });
  const scriptMode = page.getByRole("radio", { name: "自定义脚本", exact: true });
  const servicesMode = page.getByRole("radio", { name: "选择服务", exact: true });
  await preview.waitFor();

  assert.equal(await preview.evaluate((node) => node.tagName), "TEXTAREA", "启动脚本应使用多行编辑器");
  await page.getByText("当前使用直连：", { exact: false }).waitFor();
  await page.getByTestId("mode-multi").click();
  await page.getByText("当前使用反代：", { exact: false }).waitFor();
  await proxy.selectOption("off");
  await page.getByText("当前使用直连：", { exact: false }).waitFor();
  await proxy.selectOption("on");
  await page.getByTestId("mode-single").click();
  await page.getByText("当前使用反代：", { exact: false }).waitFor();
  await proxy.selectOption("auto");

  const draft = [
    "cd web",
    "if [ -n \"$PORT\" ]; then",
    "  npm run dev -- --host 0.0.0.0 --port \"$PORT\"",
    "fi",
  ].join("\n");
  await preview.fill(draft);
  await name.fill("改了名字");
  await repoPath.fill("/workspace/改了目录");
  assert.equal(await savePreview.isDisabled(), false, "编辑脚本后应能保存预览设置");

  await page.getByTestId("health-refresh").click();
  await page.getByTestId("health-refresh").click();
  assert.equal(await preview.inputValue(), draft, "同项目重新渲染吞掉了多行脚本草稿");
  assert.equal(await name.inputValue(), "改了名字", "同项目重新渲染吞掉了项目名称草稿");
  assert.equal(await repoPath.inputValue(), "/workspace/改了目录", "同项目重新渲染吞掉了工作目录草稿");

  await servicesMode.check();
  await scriptMode.check();
  assert.equal(await preview.inputValue(), draft, "切换启动方式后多行脚本草稿丢失");
  await servicesMode.check();
  await page.getByRole("button", { name: "检测服务" }).click();
  await page.getByRole("status").waitFor();
  assert.match(await page.getByRole("status").innerText(), /检测到 2 个候选/);

  const webCommand = page.getByRole("textbox", { name: "网页前端 启动脚本" });
  const apiCommand = page.getByRole("textbox", { name: "接口服务 启动脚本" });
  await page.getByRole("checkbox", { name: "启动 网页前端" }).check();
  await page.getByRole("checkbox", { name: "启动 接口服务" }).check();
  const editedWebCommand = [
    "cd web",
    "npm run dev -- --port $PORT",
    "  --strictPort",
  ].join("\n");
  await webCommand.fill(editedWebCommand);
  await apiCommand.fill("cd server\nnpm run dev -- --port $PORT");
  await page.getByTestId("health-refresh").click();
  assert.equal(await webCommand.inputValue(), editedWebCommand, "同项目重新渲染吞掉了服务脚本草稿");
  assert.equal(await page.getByText("已选 2 / 8").isVisible(), true, "检测结果应支持多选");

  await proxy.selectOption("auto");
  await savePreview.click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid=notices]")?.textContent?.includes("预览设置已保存，下次打开预览时生效") ?? false,
  );
  assert.equal(await name.inputValue(), "改了名字", "保存预览设置不应冲掉基本信息草稿");
  assert.equal(await repoPath.inputValue(), "/workspace/改了目录", "保存预览设置不应冲掉目录草稿");

  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `ash-project-settings-fixture:${caseId}`);
  assert.equal(stored["p-one"].previewConfig.mode, "services");
  assert.equal(stored["p-one"].previewConfig.proxy, "auto");
  assert.deepEqual(stored["p-one"].previewConfig.services.map((service) => service.enabled), [true, true]);
  assert.equal(stored["p-one"].previewConfig.primaryServiceId, "web");
  assert.equal(stored["p-one"].previewConfig.services[0].command, editedWebCommand);
  assert.equal(stored["p-one"].previewCommand, draft);

  await page.reload();
  await servicesMode.waitFor();
  assert.equal(await servicesMode.isChecked(), true, "刷新后没有读回已存启动方式");
  assert.equal(await page.getByRole("checkbox", { name: "启动 网页前端" }).isChecked(), true, "刷新后丢了已选服务");
  assert.equal(await page.getByRole("checkbox", { name: "启动 接口服务" }).isChecked(), true, "刷新后丢了第二个已选服务");
  assert.equal(await page.getByRole("textbox", { name: "网页前端 启动脚本" }).inputValue(), editedWebCommand, "刷新后丢了已存服务脚本");
  await scriptMode.check();
  assert.equal(await page.getByRole("textbox", { name: "启动脚本", exact: true }).inputValue(), draft, "刷新后丢了已存总脚本");
  await servicesMode.check();
  await page.getByTestId("mode-multi").click();
  await page.getByText("当前使用反代：", { exact: false }).waitFor();

  if (process.env.SETTINGS_DRAFT_SHOT) await page.screenshot({ path: process.env.SETTINGS_DRAFT_SHOT });

  await page.getByTestId("switch-project").click();
  await page.getByRole("textbox", { name: "启动脚本", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "启动脚本", exact: true }).inputValue(), "", "换项目还留着上一个项目的脚本");
  assert.equal(await repoPath.inputValue(), "/workspace/p-two", "换项目应显示新项目的目录");

  console.log("project settings draft and preview settings: ok");
} finally {
  await browser?.close();
  await server.close();
}
