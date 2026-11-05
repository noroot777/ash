// 三段执行目标胶囊的连续选择回归：前一段选定后，下一段应沿横向顺序自动展开。
// 跑法：npm -w web run test:run-target-picker
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  await page.route("**/api/llm-providers", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.route("**/api/agents/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.goto(`${web.origin}/scripts/fixtures/run-target-picker.html`);

  const agentTrigger = page.getByRole("button", { name: /智能体：/ });
  const modelTrigger = page.getByRole("button", { name: /模型：/ });
  const effortTrigger = page.getByRole("button", { name: /智能水平：/ });

  await agentTrigger.click();
  const agentPanelBox = await page.locator(".agent-model-picker").boundingBox();
  assert(agentPanelBox, "智能体浮层应已展开");
  await page.getByRole("option", { name: /@codex/ }).click();

  // 第一段选定后不收口：右边模型段立即展开，并已切到刚选中的 CLI。
  assert.equal(await modelTrigger.getAttribute("aria-expanded"), "true");
  await page.getByPlaceholder("筛选 codex 的模型…").waitFor();
  const modelPanelBox = await page.locator(".agent-model-picker").boundingBox();
  assert(modelPanelBox && modelPanelBox.x > agentPanelBox.x, "模型浮层应向右换到第二段的锚点");

  await page.getByRole("option", { name: /^gpt-5\.6-sol/ }).click();

  // 模型选定后继续向右打开智能水平，而不是让用户再点一次第三段。
  const effortPanel = page.getByRole("listbox", { name: "智能水平" });
  await effortPanel.waitFor();
  const effortPanelBox = await effortPanel.boundingBox();
  assert(effortPanelBox && effortPanelBox.x > modelPanelBox.x, "智能水平浮层应继续向右换到第三段的锚点");
  assert.equal(await effortTrigger.getAttribute("aria-expanded"), "true");
  await page.getByRole("option", { name: /^high/ }).click();
  assert.match(await effortTrigger.getAttribute("aria-label") ?? "", /智能水平：high/);
  assert.equal(await effortTrigger.getAttribute("aria-expanded"), "false");

  // 点回同一个智能体仍不清已选模型，但连续配置链照样进入模型段。
  await agentTrigger.click();
  await page.getByRole("option", { name: /@codex/ }).click();
  await page.getByPlaceholder("筛选 codex 的模型…").waitFor();
  assert.match(await modelTrigger.getAttribute("aria-label") ?? "", /gpt-5\.6-sol/);

  await agentTrigger.click();
  await page.getByRole("option", { name: /@kimi/ }).click();
  await effortTrigger.click();
  assert.match(await effortPanel.textContent() ?? "", /尚未确认实际模型/);
  assert.equal(await effortPanel.getByRole("option").count(), 1);
  assert.equal(await effortPanel.getByRole("option", { name: /^medium/ }).count(), 0);
  await effortPanel.getByRole("option").click();

  await modelTrigger.click();
  await page.getByRole("option", { name: "kimi-code/k3.1-pro", exact: true }).click();
  assert.equal(await effortPanel.getByRole("option", { name: /^high/ }).count(), 1);
  assert.equal(await effortPanel.getByRole("option", { name: /^medium/ }).count(), 0);
  assert.equal(await effortPanel.getByRole("option", { name: /^xhigh/ }).count(), 0);
  await effortPanel.getByRole("option", { name: /^high/ }).click();
  assert.match(await effortTrigger.getAttribute("aria-label") ?? "", /智能水平：high/);

  console.log("run target picker test passed");
} finally {
  await browser?.close();
  await web.close();
}
