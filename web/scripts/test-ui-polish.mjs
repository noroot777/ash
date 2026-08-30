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
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/ui-polish.html`);

  const render = (html) => page.locator("#root").evaluate((node, value) => { node.innerHTML = value; }, html);

  await render('<div class="settings-shell"><aside></aside><main></main></div>');
  await page.setViewportSize({ width: 660, height: 900 });
  assert.equal(await page.locator(".settings-shell").evaluate((node) => getComputedStyle(node).gridTemplateColumns), "176px 484px");
  await page.setViewportSize({ width: 760, height: 900 });
  assert.equal(await page.locator(".settings-shell").evaluate((node) => getComputedStyle(node).gridTemplateColumns), "240px 520px");

  await page.setViewportSize({ width: 1280, height: 720 });
  await render('<div class="auth-shell"><div class="auth-stage"></div></div>');
  const authScroll = await page.locator(".auth-shell").evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }));
  assert.equal(authScroll.scrollHeight, authScroll.clientHeight, `身份页不应凭空滚动：${JSON.stringify(authScroll)}`);

  await page.setViewportSize({ width: 1000, height: 800 });
  await render(`
    <section class="task-confirm-dialog">
      <header class="task-confirm-header"><span class="is-danger">!</span><div><small>HIGH IMPACT ACTION</small><h2>删除</h2></div><button>×</button></header>
      <footer><button>取消</button><button class="is-danger">删除</button></footer>
    </section>
    <button class="create-project-mode"><span>□</span><span><b>本地目录</b></span></button>
  `);

  const dangerColors = await page.locator(".task-confirm-header > span.is-danger").evaluate((node) => {
    const reference = document.createElement("i");
    reference.style.cssText = "background:color-mix(in srgb,var(--red) 9%,var(--panel));border:1px solid color-mix(in srgb,var(--red) 24%,var(--line))";
    document.body.append(reference);
    const actual = getComputedStyle(node);
    const expected = getComputedStyle(reference);
    const result = {
      background: actual.backgroundColor,
      border: actual.borderColor,
      expectedBackground: expected.backgroundColor,
      expectedBorder: expected.borderColor,
    };
    reference.remove();
    return result;
  });
  assert.equal(dangerColors.background, dangerColors.expectedBackground, "危险图标底色应按 sRGB 混出淡红");
  assert.equal(dangerColors.border, dangerColors.expectedBorder, "危险图标描边应按 sRGB 混出红色");

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const selector of [".create-project-mode", ".task-confirm-dialog > footer button"]) {
    const motion = await page.locator(selector).first().evaluate((node) => {
      const style = getComputedStyle(node);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    assert.equal(motion.property, "none", `${selector} 在减弱动态效果时不应保留过渡`);
    assert.equal(motion.duration, "0s", `${selector} 在减弱动态效果时过渡时长应归零`);
    await page.locator(selector).first().hover();
    assert.equal(await page.locator(selector).first().evaluate((node) => getComputedStyle(node).transform), "none");
  }

  console.log("[ui-polish] responsive, danger color and reduced-motion checks passed");
} finally {
  await browser?.close();
  await server.close();
}
