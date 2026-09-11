import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";
import { testPreviewCommandEditor } from "./preview-command-editor-checks.mjs";

const editorText = async (editor) => editor.locator(".cm-line").evaluateAll((lines) => lines.map((line) => line.querySelector(".cm-placeholder") ? "" : line.textContent).join("\n"));

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
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const caseId = `${process.pid}-${Date.now()}`;
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?case=${caseId}`);

  const preview = page.getByRole("textbox", { name: "启动脚本", exact: true });
  const name = page.locator("label", { hasText: "项目名称" }).locator("input");
  const repoPath = page.locator("label", { hasText: "工作目录" }).locator("input");
  const proxy = page.getByRole("combobox", { name: "通过 ash 反向代理访问" });
  const savePreview = page.getByRole("button", { name: "保存预览设置" });
  const scriptMode = page.getByRole("radio", { name: "自定义脚本", exact: true });
  const servicesMode = page.getByRole("radio", { name: "选择服务", exact: true });
  const waitForPreviewMode = (mode) => page.waitForFunction((expected) => {
    const radios = document.querySelectorAll('input[type="radio"][name^="preview-mode-"]');
    const selected = radios[expected === "script" ? 0 : 1];
    return selected instanceof HTMLInputElement && selected.checked
      && (expected === "script"
        ? document.querySelector('.cm-content[aria-label="启动脚本"]') !== null
        : document.querySelector(".preview-detect-actions") !== null);
  }, mode);
  await preview.waitFor();

  assert.equal(await preview.getAttribute("aria-multiline"), "true", "启动脚本应使用多行代码编辑器");
  await page.getByText("当前使用直连：", { exact: false }).waitFor();
  await page.getByTestId("mode-multi").click();
  await page.getByText("当前使用反代：", { exact: false }).waitFor();
  await proxy.selectOption("off");
  await page.getByText("当前使用直连：", { exact: false }).waitFor();
  await proxy.selectOption("on");
  await page.getByTestId("mode-single").click();
  await page.getByText("当前使用反代：", { exact: false }).waitFor();
  await proxy.selectOption("auto");
  await testPreviewCommandEditor(page, preview, savePreview);

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
  const help = page.getByRole("button", { name: "配置说明与示例", includeHidden: true });
  const dialog = page.getByRole("dialog", { name: "预览命令说明" });
  const previewSection = page.locator(".settings-section").filter({ has: help });
  assert.equal(await help.isVisible(), true, "配置说明需要有明确的按钮入口");
  assert.equal(await help.getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByText("自动识别启动命令", { exact: true }).count(), 0, "详细说明不应默认铺在页面上");
  assert.equal(await previewSection.locator(".preview-command-help-content").count(), 0, "详细说明只在弹窗打开后渲染");
  if (process.env.SETTINGS_HELP_CLOSED_SHOT) await previewSection.screenshot({ path: process.env.SETTINGS_HELP_CLOSED_SHOT, animations: "disabled" });

  const addInertBackground = async () => page.evaluate(() => {
    const background = document.createElement("aside");
    background.inert = true;
    background.dataset.testid = "already-inert";
    document.body.append(background);
  });
  await addInertBackground();

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
  assert.equal(await page.locator("#root").evaluate((node) => node.inert), true, "模态弹窗的背景必须不可交互");
  const accessibility = await page.context().newCDPSession(page);
  const accessibilityTree = await accessibility.send("Accessibility.getFullAXTree");
  assert.equal(accessibilityTree.nodes.some((node) => !node.ignored && node.role?.value === "button" && node.name?.value === "删除项目"), false, "背景删除按钮不能出现在可访问性树中");
  await accessibility.detach();
  assert.equal(await closeHelp.evaluate((node) => node === document.activeElement), true, "打开说明后焦点应进入弹窗");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await acknowledge.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await closeHelp.evaluate((node) => node === document.activeElement), true, "Tab 不应进入弹窗背后的输入框");
  await dialog.getByRole("heading", { name: "预览命令说明", exact: true }).click();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, "点击不可聚焦的标题后，Shift+Tab 不能逃到背景的删除项目按钮");
  await page.keyboard.press("Enter");
  assert.equal(await page.getByRole("dialog", { name: "删除项目", exact: true }).count(), 0, "说明弹窗中的回车不能触发背景删除操作");
  if (!await dialog.count()) await help.click();
  for (const target of [dialog.locator("header small"), dialog.locator("header > span"), dialog.locator("footer")]) {
    await target.click();
    for (const direction of ["Shift+Tab", "Tab"]) {
      for (let step = 0; step < 5; step += 1) {
        await page.keyboard.press(direction);
        assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, "点击标题区或页脚空白后，正反向 Tab 都必须留在弹窗内");
      }
    }
  }
  await page.getByRole("button", { name: "删除项目", exact: true, includeHidden: true }).evaluate((node) => node.focus());
  assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, "背景控件也不能被程序化聚焦");
  assert.ok((await dialog.boundingBox()).height > 860, "大屏弹窗应利用可用高度，而不是固定截断在 860px");
  if (process.env.SETTINGS_HELP_OPEN_SHOT) await page.screenshot({ path: process.env.SETTINGS_HELP_OPEN_SHOT, animations: "disabled" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await help.evaluate((node) => node === document.activeElement), true, "关闭后焦点应回到说明按钮");
  assert.equal(await page.locator("#root").evaluate((node) => node.inert), false, "关闭后背景必须恢复可交互");
  assert.equal(await page.getByTestId("already-inert").evaluate((node) => node.inert), true, "不能清掉背景原本已有的 inert 状态");
  assert.equal(await editorText(preview), draft, "查看说明不能改变未保存的命令");

  await help.click();
  await dialog.locator("pre code").evaluate((node) => {
    const text = node.textContent;
    const start = document.createElement("span");
    start.dataset.testid = "command-selection-start";
    start.textContent = text.slice(0, 8);
    const end = document.createElement("span");
    end.dataset.testid = "command-selection-end";
    end.textContent = text.slice(-8);
    node.replaceChildren(start, document.createTextNode(text.slice(8, -8)), end);
  });
  await page.locator(".task-modal-scrim").evaluate((node) => {
    const outside = document.createElement("span");
    outside.dataset.testid = "command-selection-outside";
    Object.assign(outside.style, { position: "absolute", right: "0", bottom: "0", width: "12px", height: "12px" });
    node.append(outside);
  });
  await page.getByTestId("command-selection-start").hover();
  await page.mouse.down();
  await page.getByTestId("command-selection-end").hover();
  assert.ok(await page.evaluate(() => window.getSelection()?.toString().includes("SERVER_PORT=$PORT2")), "探针应真实拖选到示例命令");
  await page.getByTestId("command-selection-outside").hover();
  await page.mouse.up();
  assert.equal(await dialog.isVisible(), true, "拖选命令并在遮罩上松手不能关闭说明");
  assert.ok(await page.evaluate(() => window.getSelection()?.toString().includes("SERVER_PORT=$PORT2")), "拖选出界后必须保留可复制的命令选区");
  if (process.env.SETTINGS_HELP_DRAG_SHOT) await page.screenshot({ path: process.env.SETTINGS_HELP_DRAG_SHOT, animations: "disabled" });
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await closeHelp.click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.locator("#root").evaluate((node) => node.inert), false, "点击遮罩关闭后必须恢复背景");

  await page.setViewportSize({ width: 1000, height: 1600 });
  await help.click();
  await page.waitForFunction(() => {
    const region = document.querySelector(".preview-command-help-content");
    return region && region.scrollHeight <= region.clientHeight;
  });
  assert.equal(await dialog.getByText("向下滚动查看完整说明").count(), 0, "无需滚动时不应显示滚动提示");
  if (process.env.SETTINGS_HELP_TALL_SHOT) await page.screenshot({ path: process.env.SETTINGS_HELP_TALL_SHOT, animations: "disabled" });
  await closeHelp.click();
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
  await dialog.getByText("向下滚动查看完整说明").waitFor();
  assert.equal(await content.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "长命令需要在窄屏换行");
  assert.equal(await content.evaluate((node) => node.scrollHeight > node.clientHeight), true, "长说明应在弹窗内部滚动");
  if (process.env.SETTINGS_HELP_NARROW_SHOT) await page.screenshot({ path: process.env.SETTINGS_HELP_NARROW_SHOT, animations: "disabled" });
  await dialog.getByRole("heading", { name: "启动失败时排查" }).scrollIntoViewIfNeeded();
  await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await dialog.getByText("向下滚动查看完整说明").waitFor({ state: "detached" });
  assert.equal(await content.getAttribute("data-more-below"), null, "滚到底后应去掉遮挡末行的渐隐");
  const acknowledgeBox = await acknowledge.boundingBox();
  assert.ok(acknowledgeBox.y >= 0 && acknowledgeBox.y + acknowledgeBox.height <= 740, "滚动说明时关闭按钮应保持可见");
  await acknowledge.click();
  await dialog.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1000, height: 1200 });

  await page.getByTestId("health-refresh").click();
  await page.getByTestId("health-refresh").click();
  assert.equal(await editorText(preview), draft, "同项目重新渲染吞掉了多行脚本草稿");
  assert.equal(await name.inputValue(), "改了名字", "同项目重新渲染吞掉了项目名称草稿");
  assert.equal(await repoPath.inputValue(), "/workspace/改了目录", "同项目重新渲染吞掉了工作目录草稿");

  await servicesMode.check();
  await waitForPreviewMode("services");
  await scriptMode.check();
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')].map((line) => line.querySelector(".cm-placeholder") ? "" : line.textContent).join("\n") === expected, draft);
  assert.equal(await editorText(preview), draft, "切换启动方式后多行脚本草稿丢失");
  await servicesMode.check();
  await waitForPreviewMode("services");
  await page.getByRole("button", { name: "检测服务" }).click();
  const detectionResult = page.locator(".preview-detection-result");
  await detectionResult.filter({ hasText: /检测到 2 个候选/ }).waitFor();
  assert.match(await detectionResult.innerText(), /检测到 2 个候选/);

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
  const serviceWrap = page.getByRole("checkbox", { name: "网页前端 启动脚本 自动换行" });
  await serviceWrap.check();
  assert.equal(await page.getByRole("checkbox", { name: "接口服务 启动脚本 自动换行" }).isChecked(), true, "换行偏好应同步到所有服务编辑器");
  assert.equal(await editorText(apiCommand), "cd server\nnpm run dev -- --port $PORT", "切换换行不能改写另一服务的脚本");
  await page.getByRole("button", { name: "手动添加" }).click();
  const manualCommand = page.getByRole("textbox", { name: "新服务 启动脚本" });
  await manualCommand.fill('echo "手动服务"\nnpm start');
  assert.equal(await manualCommand.locator(".cm-line span").count() > 0, true, "手动添加的服务也应使用语法高亮编辑器");
  assert.equal(await page.getByRole("checkbox", { name: "新服务 启动脚本 自动换行" }).isChecked(), true);
  await page.getByRole("button", { name: "移除 新服务" }).click();
  await page.getByTestId("health-refresh").click();
  assert.equal(await editorText(webCommand), editedWebCommand, "同项目重新渲染吞掉了服务脚本草稿");
  assert.equal(await page.getByText("已选 2 个 · 最多同时启动 8 个").isVisible(), true, "检测结果应支持多选");

  await proxy.selectOption("auto");
  await savePreview.click();
  await page.waitForFunction(
    () => JSON.parse(document.querySelector("[data-testid=stored-projects]").textContent)["p-one"].previewConfig.mode === "services",
  );
  assert.equal(await name.inputValue(), "改了名字", "保存预览设置不应冲掉基本信息草稿");
  assert.equal(await repoPath.inputValue(), "/workspace/改了目录", "保存预览设置不应冲掉目录草稿");

  const stored = JSON.parse(await page.getByTestId("stored-projects").textContent());
  assert.equal(stored["p-one"].previewConfig.mode, "services");
  assert.equal(stored["p-one"].previewConfig.proxy, "auto");
  assert.deepEqual(stored["p-one"].previewConfig.services.map((service) => service.enabled), [true, true]);
  assert.equal(stored["p-one"].previewConfig.primaryServiceId, "web");
  assert.equal(stored["p-one"].previewConfig.services[0].command, editedWebCommand);
  assert.equal(stored["p-one"].previewCommand, draft);

  await page.reload();
  await waitForPreviewMode("services");
  assert.equal(await servicesMode.isChecked(), true, "刷新后没有读回已存启动方式");
  assert.equal(await serviceWrap.isChecked(), true, "刷新后应记住换行偏好");
  assert.equal(await page.getByRole("checkbox", { name: "启动 网页前端" }).isChecked(), true, "刷新后丢了已选服务");
  assert.equal(await page.getByRole("checkbox", { name: "启动 接口服务" }).isChecked(), true, "刷新后丢了第二个已选服务");
  assert.equal(await editorText(page.getByRole("textbox", { name: "网页前端 启动脚本" })), editedWebCommand, "刷新后丢了已存服务脚本");
  await scriptMode.check();
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')].map((line) => line.querySelector(".cm-placeholder") ? "" : line.textContent).join("\n") === expected, draft);
  assert.equal(await editorText(page.getByRole("textbox", { name: "启动脚本", exact: true })), draft, "刷新后丢了已存总脚本");
  await servicesMode.check();
  await waitForPreviewMode("services");
  await page.getByTestId("mode-multi").click();
  await page.getByText("当前使用反代：", { exact: false }).waitFor();

  if (process.env.SETTINGS_DRAFT_SHOT) await page.screenshot({ path: process.env.SETTINGS_DRAFT_SHOT });

  await addInertBackground();
  // ② 换成另一个项目：这时候必须重置，否则会把上一个项目的设置写到这一个头上。
  await help.click();
  await page.getByTestId("switch-project").dispatchEvent("click");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.locator("#root").evaluate((node) => node.inert), false, "切换项目卸载说明弹窗后，背景必须恢复可交互");
  assert.equal(await page.locator(".task-modal-scrim").count(), 0, "切换项目不能残留遮罩");
  await page.waitForFunction(() => {
    const inputFor = (labelText) => Array.from(document.querySelectorAll("label"))
      .find((label) => label.textContent?.includes(labelText))
      ?.querySelector("input");
    return inputFor("项目名称")?.value === "第二个项目"
      && inputFor("工作目录")?.value === "/workspace/p-two";
  });
  assert.equal(await editorText(page.getByRole("textbox", { name: "启动脚本", exact: true })), "", "换项目还留着上一个项目的脚本");
  assert.equal(await name.inputValue(), "第二个项目", "换项目应显示新项目的名称");
  assert.equal(await repoPath.inputValue(), "/workspace/p-two", "换项目应显示新项目的目录");

  assert.equal(await page.getByTestId("already-inert").evaluate((node) => node.inert), true, "切换项目后应保留背景原有的 inert 状态");
  await page.getByTestId("already-inert").evaluate((node) => node.remove());

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?case=${caseId}-member&member`);
  await help.waitFor();
  assert.equal(await preview.getAttribute("aria-readonly"), "true");
  assert.equal(await preview.getAttribute("contenteditable"), "false");
  await preview.focus();
  await page.keyboard.insertText("不能编辑");
  assert.equal(await editorText(preview), "", "只读成员不能修改命令");
  const readonlyWrap = page.getByRole("checkbox", { name: "启动脚本 自动换行" });
  await readonlyWrap.uncheck();
  assert.equal(await readonlyWrap.isChecked(), false, "只读成员仍能调整阅读换行方式");
  assert.equal(await savePreview.count(), 0, "成员不能保存预览设置");
  await help.click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("heading", { name: "自动识别启动命令" }).isVisible(), true, "只读成员也能查看说明");
  await acknowledge.click();
  assert.deepEqual(errors, [], "项目设置页不应产生运行时异常");

  console.log("project settings draft + preview help: ok (multi-service persistence, proxy defaults, drafts, focus containment, accessibility, inert cleanup, drag selection, dismissal, scroll hints, narrow screen, read-only)");
} finally {
  await browser?.close();
  await server.close();
}
