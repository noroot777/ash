// 项目设置里正在编辑的草稿不能被后台刷新静默吞掉。跑：npm -w web run test:project-settings-draft
//
// 钉的是一次真实事故的反面：预览命令这个框刚加上，用户输到一半，界面自己把它清空了，
// 保存按钮跟着变灰，没有任何提示 —— 看上去就是「这个框坏了」。真凶不在这个框上，在
// 面板顶上那颗 `useEffect(..., [project])`：WorkspaceShell 收到项目健康结果会
// `{ ...project, health }` 换一个新对象，**内容一个字没变、身份变了**，于是三个框全被
// 重置回服务端的值。那个请求进页面时发一次，之后每有任务结算还会再发，所以它不是
// 「首次进入」的一次性问题，是编辑期间随时会来一下。
//
// 两条判据必须同时成立，少一条这颗 effect 就又会被人改回去：
//   ① 同一个项目换对象身份 → 草稿留着（名称、目录、预览命令三个都算）
//   ② project.id 变了 → 草稿冲掉（那已经是另一个项目的设置了）
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
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

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html`);

  const preview = page.locator("label", { hasText: "「打开预览」跑哪条命令" }).locator("input");
  const name = page.locator("label", { hasText: "项目名称" }).locator("input");
  const repoPath = page.locator("label", { hasText: "工作目录" }).locator("input");
  await preview.waitFor();

  // ① 编辑三个框，然后来一次健康刷新。
  const DRAFT = "cd a4sms-front && pnpm run dev -- --port $PORT";
  await preview.fill(DRAFT);
  await name.fill("改了名字");
  await repoPath.fill("/workspace/改了目录");
  const save = page.getByRole("button", { name: "保存预览命令" });
  assert.equal(await save.isDisabled(), false, "输了字之后保存按钮应该是可按的");

  await page.getByTestId("health-refresh").click();
  // 刷新是同步 setState，等一帧就够；用 waitForFunction 而不是 sleep，免得把时序写进测试。
  await page.waitForFunction(() => document.querySelectorAll("input").length > 0);
  assert.equal(await preview.inputValue(), DRAFT, "健康刷新把用户正在输的预览命令吞了");
  assert.equal(await name.inputValue(), "改了名字", "健康刷新把项目名称的草稿吞了");
  assert.equal(await repoPath.inputValue(), "/workspace/改了目录", "健康刷新把工作目录的草稿吞了");
  assert.equal(await save.isDisabled(), false, "草稿还在，保存按钮不该变灰");

  // 连来几次也一样 —— 现场里它是跟着任务结算反复发的。
  await page.getByTestId("health-refresh").click();
  await page.getByTestId("health-refresh").click();
  assert.equal(await preview.inputValue(), DRAFT, "连续刷新之后草稿仍要在");

  if (process.env.SETTINGS_DRAFT_SHOT) await page.screenshot({ path: process.env.SETTINGS_DRAFT_SHOT });

  // ② 换成另一个项目：这时候必须重置，否则会把上一个项目的设置写到这一个头上。
  await page.getByTestId("switch-project").click();
  await page.waitForFunction(() => {
    const box = [...document.querySelectorAll("label")]
      .find((l) => l.querySelector("span")?.textContent === "项目名称")?.querySelector("input");
    return box?.value === "第二个项目";
  });
  assert.equal(await preview.inputValue(), "", "换了项目还留着上一个的预览命令草稿");
  assert.equal(await repoPath.inputValue(), "/workspace/p-two", "换了项目要显示新项目的目录");

  console.log("project settings draft: ok");
} finally {
  await browser?.close();
  await server.close();
}
