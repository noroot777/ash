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

  // ⑤/⑥ 第 1 轮审查 P2：`PATCH` 一成功，后端下一次 `GET /users` 就按普通成员回精简版
  //     （只有 id/name/role），而这一屏要等 auth state 刷回来才知道自己已经不是管理员。
  //     中间那一拍要是把精简版渲染出来，就是一张目录名全空、却照样摆着「发邀请链接 /
  //     停用 / 角色下拉」的假管理表。两档分开钉，因为它们坏在不同地方：
  //       ⑤ auth 刷得慢 → 顺序问题，假表一闪而过；
  //       ⑥ auth 刷不回来 → 顺序救不了，假表**一直**留在屏幕上，只有判形状拦得住。
  //     一闪而过那一帧靠轮询抓不着，用 MutationObserver 盯每一次提交的 DOM。

  // ⑤ auth state 慢半拍刷回来。
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/users-role.html?slowRefresh=500`);
  await page.locator(".users-row").first().waitFor();
  await watchForSlimRows(page);
  await selfDemote(page, rows, roleOf);
  await closed.waitFor();
  assert.equal(await slimRowsSeen(page), 0, "auth 刷回来之前，一帧都不许拿精简名单渲染管理表");

  // ⑥ auth state 刷不回来。
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/users-role.html?failRefresh=1`);
  await page.locator(".users-row").first().waitFor();
  await watchForSlimRows(page);
  await selfDemote(page, rows, roleOf);
  // 修好之前/之后都会落两条提示，所以等条数而不是等某一句——否则这里挂成 30 秒超时，
  // 底下那几条更说明问题的断言反倒跑不到。
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="notices"]').textContent).length >= 2);

  const notices = await page.getByTestId("notices").innerText();
  assert.match(notices, /已降为普通成员/, "降级本身是成功的，得照实说");
  assert.doesNotMatch(notices, /操作失败/, "善后步骤失败不许把已经成功的动作说成失败");
  assert.match(notices, /账号状态没刷新出来/, "刷不回来要明说，别让人对着一张已失效的名单继续点");
  assert.equal(await slimRowsSeen(page), 0, "刷不回来也不许把精简名单写进管理表");
  const dirs = await page.locator(".users-row-meta code").allInnerTexts();
  assert.equal(dirs.length, 4, "退守到上一份完整名单，而不是精简版");
  assert.ok(dirs.every((d) => d.trim()), `每一行的目录名都该还在：${JSON.stringify(dirs)}`);

  console.log("[users-role] ok");
} finally {
  await browser?.close();
  await server.close();
}

/** 把「阿岚」（也就是当前这个会话自己）降成普通成员，走完那道确认。 */
async function selfDemote(page, rows, roleOf) {
  await roleOf("阿岚").selectOption("member");
  const confirm = rows.filter({ hasText: "阿岚" }).locator(".users-confirm");
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "确定" }).click();
}

/** 从这一刻起，盯住每一次 DOM 提交里有没有「目录名是空的」那种行。 */
async function watchForSlimRows(page) {
  await page.evaluate(() => {
    window.__slimRows = 0;
    const scan = () => {
      for (const code of document.querySelectorAll(".users-row-meta code")) {
        if (!code.textContent?.trim()) window.__slimRows += 1;
      }
    };
    window.__slimObserver?.disconnect();
    window.__slimObserver = new MutationObserver(scan);
    window.__slimObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    scan();
  });
}

function slimRowsSeen(page) {
  return page.evaluate(() => window.__slimRows);
}