// 对话框的执行器水印:斜体大字铺在框中心,按框的宽高一起定大小,换智能体跟着换字。
// 跑法:npm -w web run test:agent-plate
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeExecutablePath } from "./chrome-path.mjs";
import { createServer } from "vite";

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
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch({ executablePath: await chromeExecutablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/agent-plate.html`);

  const word = page.locator(".agent-plate-word");
  const plate = page.locator(".agent-plate");
  await word.waitFor();
  // 斜体 webfont 落地前后字宽不同,基准尺寸必须等字体就位再量,否则后面的比对会飘。
  await page.evaluate(() => document.fonts.ready);

  // 量字形(ink)外接框,而不是行盒:行盒比大写字形高近三成,拿它判断会误判成溢出。
  // 先等入场动画跑完:动画中间帧的 transform 是 matrix,会让「没被掰斜」这条断言误报。
  const metrics = async () => {
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
    return page.evaluate(() => {
      const el = document.querySelector(".agent-plate-word");
      const box = document.querySelector(".task-reply-box");
      const style = getComputedStyle(el);
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const m = ctx.measureText(el.textContent.toUpperCase());
      return {
        size: parseFloat(style.fontSize),
        fontStyle: style.fontStyle,
        transform: style.transform,
        spanW: el.offsetWidth,
        spanH: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
        boxW: box.clientWidth,
        boxH: box.clientHeight,
        text: el.textContent,
      };
    });
  };

  // 调样式时用:PLATE_SHOT=/tmp/plate 会按状态存几张图,便于肉眼比对。
  // 必须等入场动画跑完再拍,否则拍到的是位移中的中间帧。
  const shot = async (tag) => {
    if (!process.env.PLATE_SHOT) return;
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
    await page.locator(".task-reply-box").screenshot({ path: `${process.env.PLATE_SHOT}-${tag}.png` });
  };

  // 水印是底色:不能吃点击,也不能被选中。
  assert.equal(await plate.evaluate((el) => getComputedStyle(el).pointerEvents), "none");

  const short = await metrics();
  assert.equal(short.text, "claude");
  // 斜必须来自字体本身,不是把正体旋转/切变
  assert.equal(short.fontStyle, "italic", "水印要用斜体字形");
  // transform 允许是单位矩阵(入场动画 fill 后的计算值就是它),但不许带斜切/旋转分量:
  // matrix(a,b,c,d,..) 里 skewX 落在 c、rotate 同时动 b 和 c。
  const skewed = (value) => {
    const nums = value.match(/-?[\d.]+/g);
    return !!nums && (Math.abs(Number(nums[1])) > 1e-6 || Math.abs(Number(nums[2])) > 1e-6);
  };
  assert.ok(!skewed(short.transform), `不该靠 transform 把字掰斜，实际 ${short.transform}`);
  await shot("short");

  // 铺开但要留白:两个方向都不许超出框,且受限的那一边要真的铺到 ~80%。
  const fills = (m) => {
    assert.ok(m.spanW <= m.boxW, `字宽 ${m.spanW.toFixed(1)} 超出框宽 ${m.boxW}`);
    assert.ok(m.spanH <= m.boxH, `字高 ${m.spanH.toFixed(1)} 超出框高 ${m.boxH}`);
    const ratio = Math.max(m.spanW / m.boxW, m.spanH / m.boxH);
    assert.ok(ratio > 0.7 && ratio < 0.9, `受限方向应铺到 ~0.8，实际 ${ratio.toFixed(3)}`);
  };
  fills(short);

  // 框变高,字跟着变大。
  await page.getByTestId("grow").click();
  await page.waitForFunction(
    (before) => {
      const el = document.querySelector(".agent-plate-word");
      return el ? parseFloat(getComputedStyle(el).fontSize) > before + 1 : false;
    },
    short.size,
  );
  const tall = await metrics();
  fills(tall);
  await shot("tall");

  // 变矮要能收回去,不能只涨不落。
  await page.getByTestId("shrink").click();
  await page.waitForFunction(
    (target) => {
      const el = document.querySelector(".agent-plate-word");
      return el ? Math.abs(parseFloat(getComputedStyle(el).fontSize) - target) < 1.5 : false;
    },
    short.size,
  );

  // 换智能体,水印跟着换。
  await page.getByTestId("to-codex").click();
  await page.waitForFunction(() => document.querySelector(".agent-plate-word")?.textContent === "codex");

  // 长名字靠宽度约束收住,不能糊出边界。
  await page.getByTestId("grow").click();
  await page.getByTestId("to-antigravity").click();
  await page.waitForFunction(() => document.querySelector(".agent-plate-word")?.textContent === "antigravity");
  await page.waitForTimeout(200);
  fills(await metrics());
  await shot("long");

  console.log("agent plate test passed");
} finally {
  await browser?.close();
  await server.close();
}
