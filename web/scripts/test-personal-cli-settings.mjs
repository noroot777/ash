import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/personal-cli-settings.html`);
  const block = agent => page.locator(".pcli-block").filter({ has: page.getByRole("heading", { name: agent, exact: true }) });
  await block("codex").waitFor();
  assert.equal(await page.getByRole("button", { name: "新建技能", exact: true }).count(), 0);
  assert.equal(await page.getByText(/新建一个/).count(), 0);
  for (const agent of ["claude", "codex"]) {
    await block(agent).getByRole("button", { name: "编辑", exact: true }).click();
    await block(agent).locator(".pcli-memory-editor").waitFor();
  }
  for (const width of [1200, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator(".pcli-memory-editor").evaluateAll(nodes => nodes.map(node => ({
      height: node.getBoundingClientRect().height,
      resize: getComputedStyle(node).resize,
      fits: node.getBoundingClientRect().right <= innerWidth,
    })));
    assert.equal(geometry.length, 2);
    for (const editor of geometry) {
      assert.equal(editor.height, 240);
      assert.equal(editor.resize, "vertical");
      assert.equal(editor.fits, true);
    }
  }
  await page.setViewportSize({ width: 1200, height: 1000 });
  for (const [agent, file] of [["claude", "CLAUDE.md"], ["codex", "AGENTS.md"]]) {
    const editor = block(agent).getByRole("textbox", { name: `${agent} 个人全局 ${file}`, exact: true });
    const body = `# ${agent}\n多行内容\n`;
    await editor.fill(body);
    await block(agent).getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await block(agent).getByRole("button", { name: "编辑", exact: true }).click();
    assert.equal(await editor.inputValue(), body);
    await editor.fill("未保存的内容");
    await block(agent).getByRole("button", { name: "重新读取", exact: true }).click();
    await page.waitForFunction(({ name, body }) => [...document.querySelectorAll("textarea")].some(node => node.getAttribute("aria-label") === name && node.value === body), { name: `${agent} 个人全局 ${file}`, body });
    await block(agent).getByRole("button", { name: "取消", exact: true }).click();
  }
  await page.getByRole("button", { name: "/existing", exact: true }).click();
  const skill = page.getByRole("textbox", { name: "claude 技能 existing", exact: true });
  await skill.fill("# 已编辑\n");
  await block("claude").getByRole("button", { name: "保存", exact: true }).click();
  await skill.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "/existing", exact: true }).click();
  assert.equal(await skill.inputValue(), "# 已编辑\n");
  await block("claude").getByRole("button", { name: "取消", exact: true }).click();
  await block("claude").getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "/existing", exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("personal CLI settings: creation entry removed; existing skill and full-size memory editors verified");
} finally {
  await browser?.close();
  await server.close();
}
