import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

// **写之前发出的那次 GET 后到时，不许它说了算。**
//
// 面板每 5 秒轮询一次，用户还能自己点刷新，于是「读」和「写」天然会交错：一次 GET 已经
// 在飞，用户接着点了暂存，写先回来、读后回来——读带的却是**写之前**的那份快照。此前
// `refresh` 对任何一次成功的 GET 都无条件 `setOverview` + `setStale(null)`，于是
//   ① 写成功、列表已经是「已暂存」→ 被盖回写之前的「更改」，用户按着一份磁盘上已经不
//      存在的状态继续点丢弃/提交；
//   ② 写成功但状态没跟回来（上一轮修出来的 stale 冻结）→ 冻结被这条过期 GET 拆掉，写
//      按钮全回来了，而列表仍是旧的——正是冻结要挡住的那件事（第 1 轮审查复现）。
//
// 判据：冻结只能被**这次写之后**发起的那次成功 GET 解除；写之前发出的响应一律丢弃。

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

const change = (path, kind) => ({ path, origPath: null, kind, conflict: null, nested: false });
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

const until = async (probe, hint) => {
  for (let i = 0; i < 100; i += 1) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等不到：${hint}`);
};

/**
 * 跑一遍「扣住一次 GET → 写 → 放行那次 GET」。
 *
 * `writeStatus` 决定写响应带不带新状态，对应上面两种情形。
 */
async function race(browser, url, { writeStatus }) {
  const page = await browser.newPage();
  let staged = false;
  let statusReadable = true;
  let holdNext = false;
  let heldArrived = false;
  let heldDelivered = false;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });

  await page.route("**/api/tasks/t1/scm", async (route) => {
    const hold = holdNext;
    holdNext = false;
    // 快照定格在**请求到达的那一刻**——这正是「过期响应」的定义。
    const snapshot = statusReadable ? JSON.stringify(overviewOf(staged)) : null;
    if (hold) {
      heldArrived = true;
      await gate;
    }
    if (snapshot === null) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "读不到工作区状态" }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: snapshot });
    }
    if (hold) heldDelivered = true;
  });
  await page.route("**/api/tasks/t1/scm/stage", async (route) => {
    staged = true;
    const body = { ok: true, affected: 1 };
    if (writeStatus) body.status = statusOf(true);
    else statusReadable = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(url);
  // `exact` 不能省：默认是子串匹配，「暂存 a.txt」会连「取消暂存 a.txt」一起数进去。
  const stageOne = page.getByRole("button", { name: "暂存 a.txt", exact: true });
  await stageOne.waitFor();
  await page.locator(".scm-commit textarea").fill("先写一句提交信息");

  // ① 用户点了刷新，这次 GET 被扣在路上。
  holdNext = true;
  await page.getByRole("button", { name: "刷新 git 状态" }).click();
  await until(() => heldArrived, "被扣住的那次 GET 到达服务端");

  // ② 紧接着点暂存，写先回来。
  await stageOne.click();
  const staleBanner = page.locator(".scm-banner.is-danger");
  const unstageOne = page.getByRole("button", { name: "取消暂存 a.txt" });
  if (writeStatus) await unstageOne.waitFor();
  else await staleBanner.waitFor();

  // ③ 放行那条写之前发出的 GET。
  release();
  await until(() => heldDelivered, "被扣住的那次 GET 送达浏览器");
  // 响应到浏览器、fetch 落地、React 重渲染都在这之后，给它一点时间真的把状态写进去
  // ——测的是「盖回去了没有」，所以必须等它有机会盖。
  await page.waitForTimeout(400);

  if (writeStatus) {
    assert.equal(await unstageOne.count(), 1, "写已经成功，过期 GET 不许把列表盖回未暂存");
    assert.equal(await stageOne.count(), 0, "盖回去的话「暂存 a.txt」会重新出现——那正是磁盘上已经不成立的判断");
    assert.equal(await staleBanner.count(), 0, "这一路没有过期，不该有冻结横幅");
  } else {
    assert.equal(await staleBanner.count(), 1, "冻结只能被写之后那次成功刷新解除，过期 GET 拆不得");
    assert.match(await staleBanner.innerText(), /写操作已暂停/);
    assert.equal(await page.getByRole("button", { name: /^暂存 / }).count(), 0, "冻结期间逐条暂存要一直收着");
    assert.equal(await page.getByRole("button", { name: /^丢弃 / }).count(), 0, "丢弃不可逆，更不能被过期 GET 放回来");
    assert.equal(await page.locator(".scm-commit__submit").isDisabled(), true, "冻结期间提交按钮要一直禁用");
  }

  await page.close();
}

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
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/scm-stale.html`;

  browser = await chromium.launch({ executablePath: await executablePath(), headless: true });
  await race(browser, url, { writeStatus: true });
  await race(browser, url, { writeStatus: false });

  console.log("scm race test passed");
} finally {
  await browser?.close();
  await server.close();
}
