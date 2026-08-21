import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

// 写操作落地了、但「现在的工作区长什么样」没读到时，面板必须**说出来并停掉写操作**。
//
// 后端那一侧是刻意的：commit 一旦 exit 0 就是成功，不能被随后那次只为显示服务的
// readScmStatus 失败翻成失败（第 1 轮审查的 P2）。代价是响应里可能没有 status。此前前端
// 拿不到 status 就默默留在旧列表上，按钮照常可点——用户于是按着一份写之前的列表继续
// 「暂存全部并提交（7）」，作用的却是磁盘上的另一批文件（第 2 轮审查的 P2）。

const root = fileURLToPath(new URL("..", import.meta.url));
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  chromium.executablePath(),
].filter(Boolean);

async function executablePath() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local Chrome/Chromium candidate.
    }
  }
  throw new Error("找不到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定路径");
}

const change = (path, kind) => ({ path, origPath: null, kind, conflict: null });
const statusOf = (staged) => ({
  branch: { head: "main", detached: false, oid: "abc1234", upstream: null, ahead: null, behind: null },
  merge: [],
  staged: staged ? [change("a.txt", "modified")] : [],
  unstaged: staged ? [] : [change("a.txt", "modified")],
  untracked: [],
  truncated: false,
  operation: null,
});
const overviewOf = (staged) => ({
  root: { path: "/tmp/repo", branch: "main", gitRepo: true, source: "session" },
  taskRunning: false,
  readOnly: null,
  status: statusOf(staged),
  commits: [],
});

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

  browser = await chromium.launch({ executablePath: await executablePath(), headless: true });
  const page = await browser.newPage();

  // 服务端的两个开关：状态读得到吗、暂存生效了没。
  let statusReadable = true;
  let staged = false;
  await page.route("**/api/tasks/t1/scm", async (route) => {
    if (!statusReadable) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "读不到工作区状态" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overviewOf(staged)) });
  });
  // 写成功、但随后那次状态读取失败：ok + affected，没有 status。
  await page.route("**/api/tasks/t1/scm/stage", async (route) => {
    staged = true;
    statusReadable = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, affected: 1 }) });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/scm-stale.html`);

  const stageOne = page.getByRole("button", { name: "暂存 a.txt" });
  const commit = page.locator(".scm-commit__submit");
  const staleBanner = page.locator(".scm-banner.is-danger");
  await stageOne.waitFor();

  await page.locator(".scm-commit textarea").fill("先写一句提交信息");
  assert.equal(await commit.isDisabled(), false, "正常状态下该能提交");
  assert.equal(await staleBanner.count(), 0, "状态读得到时不该有「列表可能是旧的」");

  await stageOne.click();

  // 写落地了，状态没跟回来 → 面板必须留下一条持久的横幅，并冻住所有写入口。
  await staleBanner.waitFor();
  const text = await staleBanner.innerText();
  assert.match(text, /下面这份列表可能是旧的/, `横幅要把「列表可能过期」说出来，实测：${text}`);
  assert.match(text, /写操作已暂停/, "还要说清楚写操作被停了，否则用户只会觉得按钮坏了");
  assert.equal(await staleBanner.getByRole("button", { name: "知道了" }).count(), 0, "这不是一条通知，不给「知道了」——只有刷成功才算解除");

  assert.equal(await commit.isDisabled(), true, "列表可能过期时不许提交：数字是按旧列表算的");
  assert.equal(await page.getByRole("button", { name: /^暂存 / }).count(), 0, "逐条暂存要收起来");
  assert.equal(await page.getByRole("button", { name: /：全部暂存$/ }).count(), 0, "整组暂存更要收起来");
  assert.equal(await page.getByRole("button", { name: /^丢弃 / }).count(), 0, "丢弃是不可逆的，更不能按着旧列表点");
  assert.equal(await page.getByRole("button", { name: /^取消暂存 / }).count(), 0, "取消暂存同样按的是旧列表");

  // 出口只有一个：刷新成功。
  statusReadable = true;
  await staleBanner.getByRole("button", { name: "重试" }).click();
  await staleBanner.waitFor({ state: "detached" });

  // 刷回来的是**写之后**的真实状态：a.txt 已经在暂存区里了。
  await page.getByRole("button", { name: "取消暂存 a.txt" }).waitFor();
  assert.equal(await commit.isDisabled(), false, "刷新成功后写操作要自己恢复");

  console.log("scm stale test passed");
} finally {
  await browser?.close();
  await server.close();
}
