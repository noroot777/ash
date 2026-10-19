import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ ...await chromeLaunchOptions(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/composer-branches.html`;
  const objective = page.getByRole("textbox", { name: "任务目标" });
  const directory = page.getByRole("button", { name: /^工作目录：/ });
  const submit = page.locator(".studio-submit");
  const records = async () => JSON.parse(await page.getByTestId("created").innerText());
  const waitFor = async (check) => {
    const deadline = Date.now() + 10_000;
    while (!await check()) {
      assert(Date.now() < deadline, "等待分支状态超时");
      await page.waitForTimeout(25);
    }
  };
  const directoryLabel = () => directory.getAttribute("aria-label");
  const expectAutomatic = (branch) => waitFor(async () => (await directoryLabel()).includes(`跟随项目分支 · ${branch}`));
  const selectBase = async (name) => {
    await directory.click();
    await page.getByRole("button", { name: /^base 分支/ }).click();
    await page.getByRole("option", { name, exact: typeof name === "string" }).click();
    await page.keyboard.press("Escape");
  };
  const checkout = async (branch, pending = false) => {
    await page.locator(".workspace-git-context").click();
    await page.getByRole("button", { name: new RegExp(`^${branch}(?:\\s|$)`) }).click();
    if (pending) await waitFor(async () => await page.locator(".workspace-git-context").getAttribute("aria-busy") === "true");
    else await page.locator(".project-git-panel__ok").getByText(`已切换到 ${branch}`, { exact: true }).waitFor();
    await page.keyboard.press("Escape");
  };
  const create = async (body) => {
    const before = (await records()).length;
    await objective.fill(body);
    await waitFor(() => submit.isEnabled());
    await submit.click();
    await waitFor(async () => (await records()).length === before + 1);
    return (await records()).at(-1);
  };

  await page.goto(url);
  await expectAutomatic("main");
  await objective.fill("新建面板打开后切换到升级分支");
  await checkout("version-upgrade");
  await expectAutomatic("version-upgrade");
  if (process.env.ASH_BROWSER_SCREENSHOT) {
    await directory.click();
    await page.screenshot({ path: process.env.ASH_BROWSER_SCREENSHOT, fullPage: true });
    await page.keyboard.press("Escape");
  }
  const automatic = await create("默认分支跟随侧栏切换");
  assert.equal(automatic.worktreeBase, null);
  assert.equal(automatic.resolvedBase, "version-upgrade");
  console.log("✓ 新建面板保持打开时，默认基准跟随侧栏切换，创建请求不携带旧分支");

  await selectBase("version-upgrade");
  await checkout("main");
  assert.match(await directoryLabel(), /独立 worktree · version-upgrade/);
  assert.doesNotMatch(await directoryLabel(), /跟随/);
  const explicit = await create("手动指定分支不被侧栏覆盖");
  assert.equal(explicit.worktreeBase, "version-upgrade");
  assert.equal(explicit.resolvedBase, "version-upgrade");
  await expectAutomatic("main");
  console.log("✓ 手选分支保持固定，重新创建面板恢复自动跟随");

  await selectBase("version-upgrade");
  await selectBase(/^跟随项目分支/);
  await checkout("version-upgrade");
  await expectAutomatic("version-upgrade");
  assert.equal((await create("恢复自动跟随")).worktreeBase, null);
  console.log("✓ 手选后可主动恢复跟随项目分支");

  for (const delayed of ["重开并延迟分支读取", "重开并延迟读取失败"]) {
    await page.reload();
    await expectAutomatic("main");
    await page.getByRole("button", { name: delayed, exact: true }).click();
    await objective.fill("延迟旧响应不能覆盖新分支");
    await checkout("version-upgrade");
    await expectAutomatic("version-upgrade");
    await page.getByRole("button", { name: "释放分支读取", exact: true }).click();
    await page.waitForTimeout(200);
    await expectAutomatic("version-upgrade");
    assert.doesNotMatch(await page.getByTestId("notices").innerText(), /旧分支读取失败/);
    const task = await create(delayed);
    assert.equal(task.worktreeBase, null);
    assert.equal(task.resolvedBase, "version-upgrade");
  }
  console.log("✓ checkout 前发出的分支查询无论迟到成功还是失败，都不覆盖新状态");

  await page.reload();
  await expectAutomatic("main");
  await objective.fill("切分支过程中禁止按钮和快捷键提交");
  await page.getByRole("button", { name: "延迟下一次切换", exact: true }).click();
  await checkout("version-upgrade", true);
  assert.equal(await submit.isEnabled(), false);
  await objective.press("Enter");
  assert.equal((await records()).length, 0);
  await page.getByRole("button", { name: "完成分支切换", exact: true }).click();
  await expectAutomatic("version-upgrade");
  assert.equal((await create("切换结束后创建")).resolvedBase, "version-upgrade");
  console.log("✓ checkout 在途时按钮和快捷键均禁止提交，完成后恢复");

  await page.getByRole("button", { name: "下一次切换失败", exact: true }).click();
  await page.locator(".workspace-git-context").click();
  await page.getByRole("button", { name: /^main(?:\s|$)/ }).click();
  await page.getByText("切换失败，仍在原分支", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await expectAutomatic("version-upgrade");
  assert.equal((await create("切换失败仍使用原分支")).resolvedBase, "version-upgrade");
  console.log("✓ checkout 失败不会误改默认分支，也不会永久禁用提交");

  await selectBase("version-upgrade");
  await page.getByRole("button", { name: "切换项目", exact: true }).click();
  await expectAutomatic("release");
  const other = await create("换项目不能沿用旧项目的手选分支");
  assert.equal(other.projectId, "p2");
  assert.equal(other.worktreeBase, null);
  assert.equal(other.resolvedBase, "release");
  console.log("✓ 换项目清除旧项目的基准分支选择");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
