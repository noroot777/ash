// 用户点了「检测本地智能体」、检测出 Codex 0.147.x 之后，Profile 组右上角那颗「新增」
// 必须跟着改口：不然点下去只会被服务端 409 打回一句「请先去点检测」——用户刚做完这件事，
// 界面又把他送回同一步，形成走不出去的死循环（自由工作流第 1 轮审查）。
//
// 三件事一起盯：
//   ① 没检测过时「新增」照常可点（用户没检测就不该在界面上看见版本判断）
//   ② 检测判 blocked 之后按钮 disabled 且改成「请先升级」，跟检测卡片那颗一个说法
//   ③ 门禁也落在提交函数里：绕过 disabled 直接触发也不会发出注册请求
//
// 跑法：npm -w web run test:agent-profile-add-gate
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  // 注册请求一律拦下并计数：这个测试要证明「压根没发出去」，不是「发出去被 409 拦了」。
  const registerAttempts = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    if (request.url().includes("/api/agents") && request.method() === "POST") {
      registerAttempts.push(request.postData() ?? "");
      return route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"blocked"}' });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/agent-profile-add-gate.html`);

  const add = page.locator(".agent-profile-group.is-codex .agent-profile-group-add");
  await add.waitFor();

  // ① 还没检测：照常可点，界面上一个字的版本判断都没有。
  assert.equal(await add.isDisabled(), false, "没检测过时不该禁用「新增」");
  assert.equal((await add.textContent())?.trim(), "新增");
  const bodyBefore = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(bodyBefore, /0\.147|请先升级|npm install/, "没检测就不能显示版本判断");

  // ② 用户亲手点检测，检测出 0.147.x。
  await page.getByRole("button", { name: "检测本地智能体" }).click();
  await page.locator(".settings-cli-version-warning").waitFor();
  assert.equal(await add.isDisabled(), true, "检测判 blocked 之后「新增」必须禁用");
  assert.equal((await add.textContent())?.trim(), "请先升级", "措辞要跟检测卡片那颗按钮一致");
  assert.equal(registerAttempts.length, 0, "到这一步一个注册请求都不该发出");

  // ③ 绕过 disabled 直接触发（键盘/程序化路径）：提交函数自己也得挡住。
  await add.evaluate((node) => node.click());
  await page.waitForTimeout(500);
  assert.equal(registerAttempts.length, 0, `门禁没落在提交函数里：${JSON.stringify(registerAttempts)}`);

  // 真被触发时给的是升级说明本身，不是「请先去检测」那句死循环指引。
  const notices = JSON.parse(await page.getByTestId("notices").textContent() ?? "[]");
  for (const notice of notices) {
    assert.doesNotMatch(notice, /检测本地智能体/, `检测之后不能再把用户送回检测：${notice}`);
  }

  console.log("agent profile add gate test passed");
} finally {
  await browser?.close();
  await server.close();
}
