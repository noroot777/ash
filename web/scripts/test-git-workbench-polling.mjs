import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

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
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench-polling.html`;
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  const control = (expression, argument) => page.evaluate(expression, argument);
  const readCount = () => control(() => window.__polling.readCount());
  const waitForInitialRead = () =>
    page.waitForFunction(() => window.__polling?.readCount() === 1);

  await page.goto(url);
  await waitForInitialRead();
  assert.equal(await readCount(), 1, "initial read starts once");
  await page.waitForTimeout(5_500);
  assert.equal(await readCount(), 1, "polling must not supersede a read that lasts over five seconds");
  await control(() => window.__polling.releaseRead(0, "slow-success"));
  await page.getByTestId("version").filter({ hasText: "slow-success" }).waitFor();
  assert.equal(await page.getByTestId("loading").innerText(), "false");
  await page.waitForTimeout(5_500);
  assert.equal(await readCount(), 2, "polling resumes after the slow read settles");

  await page.reload();
  await waitForInitialRead();
  await page.waitForTimeout(5_500);
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
  await page.waitForTimeout(5_500);
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
  await page.waitForTimeout(5_500);
  assert.equal(await readCount(), 1, "polling stays paused while the write itself is pending");
  await control(() => window.__polling.releaseAction());
  await page.waitForFunction(() => window.__polling.readCount() === 2);
  assert.equal(await readCount(), 2);
  await page.waitForTimeout(5_500);
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
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId("root").innerText(), "/repo-b");
  assert.equal(await page.getByTestId("version").innerText(), "root-b");

  console.log("git workbench polling test passed");
} finally {
  await browser?.close();
  await server.close();
}
