// 多人模式下「新建项目」两条路的工作目录都锁前缀。跑：npm -w web run test:create-project-scope
//
// 钉的是四条判据：
//   ① 本地目录那条路：前缀是这个人的目录 + 服务端的分隔符，且**不在输入框里** ——
//      在输入框里就等于能删，而删掉之后打出去的路径服务端一律 403；
//   ② 项目名 → 目录名自动跟随，手动改过目录名之后名字不再倒灌回去；
//   ③ 从 Git 检出那条路同样锁前缀，目录名同样跟着项目名走；
//   ④ 普通成员没有「用其它路径…」（那是一条必然 403 的死路），实例管理员有，
//      点开之后退回自由输入的完整路径框（服务端不钳他，界面不该更严）。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const HOME = "/srv/ash-root/xiaocai";
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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/create-project-scope.html`);

  const dialog = page.locator(".create-project-dialog");
  await dialog.waitFor();

  const scoped = dialog.locator(".path-scoped");
  const scopedInput = scoped.locator("input");
  const nameInput = dialog.locator("label", { hasText: "项目名称" }).locator("input");

  // ① 前缀在框里看得见，但它不是 input 的值。
  await scoped.waitFor();
  assert.equal(await scoped.locator("code").innerText(), `${HOME}/`, "前缀要按服务端的分隔符拼出这个人的目录");
  assert.equal(await scopedInput.inputValue(), "", "前缀不许进输入框——进了就删得掉");
  assert.equal(
    await dialog.locator(".path-field > input").count(),
    0,
    "锁前缀那一档不该同时还留着一个自由填完整路径的输入框",
  );
  // 边框画在外层，里面那个 input 得脱掉自己那一圈，否则是「框里套框」。
  const frame = await scoped.evaluate((box) => {
    const inner = getComputedStyle(box.querySelector("input"));
    return { outer: getComputedStyle(box).borderTopWidth, inner: inner.borderTopWidth };
  });
  assert.equal(frame.inner, "0px", `锁前缀的输入框不该自带边框：${JSON.stringify(frame)}`);
  assert.notEqual(frame.outer, "0px", "外层要画出输入框的边");

  // ② 项目名 → 目录名，并给出完整路径。
  await nameInput.fill("asd");
  await page.waitForFunction(() => document.querySelector(".path-scoped input").value === "asd");
  assert.match(await dialog.locator(".create-project-target").innerText(), new RegExp(`${HOME}/asd`));
  // 版式自己看一眼时用：CREATE_PROJECT_SHOT=/tmp/x.png npm -w web run test:create-project-scope
  if (process.env.CREATE_PROJECT_SHOT) await dialog.screenshot({ path: process.env.CREATE_PROJECT_SHOT });

  // 名字里的路径分隔符不许穿透成第二层目录。
  await nameInput.fill("a/b");
  await page.waitForFunction(() => document.querySelector(".path-scoped input").value === "a-b");

  // 手动改过目录名之后，名字不再倒灌。
  await scopedInput.fill("my-dir");
  await nameInput.fill("另一个名字");
  assert.equal(await scopedInput.inputValue(), "my-dir", "手动填过的目录名不许再被项目名覆盖");

  // ③ 从 Git 检出那条路同样锁前缀。
  await dialog.getByRole("button", { name: /从 Git 检出/ }).click();
  const parent = dialog.locator("label", { hasText: "克隆到（上级目录）" }).locator(".path-scoped");
  await parent.waitFor();
  assert.equal(await parent.locator("code").innerText(), `${HOME}/`);
  assert.equal(await parent.locator("input").inputValue(), "", "上级目录留空 = 直接放在自己的目录下");

  const folder = dialog.locator("label", { hasText: "目录名" }).locator("input");
  await nameInput.fill("clone-me");
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll(".quick-create-fields label")];
    const box = labels.find((l) => l.querySelector("span")?.textContent === "目录名")?.querySelector("input");
    return box?.value === "clone-me";
  });
  await parent.locator("input").fill("code");
  await page.waitForFunction(
    (home) => document.querySelector(".create-project-target code")?.textContent === `${home}/code/clone-me`,
    HOME,
  );
  assert.equal(await folder.inputValue(), "clone-me");
  if (process.env.CREATE_PROJECT_CLONE_SHOT) {
    await dialog.screenshot({ path: process.env.CREATE_PROJECT_CLONE_SHOT });
  }

  // ④ 普通成员没有出口；管理员有，而且点开之后是自由填完整路径。
  assert.equal(await dialog.getByRole("button", { name: "用其它路径…" }).count(), 0, "普通成员不该看到跳出目录的开关");

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/create-project-scope.html?role=admin`);
  await dialog.locator(".path-scoped").waitFor();
  assert.equal(
    await dialog.locator(".path-scoped code").innerText(),
    `${HOME}/`,
    "管理员默认也落在自己的目录里",
  );
  await nameInput.fill("abc");
  await page.waitForFunction(() => document.querySelector(".path-scoped input").value === "abc");
  if (process.env.CREATE_PROJECT_ADMIN_SHOT) {
    await dialog.screenshot({ path: process.env.CREATE_PROJECT_ADMIN_SHOT });
  }

  await dialog.getByRole("button", { name: "用其它路径…" }).click();
  const freeInput = dialog.locator(".path-field > input").first();
  await freeInput.waitFor();
  assert.equal(await dialog.locator(".path-scoped").count(), 0, "管理员点开出口之后应换成自由输入的完整路径框");
  assert.equal(await freeInput.inputValue(), `${HOME}/abc`, "跳出去要带着已经填好的那条路径，别让人重打一遍");

  // 跳到目录之外再跳回来：外面那条路径回不去，锁前缀那侧应原样保留自己的那一截。
  await freeInput.fill("/opt/elsewhere");
  await dialog.getByRole("button", { name: "回到我的目录" }).click();
  await dialog.locator(".path-scoped").waitFor();
  assert.equal(await dialog.locator(".path-scoped input").inputValue(), "abc");

  console.log("create-project scope: ok");
} finally {
  await browser?.close();
  await server.close();
}
