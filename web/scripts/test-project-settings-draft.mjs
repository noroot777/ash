// 项目设置里正在编辑的草稿不能被后台刷新静默吞掉。跑：npm -w web run test:project-settings-draft
//
// 钉的是一次真实事故的反面：预览命令这个框刚加上，用户输到一半，界面自己把它清空了，
// 保存按钮跟着变灰，没有任何提示 —— 看上去就是「这个框坏了」。真凶不在这个框上，在
// 面板顶上那颗 `useEffect(..., [project])`：WorkspaceShell 收到项目健康结果会
// `{ ...project, health }` 换一个新对象，**内容一个字没变、身份变了**，于是三个框全被
// 重置回服务端的值。那个请求进页面时发一次，之后每有任务结算还会再发，所以它不是
// 「首次进入」的一次性问题，是编辑期间随时会来一下。
//
// 两条判据必须同时成立，少一条这颗 effect 就又会被人改回去：
//   ① 同一个项目换对象身份 → 草稿留着（名称、目录、预览命令三个都算）
//   ② project.id 变了 → 草稿冲掉（那已经是另一个项目的设置了）
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html`);

  const preview = page.locator("label", { hasText: "「打开预览」跑哪条命令" }).locator("input");
  const name = page.locator("label", { hasText: "项目名称" }).locator("input");
  const repoPath = page.locator("label", { hasText: "工作目录" }).locator("input");
  await preview.waitFor();

  const help = page.getByRole("button", { name: "配置说明与示例" });
  const dialog = page.getByRole("dialog", { name: "预览命令说明" });
  const previewSection = page.locator(".settings-section").filter({ has: help });
  assert.equal(await help.isVisible(), true, "配置说明需要有明确的按钮入口");
  assert.equal(await help.getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByText("自动识别启动命令", { exact: true }).count(), 0, "详细说明不应默认铺在页面上");
  assert.ok((await previewSection.boundingBox()).height < 250, "收起后的预览配置应保持紧凑");
  if (process.env.SETTINGS_HELP_CLOSED_SHOT) await previewSection.screenshot({ path: process.env.SETTINGS_HELP_CLOSED_SHOT, animations: "disabled" });

  // ① 编辑三个框，然后来一次健康刷新。
  const DRAFT = "cd a4sms-front && pnpm run dev -- --port $PORT";
  await preview.fill(DRAFT);
  await name.fill("改了名字");
  await repoPath.fill("/workspace/改了目录");
  const save = page.getByRole("button", { name: "保存预览命令" });
  assert.equal(await save.isDisabled(), false, "输了字之后保存按钮应该是可按的");

  await help.click();
  await dialog.waitFor();
  assert.equal(await help.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await dialog.getByRole("heading", { level: 3 }).allTextContents(), [
    "自动识别启动命令", "命令在哪里执行", "预览端口与服务地址", "同时启动前后端", "把端口传给运行时", "启动失败时排查",
  ]);
  const commandExample = await dialog.locator("pre").innerText();
  assert.ok(commandExample.includes("SERVER_PORT=$PORT2"));
  assert.ok(commandExample.includes("VITE_APP_API_URL=$URL2"));
  assert.ok(commandExample.endsWith("--port $PORT"));
  const closeHelp = dialog.getByRole("button", { name: "关闭预览命令说明" });
  const acknowledge = dialog.getByRole("button", { name: "知道了" });
  assert.equal(await closeHelp.evaluate((node) => node === document.activeElement), true, "打开说明后焦点应进入弹窗");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await acknowledge.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await closeHelp.evaluate((node) => node === document.activeElement), true, "Tab 不应进入弹窗背后的输入框");
  if (process.env.SETTINGS_HELP_OPEN_SHOT) await page.screenshot({ path: process.env.SETTINGS_HELP_OPEN_SHOT, animations: "disabled" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await help.evaluate((node) => node === document.activeElement), true, "关闭后焦点应回到说明按钮");
  assert.equal(await preview.inputValue(), DRAFT, "查看说明不能改变未保存的命令");

  await help.click();
  await closeHelp.click();
  await dialog.waitFor({ state: "detached" });
  await help.click();
  await acknowledge.click();
  await dialog.waitFor({ state: "detached" });
  await help.click();
  await page.locator(".task-modal-scrim").dispatchEvent("pointerdown");
  await dialog.waitFor({ state: "detached" });

  await page.setViewportSize({ width: 390, height: 740 });
  await help.click();
  await dialog.waitFor();
  const narrowDialog = await dialog.boundingBox();
  assert.ok(narrowDialog.x >= 0 && narrowDialog.x + narrowDialog.width <= 390, "窄屏弹窗不能横向溢出");
  assert.ok(narrowDialog.y >= 0 && narrowDialog.y + narrowDialog.height <= 740, "窄屏弹窗不能超出视口");
  const content = dialog.getByRole("region", { name: "配置说明内容" });
  assert.equal(await content.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "长命令需要在窄屏换行");
  assert.equal(await content.evaluate((node) => node.scrollHeight > node.clientHeight), true, "长说明应在弹窗内部滚动");
  if (process.env.SETTINGS_HELP_NARROW_SHOT) await page.screenshot({ path: process.env.SETTINGS_HELP_NARROW_SHOT, animations: "disabled" });
  await dialog.getByRole("heading", { name: "启动失败时排查" }).scrollIntoViewIfNeeded();
  const acknowledgeBox = await acknowledge.boundingBox();
  assert.ok(acknowledgeBox.y >= 0 && acknowledgeBox.y + acknowledgeBox.height <= 740, "滚动说明时关闭按钮应保持可见");
  await acknowledge.click();
  await dialog.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1000, height: 1200 });

  await page.getByTestId("health-refresh").click();
  // 刷新是同步 setState，等一帧就够；用 waitForFunction 而不是 sleep，免得把时序写进测试。
  await page.waitForFunction(() => document.querySelectorAll("input").length > 0);
  assert.equal(await preview.inputValue(), DRAFT, "健康刷新把用户正在输的预览命令吞了");
  assert.equal(await name.inputValue(), "改了名字", "健康刷新把项目名称的草稿吞了");
  assert.equal(await repoPath.inputValue(), "/workspace/改了目录", "健康刷新把工作目录的草稿吞了");
  assert.equal(await save.isDisabled(), false, "草稿还在，保存按钮不该变灰");

  // 连来几次也一样 —— 现场里它是跟着任务结算反复发的。
  await page.getByTestId("health-refresh").click();
  await page.getByTestId("health-refresh").click();
  assert.equal(await preview.inputValue(), DRAFT, "连续刷新之后草稿仍要在");

  if (process.env.SETTINGS_DRAFT_SHOT) await page.screenshot({ path: process.env.SETTINGS_DRAFT_SHOT });

  // ② 换成另一个项目：这时候必须重置，否则会把上一个项目的设置写到这一个头上。
  await page.getByTestId("switch-project").click();
  await page.waitForFunction(() => {
    const box = [...document.querySelectorAll("label")]
      .find((l) => l.querySelector("span")?.textContent === "项目名称")?.querySelector("input");
    return box?.value === "第二个项目";
  });
  assert.equal(await preview.inputValue(), "", "换了项目还留着上一个的预览命令草稿");
  assert.equal(await repoPath.inputValue(), "/workspace/p-two", "换了项目要显示新项目的目录");

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?member`);
  await help.waitFor();
  assert.equal(await preview.getAttribute("readonly"), "");
  assert.equal(await save.count(), 0, "成员不能保存预览命令");
  await help.click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("heading", { name: "自动识别启动命令" }).isVisible(), true, "只读成员也能查看说明");
  await acknowledge.click();
  assert.deepEqual(errors, [], "项目设置页不应产生运行时异常");

  console.log("project settings draft + preview help: ok (collapsed, dialog, keyboard, dismissal, narrow screen, read-only)");
} finally {
  await browser?.close();
  await server.close();
}
