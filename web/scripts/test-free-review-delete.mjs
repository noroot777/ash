import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 派审对话框里删审查者。钉四件事：
//
// ① 每一行都有自己的删除入口（按钮不能套按钮，所以行是 div + 两颗按钮），点它只开确认框，
//    不会顺手把这一行选中，也不会把外面那层派审对话框一起关掉（嵌套浮层那摞的规矩）。
// ② 取消不发请求；删掉的是**全局配置**，所以确认框要说清它会从所有任务的列表里消失。
// ③ 删到本任务已经预约的那位时，那句话要点名「本任务」——服务端确实会 disarm，事后才
//    发现预约没了是最难查的那种；删别人时只说通用那句，别冤枉本任务。
// ④ 删掉当前选中的那位，下一位顶上（否则「开始审查」永远灰着）；删到一个不剩时把新建
//    表单摊开，别留一个空列表加一颗灰按钮的死角。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const AGENTS = [{
  id: "codex-local",
  name: "codex@local",
  type: "codex",
  target: { kind: "local" },
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  isDefault: true,
}];

const reviewer = (id, name) => ({
  id,
  name,
  agentType: "codex",
  executorId: "codex-local",
  executorLabel: "codex@local",
  model: null,
  reasoningEffort: "high",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

let reviewers = [reviewer("reviewer-1", "顶级审查"), reviewer("reviewer-2", "opus5"), reviewer("reviewer-3", "grok4.6")];
const deleted = [];

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1080, height: 820 } });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/llm-providers", (route) => json(route, []));
  await page.route("**/api/agents", (route) => json(route, AGENTS));
  await page.route("**/api/reviewer-profiles*", (route) => json(route, reviewers));
  await page.route("**/api/reviewer-profiles/*", (route) => {
    if (route.request().method() !== "DELETE") return json(route, { error: "unhandled" }, 404);
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    deleted.push(id);
    reviewers = reviewers.filter((item) => item.id !== id);
    return json(route, { deleted: true });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/free-review-delete.html`);

  const reviewDialog = page.locator(".free-review-dialog");
  const confirm = page.locator(".task-confirm-dialog");
  const row = (name) => page.locator(".free-review-reviewer-row").filter({ hasText: name });
  const trash = (name) => page.getByRole("button", { name: `删除审查者「${name}」` });
  const selectedName = () => reviewDialog.locator(".free-review-reviewer-pick[aria-selected='true'] b").innerText();

  await reviewDialog.waitFor();
  await page.locator(".free-review-reviewer-row").first().waitFor();
  assert.equal(await page.locator(".free-review-reviewer-row").count(), 3);
  assert.equal(await selectedName(), "opus5", "进来时应当选中状态里记着的那位");

  // ── ① 行尾那颗按钮平时收着，扫到这一行才露出；它不占选中那一下 ──────────────────
  assert.equal(
    await trash("顶级审查").evaluate((element) => getComputedStyle(element).opacity),
    "0",
    "不悬停时删除按钮应当是收着的",
  );
  await row("顶级审查").hover();
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector("[aria-label='删除审查者「顶级审查」']")).opacity === "1",
    null,
    { timeout: 2000 },
  );

  // ── ② 取消不删；文案说清这是全局配置 ─────────────────────────────────────
  await page.screenshot({ path: "/tmp/ash-free-review-rows.png", fullPage: true });
  await trash("顶级审查").click();
  await confirm.waitFor();
  await page.waitForTimeout(320);
  await page.screenshot({ path: "/tmp/ash-free-review-delete-confirm.png", fullPage: true });
  const otherText = await confirm.innerText();
  assert.match(otherText, /确定删除“顶级审查”/);
  assert.match(otherText, /会从所有任务的审查者列表里消失/);
  assert.match(otherText, /历史审查记录仍保留当时的配置快照/);
  assert.match(otherText, /「完成后自动审查」预约会被取消/, "删一份全局配置，别的任务挂着的预约也会断，得说");
  assert.doesNotMatch(otherText, /本任务/, "删的不是本任务预约的那位，别冤枉本任务");
  assert.equal(await selectedName(), "opus5", "点删除不该顺手改选中项");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await confirm.waitFor({ state: "detached" });
  assert.deepEqual(deleted, [], "取消不该发出删除请求");
  assert.equal(await reviewDialog.count(), 1, "关掉确认框不该把派审对话框一起带走");

  // ── ③ 删本任务已经预约的那位：多说一句预约会断 ─────────────────────────────
  await row("opus5").hover();
  await trash("opus5").click();
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /本任务已排上的审查预约会一并取消/);
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await confirm.waitFor({ state: "detached" });
  assert.deepEqual(deleted, ["reviewer-2"]);
  await row("opus5").waitFor({ state: "detached" });
  assert.match(await page.getByTestId("notices").innerText(), /已删除审查者「opus5」/);

  // ── ④ 删掉的是选中那位：下一位顶上，提交按钮不许因此灰掉 ───────────────────────
  const submit = reviewDialog.locator("footer button[type='submit']");
  assert.equal(await selectedName(), "顶级审查", "删掉选中项后应当自动选上剩下的第一位");
  assert.equal(await submit.isDisabled(), false);
  assert.match(await reviewDialog.locator(".free-review-run-override").innerText(), /顶级审查|codex@local/);

  // ── ⑤ 删到一个不剩：新建表单摊开，别留空列表 + 灰按钮的死角 ───────────────────
  for (const name of ["顶级审查", "grok4.6"]) {
    await row(name).hover();
    await trash(name).click();
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "删除", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
  }
  assert.deepEqual(deleted, ["reviewer-2", "reviewer-1", "reviewer-3"]);
  assert.equal(await page.locator(".free-review-reviewer-row").count(), 0);
  await reviewDialog.locator(".free-review-create").waitFor();
  assert.equal(await submit.isDisabled(), true, "一个审查者都没有时不该还能点开始审查");
  assert.equal(await page.getByTestId("closed").count(), 0, "整个过程里派审对话框都不该被关掉");
  await page.screenshot({ path: "/tmp/ash-free-review-delete.png", fullPage: true });

  console.log("test-free-review-delete: OK");
} finally {
  await browser?.close();
  await server.close();
}
