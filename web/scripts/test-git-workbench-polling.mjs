import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { outlastPageTimers, settlePage } from "./wait-until.mjs";

// useWorkbench 的轮询是挂载时排上的 5 秒 setInterval。「过一轮轮询也不该多发一次读」这类
// 断言不靠睡 5.5 秒赌它走过了：在页面里排一个 5.5 秒后到期的定时器（outlastPageTimers），
// 它触发时那条 5 秒的轮询必然已经走过至少一次（定时器按到期先后触发，跟负载无关）。
const POLL_MS = 5000;
const outlastPoll = (page) => outlastPageTimers(page, POLL_MS + 500);

const root = fileURLToPath(new URL("..", import.meta.url));
const web = await startWebServer();

let browser;
try {
  const url = `${web.origin}/scripts/fixtures/git-workbench-polling.html`;
  browser = await launchChrome();
  const page = await browser.newPage();
  const control = (expression, argument) => page.evaluate(expression, argument);
  const readCount = () => control(() => window.__polling.readCount());
  const waitForInitialRead = () =>
    page.waitForFunction(() => window.__polling?.readCount() === 1);

  await page.goto(url);
  await waitForInitialRead();
  assert.equal(await readCount(), 1, "initial read starts once");
  await outlastPoll(page);
  assert.equal(await readCount(), 1, "polling must not supersede a read that lasts over five seconds");
  await control(() => window.__polling.releaseRead(0, "slow-success"));
  await page.getByTestId("version").filter({ hasText: "slow-success" }).waitFor();
  assert.equal(await page.getByTestId("loading").innerText(), "false");
  await page.waitForFunction(() => window.__polling.readCount() >= 2, null, { timeout: 15_000 })
    .catch(() => assert.fail("polling resumes after the slow read settles: 15s 内没等到下一轮轮询读"));
  // 第 2 发一直不放，在途时轮询不会再发第 3 发。
  assert.equal(await readCount(), 2, "polling resumes after the slow read settles");

  await page.reload();
  await waitForInitialRead();
  await outlastPoll(page);
  assert.equal(await readCount(), 1, "a slow failing read must not be duplicated");
  await control(() => window.__polling.failRead(0, "slow failure"));
  await page.getByTestId("error").filter({ hasText: "slow failure" }).waitFor();
  assert.equal(await page.getByTestId("loading").innerText(), "false");

  await page.reload();
  await waitForInitialRead();
  await control(() => window.__polling.releaseRead(0, "initial"));
  await page.getByTestId("version").filter({ hasText: "initial" }).waitFor();
  await page.getByRole("button", { name: "refresh" }).click();
  assert.equal(await readCount(), 2);
  await page.getByRole("button", { name: "write" }).click();
  await page.getByTestId("busy").filter({ hasText: "true" }).waitFor();
  await page.waitForFunction(() => window.__polling.readCount() === 3);
  assert.equal(await readCount(), 3, "write completion starts a fresh read");
  await control(() => window.__polling.releaseRead(1, "stale-before-write"));
  await page.waitForFunction(() => window.__polling.consumed(1));
  await outlastPoll(page);
  assert.equal(
    await readCount(),
    3,
    "an old read settling must not clear the newer post-write read marker",
  );
  await control(() => window.__polling.releaseRead(2, "after-write"));
  await page.getByTestId("version").filter({ hasText: "after-write" }).waitFor();

  await page.reload();
  await waitForInitialRead();
  await control(() => window.__polling.releaseRead(0, "initial"));
  await page.getByTestId("version").filter({ hasText: "initial" }).waitFor();
  await control(() => window.__polling.holdAction());
  await page.getByRole("button", { name: "write" }).click();
  await page.getByTestId("busy").filter({ hasText: "true" }).waitFor();
  await outlastPoll(page);
  assert.equal(await readCount(), 1, "polling stays paused while the write itself is pending");
  await control(() => window.__polling.releaseAction());
  await page.waitForFunction(() => window.__polling.readCount() === 2);
  assert.equal(await readCount(), 2);
  await outlastPoll(page);
  assert.equal(await readCount(), 2, "polling must not duplicate the post-write refresh");
  await control(() => window.__polling.releaseRead(1, "write-refresh"));
  await page.getByTestId("version").filter({ hasText: "write-refresh" }).waitFor();
  await page.getByTestId("busy").filter({ hasText: "false" }).waitFor();

  await page.reload();
  await waitForInitialRead();
  assert.equal(await readCount(), 1);
  await page.getByRole("button", { name: "switch root" }).click();
  assert.equal(await readCount(), 2);
  await control(() => window.__polling.releaseRead(1, "root-b"));
  await page.getByTestId("version").filter({ hasText: "root-b" }).waitFor();
  await control(() => window.__polling.releaseRead(0, "root-a-stale"));
  // 迟到的旧仓库那份已被页面读完、后续提交也冲刷掉了，才读 DOM。
  await page.waitForFunction(() => window.__polling.consumed(0));
  await settlePage(page);
  assert.equal(await page.getByTestId("root").innerText(), "/repo-b");
  assert.equal(await page.getByTestId("version").innerText(), "root-b");

  console.log("git workbench polling test passed");
} finally {
  await browser?.close();
  await web.close();
}
