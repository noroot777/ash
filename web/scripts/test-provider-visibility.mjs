// 没有执行器挂它的供应商,在「选模型」那一步必须整块不出现。
//
// 2026-10-31：加完供应商还没建执行器,新建任务的模型列表里就已经列着这家,选了之后
// 任务起不来 —— 落下的是 `executorId: null`,起跑时解析到的是该类型默认执行器(官方
// 账号),拿着中转家的模型名去官方端点上撞。所以这里钉两件事:没人挂的那家一个候选都
// 没有;列出来的每一个模型都带着一条真实的执行器 id。
//
// 跑法：npm -w web run test:provider-visibility
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { assertCardsFit, findCardBleed } from "./settings-card-fit.mjs";
import { createServer } from "vite";

const provider = (id, name, pinnedModels) => ({
  id,
  name,
  protocol: "anthropic",
  baseUrl: `https://${id}.example.com`,
  model: pinnedModels[0],
  protocolConversionEnabled: false,
  modelListMode: "pinned",
  pinnedModels,
  context1mModels: [],
  hasKey: true,
  createdAt: new Date().toISOString(),
});

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
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.route("**/api/llm-providers", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([
      provider("p-mounted", "已挂中转", ["relay-opus", "relay-sonnet"]),
      provider("p-orphan", "没人挂的中转", ["orphan-opus"]),
    ]),
  }));
  // CLI 那一块的候选必须喂固定的:这条端点会现问本机 claude,不 mock 等于把断言钉在
  // 跑测试那台机器的 CLI 版本上。
  await page.route("**/api/agents/models*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      type: "claude",
      models: ["官方别名-opus"],
      defaultModel: "官方别名-opus",
      source: "probe",
      probeSupported: true,
      available: true,
      probedAt: new Date().toISOString(),
      cliVersion: "claude (test fixture)",
      error: null,
      skipped: null,
    }]),
  }));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/provider-visibility.html`);

  const modelTrigger = page.getByRole("button", { name: /模型：/ });
  await modelTrigger.click();
  const panel = page.locator(".agent-model-picker");
  await panel.waitFor();
  // 等供应商清单到货再数分块:在它回来之前 p-mounted 还查不到,那一块本来就不画。
  await page.getByRole("option", { name: "relay-sonnet", exact: true }).waitFor();
  await page.getByRole("option", { name: /官方别名-opus/ }).waitFor();

  // 分块只有「有执行器挂着」的那些:CLI 官方账号(claude@官方)+ 已挂中转(claude@已挂中转)。
  const headers = await panel.locator("section header b").allTextContents();
  assert.deepEqual(headers, ["CLI 官方账号", "已挂中转"], `分块应只剩有人挂的那些，实际：${headers.join(" / ")}`);
  assert.equal(
    await page.getByRole("option", { name: /orphan-opus/ }).count(),
    0,
    "没人挂的供应商不许贡献任何模型候选",
  );

  // 列出来的每一个候选都必须带着一条真实的执行器 —— 否则起跑时会被解析到别家去。
  await page.getByRole("option", { name: "relay-sonnet", exact: true }).click();
  const picked = JSON.parse(await page.getByTestId("draft").textContent() ?? "{}");
  assert.deepEqual(picked, { executorId: "claude-relay", model: "relay-sonnet" });

  // 筛选框也不该把它翻出来:筛的是同一份分块,不是另一条路。
  await modelTrigger.click();
  await page.getByPlaceholder("筛选 claude 的模型…").fill("orphan");
  assert.match(await panel.textContent() ?? "", /没有匹配的模型/);

  // ② 另一半:选不到它这件事,供应商页面要当面说,并且就在那儿给出去处。
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/provider-mount-state.html`);
  const row = (name) => page.locator(".provider-row").filter({ hasText: name });
  await row("已挂中转").first().waitFor();
  assert.match(await row("已挂中转").first().textContent() ?? "", /1 个执行器在用/);
  const orphanRow = row("没人挂的中转");
  const orphanHint = orphanRow.getByRole("button", { name: /还没有执行器挂它/ });
  assert.equal(await orphanHint.count(), 1, "没人挂的那行要说出「未挂到执行器」并给出去处");
  assert.match(await orphanHint.textContent() ?? "", /未挂到执行器/);
  await orphanHint.click();
  assert.equal((await page.getByTestId("jumps").textContent() ?? "").trim(), "1", "点它应跳到执行器设置");

  // 状态列从一颗药丸变成两颗,窄下来时不许把这一行顶出卡片(判据同设置卡片体检)。
  await assertCardsFit(page, [1440, 1180, 1000, 900, 820, 700, 620], "供应商列表");

  // 真正危险的是**视口还很宽、卡片已经很窄**那一段:设置页的卡片宽度由侧栏吃掉一大块,
  // 视口 1000 时卡片只有 700 出头,而按视口写的那两个断点(900 / 680)在这一档还没生效。
  // 所以这里按视口写不出来,直接把卡片本身掐窄:两颗药丸必须自己换行,不许顶穿。
  await page.setViewportSize({ width: 1280, height: 700 });
  for (const cardWidth of [760, 700, 660, 620, 560]) {
    await page.locator("main.settings-main").evaluate((main, width) => {
      main.style.width = `${width}px`;
    }, cardWidth);
    await page.waitForTimeout(80);
    // 顶穿的先是那两颗图标按钮(删除/编辑)而不是文字,所以这里量几何而不是量字:
    // 文字体检(findCardBleed)只走文本节点,一个只长图标的按钮被挤出去它是看不见的。
    const overflow = await page.locator(".provider-row").evaluateAll((rows) =>
      rows.map((row) => row.scrollWidth - row.clientWidth));
    assert.ok(
      overflow.every((value) => value <= 1),
      `卡片 ${cardWidth}px 宽时供应商行顶穿了 ${Math.max(...overflow)}px（状态列该换行而不是撑开）`,
    );
    const findings = await findCardBleed(page);
    assert.equal(findings.length, 0, `卡片 ${cardWidth}px 宽时有文字穿出：${JSON.stringify(findings)}`);
  }
  await page.locator("main.settings-main").evaluate((main) => { main.style.width = ""; });
  await page.setViewportSize({ width: 900, height: 700 });

  // ③ 两份数据各自成败:读到的供应商不许被另一个接口的失败一起否决。
  //    (审查第 1 轮实测:/agents 一个 503,已加的供应商全没了,页面却说「还没有供应商」)
  const settingsPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let agentsStatus = 503;
  let agentsDelayMs = 0;
  await settingsPage.route("**/api/llm-providers", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([provider("p-mounted", "已挂中转", ["relay-opus"]), provider("p-orphan", "没人挂的中转", ["orphan-opus"])]),
  }));
  await settingsPage.route("**/api/agents", async (route) => {
    if (agentsDelayMs) await new Promise((resolve) => setTimeout(resolve, agentsDelayMs));
    if (agentsStatus !== 200) {
      await route.fulfill({ status: agentsStatus, contentType: "application/json", body: JSON.stringify({ error: "模拟：执行器列表暂时不可用" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "claude-relay", name: "claude@已挂中转", type: "claude", providerId: "p-mounted", isDefault: true }]),
    });
  });
  await settingsPage.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/providers-settings-load.html`);

  await settingsPage.locator(".provider-row").first().waitFor();
  assert.equal(await settingsPage.locator(".provider-row").count(), 2, "读到的两家供应商不许因为 /agents 失败而消失");
  const settingsText = async () => await settingsPage.locator(".providers-card").textContent() ?? "";
  assert.doesNotMatch(await settingsText(), /还没有供应商/, "读成功了就不许说「还没有供应商」");
  assert.match(await settingsText(), /执行器清单读取失败/, "挂载情况不知道,要在卡片上说一次");
  assert.equal(
    await settingsPage.getByRole("button", { name: /还没有执行器挂它/ }).count(),
    0,
    "挂载情况未知时不许断言「未挂到执行器」",
  );
  // 未知时删除确认也不许编造后果。
  await settingsPage.getByRole("button", { name: "删除 没人挂的中转" }).click();
  assert.match(await settingsPage.locator(".confirm-dialog, [role=dialog]").textContent() ?? "", /挂着它的执行器会退回 CLI 官方账号/);
  await settingsPage.getByRole("button", { name: "取消" }).first().click();

  // 重试:这一次 /agents 好了,每行的挂载情况当场补上。
  agentsStatus = 200;
  await settingsPage.getByRole("button", { name: "重试" }).click();
  await settingsPage.getByRole("button", { name: /还没有执行器挂它/ }).waitFor();
  assert.match(await settingsText(), /1 个执行器在用/);
  assert.doesNotMatch(await settingsText(), /执行器清单读取失败/);

  // /agents 慢,也不许把整张卡一起拖在「读取中…」。
  agentsStatus = 200;
  agentsDelayMs = 2000;
  await settingsPage.reload();
  await settingsPage.locator(".provider-row").first().waitFor({ timeout: 1500 });
  assert.equal(await settingsPage.locator(".provider-row").count(), 2);
  agentsDelayMs = 0;

  // 反过来:主体读不到时,说的是「读取失败」而不是「一个都没有」。
  await settingsPage.unroute("**/api/llm-providers");
  await settingsPage.route("**/api/llm-providers", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "模拟：供应商列表暂时不可用" }),
  }));
  await settingsPage.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/providers-settings-load.html`);
  await settingsPage.getByText(/供应商列表读取失败/).waitFor();
  assert.doesNotMatch(await settingsPage.locator(".settings-section").textContent() ?? "", /还没有供应商/);
  assert.match(await settingsPage.getByTestId("notices").textContent() ?? "", /供应商列表暂时不可用/);
  await settingsPage.close();

  console.log("provider visibility test passed");
} finally {
  await browser?.close();
  await server.close();
}
