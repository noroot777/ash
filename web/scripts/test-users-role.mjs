// 多人模式下管理员能不能在「用户」这一屏改角色。跑：npm -w web run test:users-role
//
// 后端 `PATCH /api/users/:id` 一直收 role（`server/scripts/test-multi-user-setup.ts` ⑥ 钉着
// 它的「最后一个能登录进来的管理员不许降」），缺的只是这一屏上的入口。这条测试钉的是
// 入口这一侧的四条判据：
//   ① 每一行都有实例角色下拉，停用中的人也有（「先升成管理员再恢复」是正当路径）；
//   ② 升管理员要过一次确认 —— 交出的是管用户 + 任意路径 + 终端，不许下拉手滑就落地；
//   ③ 降别人是可撤销的，当场生效，不拦第二下；
//   ④ 把自己降下去要过确认，而且降完这一屏得自己关上：导航项没了、面板还挂着，而普通
//      成员拿到的 `GET /users` 是精简版，照原样渲染就是一屏空目录名。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/users-role.html`);

  const rows = page.locator(".users-row");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 4);

  const roleOf = (name) => page.getByRole("combobox", { name: `${name} 的实例角色` });

  // ① 每一行一个下拉，读的是这个人现在的角色。
  assert.equal(await page.locator(".users-role").count(), 4, "四行都该有实例角色下拉");
  assert.equal(await roleOf("阿岚").inputValue(), "admin");
  assert.equal(await roleOf("小蔡").inputValue(), "member");
  if (process.env.USERS_ROLE_SHOT) {
    await page.locator(".users-settings").screenshot({ path: process.env.USERS_ROLE_SHOT });
  }

  // ② 升管理员先确认，说清交出去的是什么；取消就什么都没发生。
  await roleOf("小蔡").selectOption("admin");
  const confirm = rows.filter({ hasText: "小蔡" }).locator(".users-confirm");
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /小蔡 将能管理所有用户、访问这台机器上的任意路径、开终端/);
  await confirm.getByRole("button", { name: "取消" }).click();
  await roleOf("小蔡").waitFor();
  assert.equal(await roleOf("小蔡").inputValue(), "member", "取消后角色不许动");

  await roleOf("小蔡").selectOption("admin");
  await rows.filter({ hasText: "小蔡" }).locator(".users-confirm").getByRole("button", { name: "确定" }).click();
  await page.locator(".users-row", { hasText: "小蔡" }).getByText("管理员", { exact: true }).waitFor();
  assert.equal(await roleOf("小蔡").inputValue(), "admin");
  assert.match(await page.getByTestId("notices").innerText(), /已升为实例管理员/);

  // ③ 降别人当场生效，不拦。
  await roleOf("小博").selectOption("member");
  await page.waitForFunction(
    () => /已降为普通成员/.test(document.querySelector('[data-testid="notices"]').textContent ?? ""),
  );
  assert.equal(await rows.filter({ hasText: "小博" }).locator(".users-confirm").count(), 0, "降别人不该弹确认");
  assert.equal(await roleOf("小博").inputValue(), "member");

  // ④ 把自己降下去要确认，而且降完这一屏自己关上。这时名单上还有「小蔡」这个真能
  //    登录的管理员，所以后端那道 409 让开，界面这一侧才轮得到检验。
  await roleOf("阿岚").selectOption("member");
  const selfConfirm = rows.filter({ hasText: "阿岚" }).locator(".users-confirm");
  await selfConfirm.waitFor();
  assert.match(await selfConfirm.innerText(), /降级后你立刻失去管理员权限，这一屏也随之关上/);
  await selfConfirm.getByRole("button", { name: "确定" }).click();

  const closed = page.locator(".settings-section", { hasText: "只有实例管理员能管用户" });
  await closed.waitFor();
  assert.equal(await page.locator(".users-row").count(), 0, "降完自己就不该再渲染那张管理名单");
  assert.equal(await page.locator(".users-role").count(), 0);

  console.log("[users-role] ok");
} finally {
  await browser?.close();
  await server.close();
}
