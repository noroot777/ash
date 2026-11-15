// 侧栏里派出的任务收在派它的那条下面（真浏览器）。模型层的判据在 test-dispatch-tree.mjs。
//
// 钉的是这几件事：
//   · 默认收着：行首箭头、行尾一个数；名下有在等答复的，数变琥珀色。
//   · 展开记在本机，刷新后还开着。
//   · 派它的那条不在列表里（归档了），派出的任务照常平铺，不跟着消失。
//   · 搜索命中一条收着的任务（= 选中它）时，它上面那几层自己打开，看得见它。
//   · 新派出去的任务不刷新就收进来。
//   · 团队和它的执行者照旧：执行者不平铺，团队行的箭头照旧展开执行者。
// 跑：npm -w web run test:dispatch-tree-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${web.origin}/scripts/fixtures/dispatch-tree.html`);

  // 行按任务 id 找（data-task-id 是侧栏每一行的身份，J/K 也认它）。
  const row = (id) => page.locator(`.workspace-task-tree [data-task-id="${id}"]`);
  const lead = row("lead");
  const caret = page.getByRole("button", { name: /^展开 3 个派出的任务/ });
  await lead.waitFor();

  // —— 默认收着。
  for (const id of ["kid-run", "kid-ask", "kid-mid", "grand"]) {
    assert.equal(await row(id).count(), 0, `${id} 默认收在派它的那条下面`);
  }
  assert.equal(await caret.count(), 1, "行首那颗箭头说得出名下几个、有要你处理的");
  assert.match(await caret.getAttribute("aria-label"), /有要你处理的/);
  const count = lead.locator(".workspace-dispatch-count");
  assert.equal(await count.textContent(), "3");
  assert.ok(await count.evaluate((node) => node.classList.contains("is-warn")), "名下在等答复，那个数变色");
  const color = (locator) => locator.evaluate((node) => getComputedStyle(node).color);
  // 琥珀取的是现有变量：拿同一个变量在页面上解析出来的颜色比。
  const amber = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--amber)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  assert.equal(await color(count), amber, "名下有要你处理的，那个数是琥珀色");

  // —— 派它的那条归档了：照常平铺。
  assert.equal(await row("orphan").count(), 1, "派它的那条不在列表里时，派出的任务不能跟着消失");
  assert.equal(await page.getByRole("button", { name: "派它的任务：已经归档的派活人" }).count(), 1, "平铺的那条照旧写着是谁派的");

  // —— 团队照旧：执行者不平铺，团队行自己的箭头展开执行者。
  assert.equal(await row("worker").count(), 0, "执行者照旧收在团队下面");
  await page.getByRole("button", { name: "展开 1 个执行者" }).click();
  await page.locator('.workspace-worker-list [data-task-id="worker"]').waitFor();
  assert.equal(await page.locator(".workspace-worker-list .workspace-dispatch-count").count(), 0, "团队行不长出派活那一层");

  // —— 展开：名下三条出来，孙辈仍收在它自己那一层下面。
  await caret.click();
  await row("kid-run").waitFor();
  assert.equal(await row("kid-ask").count(), 1);
  assert.equal(await row("kid-mid").locator(".workspace-dispatch-count").textContent(), "1", "派出去的任务自己又派了活，同样收在它自己下面");
  assert.equal(await row("grand").count(), 0);
  assert.notEqual(await color(row("kid-mid").locator(".workspace-dispatch-count")), amber, "名下没有要你处理的，那个数不带颜色");
  assert.equal(
    await page.locator('[role="group"][aria-label="拆活的分析任务 派出的任务"] [data-task-id]').count(),
    3,
    "名下那一组只有直接派出的三条",
  );

  // —— 刷新后还开着。
  await page.reload();
  await row("kid-run").waitFor();
  assert.equal(await page.getByRole("button", { name: /^收起 3 个派出的任务/ }).getAttribute("aria-expanded"), "true", "展开记在本机，刷新后还开着");

  // —— 收起之后，搜索命中孙辈（= 选中它）：两层都自己打开。
  await page.getByRole("button", { name: /^收起 3 个派出的任务/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-task-id="kid-run"]'));
  await page.evaluate(() => window.__select("grand"));
  await row("grand").waitFor();
  assert.equal(await row("grand").getAttribute("aria-selected"), "true", "搜索命中收着的那条：它上面那几层自己打开，看得见它");
  assert.equal(await row("kid-run").count(), 1);

  // —— 新派出去的任务不刷新就收进来，数跟着变。
  await page.evaluate(() => window.__add({ id: "kid-new", title: "刚派出去的", dispatchedBy: "lead", status: "queued", stage: null }));
  await row("kid-new").waitFor();
  assert.equal(await page.locator('[data-task-id="lead"] .workspace-dispatch-count').textContent(), "4");

  // —— 等答复的那条答完了、名下再没有要你处理的：数回到不带颜色。
  await page.evaluate(() => window.__patch("kid-ask", { question: null, status: "running" }));
  await page.waitForFunction(() => !document.querySelector('[data-task-id="lead"] .workspace-dispatch-count')?.classList.contains("is-warn"));

  // —— 派它的那条一归档，名下照常平铺（归档派它的那条不等于归档名下的）。
  await page.evaluate(() => window.__patch("lead", { archived: true }));
  await page.waitForFunction(() => !document.querySelector('[data-task-id="lead"]'));
  for (const id of ["kid-run", "kid-mid"]) {
    assert.equal(await row(id).count(), 1, `${id} 回到顶层`);
    assert.equal(await page.locator(`.workspace-dispatch-list > * [data-task-id="${id}"], .workspace-dispatch-list > [data-task-id="${id}"]`).count(), 0, `${id} 不再缩在别人底下`);
  }
  // 孙辈仍收在它自己那一条（kid-mid）下面：只是最顶上那一层没了。
  assert.equal(await row("kid-mid").locator(".workspace-dispatch-count").textContent(), "1");

  await context.close();
  console.log("✓ 侧栏：派出的任务收在派它的那条下面");
} finally {
  await browser?.close();
  await web.close();
}
