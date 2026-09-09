import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";

export async function runServerFixture(script, check) {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", `server/scripts/${script}.ts`, "--serve"], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  let browser;
  let output = "";
  child.stderr.on("data", chunk => { output += chunk; });
  const stop = () => {
    if (child.connected) child.send("close-fixture", error => { if (error) child.kill("SIGTERM"); });
    else child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const fixture = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture startup timed out\n${output}`)), 60_000);
      let buffer = "";
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}\n${output}`)); });
      child.stdout.on("data", chunk => {
        output += chunk;
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          try {
            const value = JSON.parse(line);
            if (value.url) { clearTimeout(timer); resolve(value); }
          } catch { /* Fixture progress is also printed to stdout. */ }
        }
      });
    });
    if (process.argv.includes("--serve")) {
      console.log(JSON.stringify(fixture));
      await exited;
      return;
    }
    browser = await chromium.launch(await chromeLaunchOptions());
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await check(page, fixture.url);
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`${script} DOM regression passed`);
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      stop();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
