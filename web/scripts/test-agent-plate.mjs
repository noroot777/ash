// 对话框底部的执行器水印:字号跟着框高走,换智能体跟着换字,名字长了要收进框里。
// 跑法:npm -w web run test:agent-plate
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

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
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/agent-plate.html`);

  const word = page.locator(".agent-plate-word");
  const plate = page.locator(".agent-plate");
  await word.waitFor();

  // 调样式时用:PLATE_SHOT=/tmp/plate 会按状态存几张图,便于肉眼比对。
  // 必须等入场动画跑完再拍,否则拍到的是位移中的中间帧。
  const shot = async (tag) => {
    if (!process.env.PLATE_SHOT) return;
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await page.locator(".task-reply-box").screenshot({ path: `${process.env.PLATE_SHOT}-${tag}.png` });
  };

  const sizeOf = () => word.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const widthOf = () => word.evaluate((el) => el.getBoundingClientRect().width);

  assert.equal(await word.textContent(), "claude");
  await shot("short");

  // 水印是底色:不能吃点击,也不能被选中。
  assert.equal(
    await plate.evaluate((el) => getComputedStyle(el).pointerEvents),
    "none",
  );

  // 矮框:字号约为框高的 34%。
  const short = await sizeOf();
  assert.ok(Math.abs(short - 96 * 0.34) < 1.5, `矮框字号应约 32.6px，实际 ${short}`);

  // 框变高,字跟着变大。
  await page.getByTestId("grow").click();
  await page.waitForFunction(
    (before) => {
      const el = document.querySelector(".agent-plate-word");
      return el ? parseFloat(getComputedStyle(el).fontSize) > before + 1 : false;
    },
    short,
  );
  const tall = await sizeOf();
  assert.ok(Math.abs(tall - 230 * 0.34) < 1.5, `高框字号应约 78.2px，实际 ${tall}`);
  await shot("tall");

  // 变矮要能收回去,不能只涨不落。
  await page.getByTestId("shrink").click();
  await page.waitForFunction(
    (target) => {
      const el = document.querySelector(".agent-plate-word");
      return el ? Math.abs(parseFloat(getComputedStyle(el).fontSize) - target) < 1.5 : false;
    },
    short,
  );

  // 换智能体,水印跟着换。
  await page.getByTestId("to-codex").click();
  await page.waitForFunction(() => document.querySelector(".agent-plate-word")?.textContent === "codex");

  // 长名字要按宽度收进框里,不能糊出边界。
  await page.getByTestId("grow").click();
  await page.getByTestId("to-antigravity").click();
  await page.waitForFunction(() => document.querySelector(".agent-plate-word")?.textContent === "antigravity");
  await page.waitForFunction(() => {
    const el = document.querySelector(".agent-plate-word");
    const box = document.querySelector(".task-reply-box");
    if (!el || !box) return false;
    return el.getBoundingClientRect().width <= box.getBoundingClientRect().width;
  });
  const longWidth = await widthOf();
  const boxWidth = await page.locator(".task-reply-box").evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(longWidth <= boxWidth, `长名字应收进框内：字宽 ${longWidth} > 框宽 ${boxWidth}`);
  await shot("long");

  console.log("agent plate test passed");
} finally {
  await browser?.close();
  await server.close();
}
