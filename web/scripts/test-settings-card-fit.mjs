// 设置卡片不许被内容顶穿：卡片里的字要么落在内边距线内，要么根本不存在。
//
// 这类毛病反复出现过（最近一次：项目设置 →「启动范围」那段说明整段贴着卡片边框排，
// 因为左右内边距是按类名点名给的，新加的说明块没被点到）。判据和放行条件都写在
// settings-card-fit.mjs 里，这里负责把卡片摆出来、从宽到窄各体检一遍。
//
// 宽度这一串不是随便挑的：设置卡片的宽度由工作区布局给（侧栏 176/240 + 内边距），
// 视口 1000px 时卡片只有 700 出头 —— 按视口写的断点在那一档还没生效，卡片却已经比
// 里面的表窄了。所以中间那几档必须在场。
//
// 跑法：npm -w web run test:settings-card-fit
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { assertCardsFit, findCardBleed } from "./settings-card-fit.mjs";

const WIDTHS = [1440, 1180, 1000, 900, 820, 700, 620];

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/settings-card-fit.html`);
  await page.locator(".project-preview .settings-card").waitFor();
  await page.locator(".agent-profile-table").first().waitFor();

  // ① 自定义脚本这一档：三段说明直接挂在卡片上，卡片自己不带内边距。
  await assertCardsFit(page, WIDTHS, "项目设置（自定义脚本）+ 执行器 Profile");

  // ② 换到「选择服务」：卡片里换成整块服务面板，说明段跟着换了一层容器。
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("radio", { name: "选择服务", exact: true }).click();
  await page.getByRole("button", { name: "手动添加" }).click();
  await page.getByRole("button", { name: "手动添加" }).click();
  await page.locator(".preview-service-card").nth(1).waitFor();
  await assertCardsFit(page, WIDTHS, "项目设置（选择服务）");

  // ③ 光看不出问题的那一类：说明段真的跟上下各行对齐，而不是「碰巧没长到边上」。
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("radio", { name: "自定义脚本", exact: true }).click();
  await page.locator(".preview-script-help").waitFor();
  const offsets = await page.locator(".project-preview .settings-card").evaluate((card) => {
    const cardLeft = card.getBoundingClientRect().left;
    const pick = (selector) => {
      const node = card.querySelector(selector);
      return node ? Math.round(node.getBoundingClientRect().left - cardLeft) : null;
    };
    return {
      row: pick(".settings-row"),
      help: pick(".preview-script-help"),
      launchHelp: pick(".preview-launch-scope-help"),
      proxyHelp: pick(".preview-proxy-help"),
    };
  });
  assert.equal(offsets.help, offsets.row, `启动脚本说明应与行左对齐：${JSON.stringify(offsets)}`);
  assert.equal(offsets.launchHelp, offsets.row, `启动范围说明应与行左对齐：${JSON.stringify(offsets)}`);
  assert.equal(offsets.proxyHelp, offsets.row, `反向代理说明应与行左对齐：${JSON.stringify(offsets)}`);

  // ④ 体检本身得有牙：故意撤掉那段说明的内边距，必须被抓出来。
  await page.addStyleTag({ content: ".project-preview .settings-card > .preview-launch-scope-help { padding-inline: 0 !important; }" });
  await page.waitForTimeout(60);
  const caught = await findCardBleed(page);
  assert.ok(
    caught.some((finding) => finding.where.includes("preview-launch-scope-help")),
    `撤掉内边距后应被判为贴边，实际：${JSON.stringify(caught)}`,
  );

  assert.deepEqual(errors, [], `页面不应抛错：${errors.join(" / ")}`);
  console.log("settings card fit: ok");
} finally {
  await browser?.close();
  await server.close();
}
