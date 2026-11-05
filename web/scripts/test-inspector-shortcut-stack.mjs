import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const serveOnly = process.argv.includes("--serve");
const web = await startWebServer();
let browser;
try {
  const url = `${web.origin}/scripts/fixtures/inspector-shortcut-stack.html`;
  if (serveOnly) {
    console.log(JSON.stringify({ url }));
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    browser = await launchChrome();
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
  await web.close();
}
