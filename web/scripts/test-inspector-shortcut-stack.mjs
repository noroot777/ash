import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const serveOnly = process.argv.includes("--serve");
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
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/inspector-shortcut-stack.html`;
  if (serveOnly) {
    console.log(JSON.stringify({ url }));
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    browser = await chromium.launch(await chromeLaunchOptions());
    const page = await browser.newPage();
    await page.goto(url);
    const result = page.locator("#result");
    await result.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#result")?.dataset.status);
    const text = await result.innerText();
    assert.equal(await result.getAttribute("data-status"), "pass", text);
    console.log(text);
  }
} finally {
  await browser?.close();
  await server.close();
}
