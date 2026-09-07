// 对话框底部那颗胶囊的**归属**回归：点它改的是「这个任务以后都用谁」（写回任务），
// 而正文里 `@` 召唤仍然只作用于一次。两者在同一颗胶囊上，回归价值全在这条分界线：
// 一旦哪次重构把胶囊改回一次性，用户就又得每发一句重选一遍执行器。
//
// 第二段钉的是写回的**并发**：胶囊本来就会连着提交两次（选完智能体自动向右展开模型
// 段），两份完整配置的 PATCH 一旦并发，先发后到的那份会把数据库盖回旧配置，而界面还
// 留着新的乐观值 —— 胶囊写着新模型、实际跑的是旧的。
// 跑法：npm -w web run test:reply-standing-executor
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
  // 两个已注册执行器（胶囊的候选来自它们），其余接口在这个 fixture 里不参与判定。
  const PROFILES = [
    { id: "profile-codex", name: "codex@local", type: "codex", isDefault: true },
    { id: "profile-claude", name: "claude@local", type: "claude", isDefault: true },
  ];
  const fixture = async (query = "") => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: path.endsWith("/agents") ? JSON.stringify(PROFILES) : "[]",
      });
    });
    await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/reply-standing-executor.html${query}`);
    return page;
  };

  {
    const page = await fixture();
    const agentTrigger = page.getByRole("button", { name: /智能体：/ });
    const textarea = page.getByRole("textbox", { name: "回复任务" });
    const sendButton = page.getByRole("button", { name: "发送回复" });
    const logLines = async () => page.locator("#log li").allTextContents();

    await agentTrigger.waitFor();
    assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：codex/);

    // ① 点胶囊换智能体 = 改任务常设配置，立刻写回。
    await agentTrigger.click();
    await page.getByRole("option", { name: /@claude/ }).click();
    await page.keyboard.press("Escape"); // 选完智能体会自动向右展开模型段，这里不选模型
    await page.locator("#log li").nth(1).waitFor();
    assert.deepEqual(await logLines(), [
      "start1:claude|model=-|effort=-",
      "done1:claude|model=-|effort=-",
    ]);
    assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：claude/);

    // ② 之后发送的每一条都跟着走：请求里不带一次性覆盖，服务端读任务字段即可。
    await textarea.fill("第一句");
    await sendButton.click();
    await page.locator("#log li").nth(2).waitFor();
    assert.deepEqual((await logLines()).slice(2), ["send:第一句|task=claude/-|override=-/-/-"]);
    // 发完不回弹：胶囊上还是刚选的那个，不必为下一句再选一次。
    assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：claude/);

    // ③ 正文里 `@` 召唤仍是一次性：随这一句发出，发完退回常设配置。
    await textarea.fill("第二句 @codex");
    await page.getByRole("option", { name: /@codex/ }).click();
    await page.getByRole("option", { name: /^gpt-5\.6-sol/ }).click();
    assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：codex/);
    await sendButton.click();
    await page.locator("#log li").nth(3).waitFor();
    assert.deepEqual((await logLines()).slice(3), [
      // 任务常设仍是 claude，codex 只压在这一句上。
      "send:第二句|task=claude/-|override=codex/gpt-5.6-sol/-",
    ]);
    assert.match(
      await agentTrigger.getAttribute("aria-label") ?? "",
      /智能体：claude/,
      "一次性召唤发完应退回任务常设配置，不能把 @ 的那次写成常设",
    );
    await page.close();
  }

  // ④ 连着改两次（智能体 → 紧接着模型），第一次写回故意慢 1200ms。
  {
    const page = await fixture("?slow=1");
    const agentTrigger = page.getByRole("button", { name: /智能体：/ });
    const modelTrigger = page.getByRole("button", { name: /模型：/ });

    await agentTrigger.click();
    await page.getByRole("option", { name: /@claude/ }).click();
    // 不等第一次写回落地就选模型 —— 胶囊自动展开模型段，用户本来就是这么连着点的。
    await page.getByRole("option", { name: /^sonnet/ }).click();
    await page.locator("#log li").nth(3).waitFor({ timeout: 15_000 });

    // 串行：第二份等第一份结算完才发。并发的话 start2 会挤在 done1 前面，而后到的
    // done1 会把任务配置盖回「claude 无模型」。
    assert.deepEqual(await page.locator("#log li").allTextContents(), [
      "start1:claude|model=-|effort=-",
      "done1:claude|model=-|effort=-",
      "start2:claude|model=sonnet|effort=-",
      "done2:claude|model=sonnet|effort=-",
    ]);
    // 最终落库的是最后一次选择，界面与它一致。
    assert.equal(
      await page.locator("#task-config").textContent(),
      "task:claude|model=sonnet|effort=-",
    );
    assert.match(await modelTrigger.getAttribute("aria-label") ?? "", /模型：sonnet/);
    await page.close();
  }

  // ⑤ 改完执行器**立刻**发送：写回还在飞时发出去，服务端读到的仍是旧执行器，用户
  //    等于改了个寂寞。发送要等写回落地。
  {
    const page = await fixture("?slow=1");
    const agentTrigger = page.getByRole("button", { name: /智能体：/ });

    await agentTrigger.click();
    await page.getByRole("option", { name: /@claude/ }).click();
    await page.keyboard.press("Escape");
    // 不等 done1，直接发。
    await page.getByRole("textbox", { name: "回复任务" }).fill("立即发送");
    await page.getByRole("button", { name: "发送回复" }).click();
    await page.locator("#log li").nth(2).waitFor({ timeout: 15_000 });

    assert.deepEqual(await page.locator("#log li").allTextContents(), [
      "start1:claude|model=-|effort=-",
      "done1:claude|model=-|effort=-",
      // 关键：send 排在 done1 之后，且此刻任务字段已经是 claude（不是旧的 codex）。
      "send:立即发送|task=claude/-|override=-/-/-",
    ]);
    await page.close();
  }

  // ⑥ 写回失败：不能静默按旧配置发出去，得把这一句拦下来并说清楚。
  {
    const page = await fixture("?fail=1");
    const agentTrigger = page.getByRole("button", { name: /智能体：/ });

    await agentTrigger.click();
    await page.getByRole("option", { name: /@claude/ }).click();
    await page.keyboard.press("Escape");
    await page.locator("#log li").nth(1).waitFor();

    await page.getByRole("textbox", { name: "回复任务" }).fill("失败后不该发");
    await page.getByRole("button", { name: "发送回复" }).click();
    await page.locator(".task-reply-error").waitFor();
    assert.match(await page.locator(".task-reply-error").textContent() ?? "", /没能改过去/);
    assert.deepEqual(
      await page.locator("#log li").allTextContents(),
      ["start1:claude|model=-|effort=-", "fail1:claude|model=-|effort=-"],
      "写回失败后不能再有 send —— 那会按旧执行器跑",
    );
    // 胶囊退回任务真实字段，不拿一份没写成的乐观值糊着；正文原样留着可以重发。
    assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：codex/);
    assert.equal(await page.getByRole("textbox", { name: "回复任务" }).inputValue(), "失败后不该发");
    await page.close();
  }

  console.log("reply standing executor test passed");
} finally {
  await browser?.close();
  await server.close();
}
