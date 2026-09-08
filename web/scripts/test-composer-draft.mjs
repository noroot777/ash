import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 新建任务框是主工作区的一个内嵌状态：点一下侧栏的任务、开聊天、进设置，它就整个卸载。
// 这条钉住「写到一半去看一眼别的」不等于清空——正文、传好的图、还在传的图都得留着，
// 而且只在**创建成功**或用户自己按「清空草稿」时才丢。
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
      createdBodies.push(JSON.parse(request.postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "task-1",
          projectId: "p1",
          groupId: null,
          parentId: null,
          title: "写到一半的任务",
          body: "",
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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/composer-draft.html`);

  const objective = page.locator(".composer-objective textarea");
  const leave = page.getByRole("button", { name: "去别的页面", exact: true });
  const back = page.getByRole("button", { name: "回到新建任务", exact: true });
  await objective.waitFor();
  await objective.fill("写到一半的任务");

  // ① 图还在传的时候就走：回来它得还在传，而不是被悄悄扔掉。
  await paste("half.png")(page);
  await page.getByText("half.png", { exact: true }).waitFor();
  await leave.click();
  await objective.waitFor({ state: "detached" });
  await back.click();
  await objective.waitFor();
  assert.equal(await objective.inputValue(), "写到一半的任务", "回来时正文必须原样还在");
  assert.equal(
    await page.locator(".task-upload-chip.is-uploading").count(),
    1,
    "回来时在途的那张图必须还挂着",
  );

  // ② 传完之后再走一趟：正式附件同样留着，缩略图还能看。
  await release("half.png");
  await page.locator(".task-upload-chip img").waitFor();
  await leave.click();
  await objective.waitFor({ state: "detached" });
  await back.click();
  await objective.waitFor();
  assert.equal(await objective.inputValue(), "写到一半的任务", "第二趟回来正文仍要在");
  assert.equal(await page.locator(".task-upload-chip img").count(), 1, "传好的图必须跟着草稿留下来");
  assert.match(await page.locator(".studio-input-status").innerText(), /1 个附件/, "底栏附件计数要跟着草稿");

  // ③ 「清空草稿」是明写的丢弃口：按下去正文和附件一起没。
  await page.getByRole("button", { name: "清空草稿", exact: true }).click();
  assert.equal(await objective.inputValue(), "", "清空草稿要把正文清掉");
  assert.equal(await page.locator(".task-upload-chip").count(), 0, "清空草稿要把附件一起清掉");
  assert.equal(
    await page.getByRole("button", { name: "清空草稿", exact: true }).count(),
    0,
    "草稿空了就不该再留着清空入口",
  );

  // ④ 随手记转任务带进来的一份内容：并进草稿而不是把已写的顶掉，并且只并一次
  //    —— 面板重挂时按引用判重，不能每回来一趟就多拼一段。
  await objective.fill("我自己写的那句");
  await page.getByRole("button", { name: "随手记转任务", exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(
    await objective.inputValue(),
    "随手记带进来的内容\n\n我自己写的那句",
    "转进来的内容排在前面，已写的一个字都不能少",
  );
  assert.equal(await page.locator(".task-upload-chip").count(), 1, "随手记的附件要跟着进草稿");
  await leave.click();
  await objective.waitFor({ state: "detached" });
  await back.click();
  await objective.waitFor();
  assert.equal(
    await objective.inputValue(),
    "随手记带进来的内容\n\n我自己写的那句",
    "同一份种子不能因为面板重挂再并一遍",
  );
  assert.equal(await page.locator(".task-upload-chip").count(), 1, "附件同样不能重复并入");
  await page.getByRole("button", { name: "清空草稿", exact: true }).click();

  // ⑤ 创建成功才是另一个丢弃口：建完再开是干净的一张纸，不能把刚提交的那份又顶回来。
  await objective.fill("真的要建的任务");
  await paste("final.png")(page);
  await release("final.png");
  await page.locator(".task-upload-chip img").waitFor();
  await page.getByRole("button", { name: "创建并运行", exact: true }).click();
  await page.getByText("已创建：写到一半的任务").waitFor();
  assert.deepEqual(
    createdBodies.at(-1)?.attachments,
    ["/tmp/uploads/final.png"],
    "创建出去的任务必须带上草稿里那张图",
  );
  await back.click();
  await objective.waitFor();
  assert.equal(await objective.inputValue(), "", "创建成功后草稿必须清空");
  assert.equal(await page.locator(".task-upload-chip").count(), 0, "创建成功后附件也要清空");

  console.log("composer draft persistence test passed");
} finally {
  await browser?.close();
  await server.close();
}
