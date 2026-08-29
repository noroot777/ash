import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 远程访问 ash 时粘一张图，上传要走完整条链路（base64 过网 + 落盘），可能好几秒到十几秒。
// 这条钉住那段时间里界面必须说话：在途卡片 + 百分比 + 创建按钮先挡住（否则刚粘的图会被
// 悄悄扔掉，因为附件路径是上传成功才有的），以及取消不算失败。
const root = fileURLToPath(new URL("..", import.meta.url));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const paste = (name) => async (page) => page.evaluate(({ name, png }) => {
  const textarea = document.querySelector(".composer-objective textarea");
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], name, { type: "image/png" }));
  textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, { name, png: PNG });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  const createdBodies = [];
  // 上传一直吊着，直到测试自己放行——这就是「远程链路很慢」的那段时间。
  const held = new Map();
  const release = async (name) => {
    for (let i = 0; i < 100 && !held.has(name); i++) await page.waitForTimeout(50);
    held.get(name)?.();
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/uploads" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      const name = typeof body.name === "string" ? body.name : "pasted.png";
      await new Promise((resolve) => held.set(name, resolve));
      // 被取消的那个请求早就不在了，fulfill 会抛——那正是预期结果。
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: `up-${name}`,
          path: `/tmp/uploads/${name}`,
          url: `data:image/png;base64,${PNG}`,
          name,
          kind: "image",
        }),
      }).catch(() => {});
      return;
    }
    if (path === "/api/tasks" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      createdBodies.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "task-1",
          projectId: "p1",
          groupId: null,
          parentId: null,
          title: body.title ?? "未命名任务",
          body: body.body ?? "",
          mode: "single",
          status: "backlog",
          labels: [],
          dependsOn: [],
          resumeDependsOn: [],
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:00:00.000Z",
        }),
      });
      return;
    }
    if (path === "/api/agents") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "exec-claude", name: "claude@local", type: "claude", isDefault: true }]),
      });
      return;
    }
    if (path === "/api/settings") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ worktreeDefault: false, defaultWorkflowId: null }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/composer-upload.html`);

  const objective = page.locator(".composer-objective textarea");
  await objective.fill("把这张图上的问题修掉");
  const submit = page.getByRole("button", { name: "创建并运行" });
  await submit.waitFor();

  // ① 粘上去的那一刻就得有东西代表它，而且看得出在动。
  await paste("shot.png")(page);
  await page.getByText("shot.png", { exact: true }).waitFor();
  assert.equal(await page.locator(".task-upload-chip.is-uploading").count(), 1, "上传期间必须有一张在途卡片");
  assert.match(
    await page.locator(".task-upload-chip.is-uploading small").innerText(),
    /上传中 \d+%/,
    "在途卡片要写明进度百分比",
  );
  assert.match(await page.locator(".composer-footer span").first().innerText(), /上传中 \d+%/, "底栏也要说在传");
  assert.equal(await page.locator(".task-upload-chip img").count(), 0, "还没传完不该出现正式缩略图");

  // ② 传完之前不许创建：附件路径是上传成功才有的，这时候创建等于把刚粘的图扔了。
  assert.equal(await submit.isDisabled(), true, "上传未完成时创建按钮必须禁用");
  await objective.press("Control+Enter");
  await page.waitForTimeout(300);
  assert.equal(createdBodies.length, 0, "快捷键也不能绕过上传中的门禁");

  // ③ 传完原地换成正式附件，按钮恢复。
  await release("shot.png");
  await page.locator(".task-upload-chip img").waitFor();
  assert.equal(await page.locator(".task-upload-chip.is-uploading").count(), 0, "传完不该再留在途卡片");
  assert.match(await page.locator(".composer-footer span").first().innerText(), /1 个附件/, "传完底栏回到附件计数");
  assert.equal(await submit.isEnabled(), true, "传完必须能创建");

  // ④ 传到一半反悔：取消掉在途的那个，既不留卡片也不报错，已经传好的不受影响。
  await paste("wrong.png")(page);
  await page.getByText("wrong.png", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消上传 wrong.png" }).click();
  await page.getByText("wrong.png", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.locator(".task-upload-error").count(), 0, "用户自己取消的不算上传失败");
  assert.equal(await submit.isEnabled(), true, "取消后应立刻恢复可创建");
  await release("wrong.png");

  await submit.click();
  await page.getByText("已创建：把这张图上的问题修掉").waitFor();
  assert.deepEqual(
    createdBodies.at(-1)?.attachments,
    ["/tmp/uploads/shot.png"],
    "创建出去的任务必须带上传好的附件、且不带被取消的那张",
  );

  console.log("composer upload progress test passed");
} finally {
  await browser?.close();
  await server.close();
}
