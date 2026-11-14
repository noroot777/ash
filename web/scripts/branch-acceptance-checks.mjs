import { acceptanceDesk, changeTarget, checkBaseUpdateRecovery } from "./base-update-recovery-checks.mjs";

export async function checkBranchAcceptance(page, fixtureUrl, checkpoint = async () => {}) {
  const d = acceptanceDesk(page, fixtureUrl);
  const { ensure, desk, row, main, idle, go, detail, button, notice, dialog } = d;
  const output = name => page.locator(`output[aria-label="${name}"]`);
  const inspector = () => page.getByRole("region", { name: "工作流侧栏入口", exact: true });
  // 按标题认派生任务那一行：别的行的父任务说明里也会提到这个名字。
  const child = title => row("child").filter({ has: page.locator(".acc-check-text").getByText(title, { exact: true }) });
  const childBox = title => child(title).getByRole("checkbox");
  const release = () => button(row("release"), "释放目录");
  const releaseDialog = page.getByRole("dialog", { name: "释放工作区目录？", exact: true });
  const blocked = async reason => { await idle(); ensure(!await main.isEnabled(), reason); };
  const open = async reason => { await idle(); ensure(await main.isEnabled(), reason); };
  const posts = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });

  for (const [task, reason] of [["case1-unstarted", "任务分支不存在或已清理"], ["case1-badstart", "无法读取任务的开工提交"]]) {
    await go(task);
    await page.getByText(`当前无法生成分支 diff：${reason}。`, { exact: true }).waitFor({ state: "visible" });
    await page.getByText(`无法生成分支 diff：${reason}`, { exact: true }).waitFor({ state: "visible" });
    ensure(!/accepted_snapshot_unreadable|source_branch_missing|start_commit_unreadable/.test(await page.locator("main").innerText()), "internal diff reason leaked to UI");
  }
  await go("case6-parent");
  await child("case6-child").filter({ hasText: /目标分支 ash\/case6-pa 仍在工作区/ }).waitFor({ state: "visible" });
  ensure(!await childBox("case6-child").isEnabled(), "occupied legacy merge target must block selection");
  await blocked("legacy child must not be merged after its parent");
  ensure(await desk.getByRole("link", { name: "看改动", exact: true }).count() === 1, "legacy child has no navigation entry");
  await go("case6-child");
  await row("parent", "旧任务仍合入父分支").waitFor({ state: "visible" });
  ensure(await desk.getByRole("link", { name: "查看父任务", exact: true }).count() === 1, "legacy child has no parent link");

  await go("case8-parent");
  await release().waitFor({ state: "visible" });
  ensure(!await release().isEnabled(), "running parent release must be disabled");
  await go("case7-parent");
  await release().click();
  await button(releaseDialog, "释放目录，保留分支").click();
  await releaseDialog.getByRole("alert").filter({ hasText: "unsaved.txt" }).waitFor({ state: "visible" });
  await button(releaseDialog, "取消").click();
  await go("case6-parent");
  await release().click();
  ensure((await releaseDialog.innerText()).includes("保留任务记录、分支和已提交的代码"), "release confirmation must explain retained data");
  await button(releaseDialog, "取消").click();
  ensure(await release().isEnabled(), "cancel must leave workspace available");
  await release().click();
  await button(releaseDialog, "释放目录，保留分支").click();
  await row("release", "工作区目录已释放").waitFor({ state: "visible" });
  await go("case6-parent");
  await row("release", "工作区目录已释放").waitFor({ state: "visible" });
  await childBox("case6-child").check();
  await row("selection", "父子统一验收不适用于这条旧关系").and(page.locator(".is-block")).waitFor({ state: "visible" });
  await blocked("invalid family selection must block acceptance");
  await go("case6-child");
  await d.accept();
  await d.accepted();

  // 换合入目标：自己的任务分支不出现在菜单里；任务分支先在层里警告，「取消」不发请求，「改到这里」才发。
  await go("case9-child");
  await d.openMenu();
  ensure(await d.option("ash/case9-ch").count() === 0, "own task branch must not be offered as a merge target");
  const before = posts.length;
  await d.option("ash/case9-pa").click();
  const warning = d.menu.getByRole("status");
  await warning.filter({ hasText: "不能和它一起统一验收" }).waitFor({ state: "visible" });
  await button(d.menu, "取消").click();
  await warning.waitFor({ state: "detached" });
  ensure(!posts.slice(before).some(path => path.endsWith("/merge-target")), "picking a task branch must not save before the warning is confirmed");
  await page.keyboard.press("Escape");
  await d.menu.waitFor({ state: "detached" });
  await changeTarget(d, "case9-child", "ash/case9-pa");
  const occupied = row("blocker", "目标工作区仍被占用").and(page.locator(".is-block"));
  await occupied.waitFor({ state: "visible" });
  ensure((await detail(occupied)).includes("目标分支 ash/case9-pa 仍在工作区"), "occupied target must explain itself");
  await blocked("occupied target must block individual acceptance");
  await go("case9-parent");
  await release().click();
  await button(releaseDialog, "释放目录，保留分支").click();
  await row("release", "工作区目录已释放").waitFor({ state: "visible" });
  await go("case9-parent");
  await row("release", "工作区目录已释放").waitFor({ state: "visible" });
  await childBox("case9-child").check();
  await row("selection", "不能一起统一验收").waitFor({ state: "visible" });
  await blocked("released target still needs child-first order");
  await go("case9-child");
  await d.accept();
  await d.accepted();
  await go("case9-parent");
  await d.accept();
  await d.accepted();

  await go("case10-parent");
  await row("release", "工作区目录已释放").waitFor({ state: "visible" });
  ensure(!/目标分支.*仍在工作区/.test(await page.locator("main").innerText()), "prunable parent must not report contradictory checkout status");
  await go("case10-child");
  await d.accept();
  await d.accepted();
  await go("case11-child");
  await d.openMenu();
  ensure(await d.option("harness/case11-c").count() === 0, "legacy own task branch must not be offered");
  ensure(await d.option("main").count() === 1, "final target must remain selectable");
  await page.keyboard.press("Escape");
  await d.menu.waitFor({ state: "detached" });

  // 挡路的原文收在 blocker 那一行的展开层里：要修什么、怎么修，一个字不少。
  await go("case12-child");
  const broken = (await detail(row("blocker", "目标工作区仍被占用"))).trim();
  ensure(broken.includes("目标分支 ash/case12-p 仍在工作区") && broken.includes("git worktree repair"), "broken target must explain how to repair the link");
  await blocked("broken backlink with surviving files must block child acceptance");
  await go("case12-parent");
  await release().click();
  await button(releaseDialog, "释放目录，保留分支").click();
  await releaseDialog.getByRole("alert").filter({ hasText: "git worktree repair" }).waitFor({ state: "visible" });
  ensure(!(await releaseDialog.innerText()).includes("工作区检出分支已变化"), "broken link is not a branch switch");
  await button(releaseDialog, "取消").click();

  await go("case13-parent");
  const locked = row("release", "工作区目录已不在，占用还没解除").and(page.locator(".is-block"));
  await locked.waitFor({ state: "visible" });
  const lockedText = await detail(locked);
  ensure(lockedText.includes("git worktree unlock"), "missing locked checkout must explain unlocking");
  ensure(!/请先停止任务|再单独验收本任务|释放工作区目录/.test(lockedText), "parent recovery must not send users back to the same panel");
  ensure(!/可继续验收子任务|工作区占用已解除|工作区目录已释放/.test(await page.locator("main").innerText()), "locked checkout cannot advertise successful release");
  await go("case13-child");
  ensure((await detail(row("blocker"))).includes("git worktree unlock"), "locked target must explain unlocking");
  await blocked("locked target must remain blocked");

  await go("case14-child");
  ensure((await detail(row("blocker"))).includes("actual-parent-entry"), "moved missing backlink must identify the real registration");
  await go("case14-parent");
  await release().click();
  await button(releaseDialog, "释放目录，保留分支").click();
  await releaseDialog.getByRole("alert").filter({ hasText: "gitdir:" }).waitFor({ state: "visible" });
  ensure((await releaseDialog.innerText()).includes("actual-parent-entry"), "release must provide the exact pointer content");
  await button(releaseDialog, "取消").click();

  await go("case15-parent");
  await d.accept();
  const tagged = row("failure", "标签已打，清理没做完");
  await tagged.waitFor({ state: "visible" });
  const tagText = await detail(tagged);
  ensure(tagText.includes("ash-accepted/"), "tag partial success must name the created tag");
  ensure(!/合并已完成|验收没完成/.test(await tagged.innerText()), "tag result must agree with its actual completed action");
  ensure(await desk.locator(".acc-done").count() === 0, "tag partial success must not report acceptance");

  await checkBaseUpdateRecovery(page, fixtureUrl, checkpoint);

  await go("case18-child");
  await row("parent", "来源任务记录已不存在").and(page.locator(".is-block")).waitFor({ state: "visible" });
  ensure((await page.locator("main").innerText()).includes("选择已包含继承提交的本地分支"), "missing source must suggest an available action");
  await blocked("unproven inheritance must block acceptance");
  await checkpoint("missing-source-guidance");
  // 普通分支点下去直接发，层里不出警告。
  await changeTarget(d, "case18-child", "imported-parent");
  await d.accept();
  await d.accepted();

  await go("case5-parent");
  ensure(await button(desk, "放行，继续下一站").isEnabled(), "review mid-gate must allow release");
  ensure(await button(inspector(), "放行，继续下一站").isEnabled(), "inspector mid-gate must allow release");
  ensure(await row("child").count() === 0 && await desk.getByRole("checkbox").count() === 0, "family acceptance must not be offered mid-gate");
  for (const [value, key, text] of [["archived", "archived", "已归档，只读"], ["running", "in-flight", "任务在跑"], ["queued", "in-flight", "任务在跑"], ["block", "host", "审查进行中"]]) {
    await page.getByRole("combobox", { name: "保护状态" }).selectOption(value);
    await row(key, text).waitFor({ state: "visible" });
    ensure(await main.innerText() === "放行，继续下一站", `${value} must keep the action name on the button`);
    ensure(!await main.isEnabled(), `lost ${value} protection`);
  }
  await page.getByRole("combobox", { name: "保护状态" }).selectOption("none");
  await button(desk, "放行，继续下一站").click();
  const releaseLayer = page.getByRole("dialog", { name: "确认放行", exact: true });
  await releaseLayer.waitFor({ state: "visible" });
  ensure(!/合并|清理|打标签/.test(await releaseLayer.innerText()), "release must not advertise final merge");
  await button(releaseLayer, "放行").click();
  await notice("已放行");
  ensure(await output("工作流游标").innerText() === "verify2", "review release must advance to verify");

  await go("case5-child");
  await button(inspector(), "放行，继续下一站").click();
  await releaseLayer.waitFor({ state: "visible" });
  await button(releaseLayer, "放行").click();
  await notice("已放行");
  ensure(await output("工作流游标").innerText() === "verify2", "child inspector release must advance despite waiting parent");

  // 红行 ↔ 主按钮：依赖没就绪（非 tag 策略）是红的、拦；tag 策略不合代码，同一句只是琥珀提醒、不拦。
  await go("case1-child");
  await row("parent", "等待「case1-parent」的父成果合入").and(page.locator(".is-block")).waitFor({ state: "visible" });
  ensure(await main.innerText() === "验收通过", "a blocked button still names its action");
  await blocked("final acceptance must keep dependency guard");
  await page.route("**/api/tasks/case1-child/branch-plan", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.task.strategy = "tag";
    await route.fulfill({ response, json: body });
  });
  await go("case1-child");
  await row("parent", "等待「case1-parent」的父成果合入").and(page.locator(".is-warn")).waitFor({ state: "visible" });
  await open("tag strategy must not wait for the parent's merge");
  await page.unroute("**/api/tasks/case1-child/branch-plan");
  await go("case4-parent");
  await row("blocker", "目标本地分支 main 不存在").and(page.locator(".is-block")).waitFor({ state: "visible" });
  await blocked("final acceptance must keep target guard");

  await checkPlanSharing(page, fixtureUrl, checkpoint);

  await go("case2-child");
  const needsUpdate = row("parent").and(page.locator(".is-block"));
  await needsUpdate.waitFor({ state: "visible" });
  await blocked("a dependency that needs a baseline update must block acceptance");
  await button(needsUpdate, "更新基线").click();
  await dialog.getByRole("heading", { name: "更新子分支基线？" }).waitFor({ state: "visible" });
  await button(dialog, "更新基线").click();
  await notice("基线已更新，请核对改动并按影响范围重新验证");
  await desk.locator("button.acc-btn.is-primary:enabled:not([aria-busy])").waitFor({ state: "visible" });
  await open("baseline update should unblock acceptance");

  await checkFamilyAcceptance(page, fixtureUrl, checkpoint);
  // 放最后：这一条眼下被 src 的问题挡着（见报告），别让它挡住前面全部的覆盖。
  await checkPartialCleanup(d);
}

// 依赖那份事实是多处订阅者共用的一份（验收台、第一行走向、侧栏）：一次变化只发一次请求，旧响应不盖新结果，
// 卸载后不再轮询；读失败那一行自带「重试」，后台静默重验失败一个字都不出。
async function checkPlanSharing(page, fixtureUrl, checkpoint) {
  const d = acceptanceDesk(page, fixtureUrl);
  const { ensure, desk, row, main, idle, go, button, confirmLayer } = d;
  const output = name => page.locator(`output[aria-label="${name}"]`);
  const probe = name => button(page.getByRole("region", { name: "请求探针", exact: true }), name);
  const settled = async count => {
    await output("依赖响应次数").filter({ hasText: new RegExp(`^${count}$`) }).waitFor({ state: "visible" });
    ensure(await output("依赖请求次数").innerText() === String(count), "subscribers issued duplicate requests");
  };
  const dependency = row("dependency", "依赖读不出来");
  await go("case3-parent");
  ensure(await main.isEnabled(), "clean parent must be acceptable");
  await settled(1);
  await probe("轮询一次").click();
  await settled(2);
  await probe("模拟任务更新").click();
  await settled(3);
  // 用户归得到自己头上的那次取数失败了：红行 + 重试，主按钮灰着，第一行的目标也锁着。
  await probe("下次依赖请求失败").click();
  await probe("模拟任务更新").click();
  await settled(4);
  await dependency.and(page.locator(".is-block")).waitFor({ state: "visible" });
  ensure((await dependency.innerText()).includes("测试读取失败"), "dependency row must say why it failed");
  ensure(!await main.isEnabled(), "shared errors must block acceptance");
  ensure(!await d.target.isEnabled(), "unreadable plan must lock the merge target");
  await button(dependency, "重试").click();
  await settled(5);
  await dependency.waitFor({ state: "detached" });
  await idle();
  ensure(await main.isEnabled(), "a successful retry must release acceptance");
  await probe("延迟下次依赖响应").click();
  await probe("模拟任务更新").click();
  await output("延迟状态").filter({ hasText: "已挂起" }).waitFor({ state: "visible" });
  await probe("模拟任务更新").click();
  await output("依赖响应次数").filter({ hasText: /^6$/ }).waitFor({ state: "visible" });
  await probe("释放旧响应").click();
  await settled(7);
  await idle();
  ensure(await main.isEnabled(), "old response overwrote newer refresh");
  ensure(await page.getByText("过期响应不应覆盖新结果", { exact: true }).count() === 0, "panel received stale response");
  await probe("卸载验收界面").click();
  await probe("轮询一次").click();
  await settled(7);
  // 首屏就读不出来（手上一份都没有）：同样是红行 + 重试，主按钮不放行。
  await probe("下次依赖请求失败").click();
  await probe("恢复验收界面").click();
  await settled(8);
  await dependency.and(page.locator(".is-block")).waitFor({ state: "visible" });
  await idle();
  ensure(!await main.isEnabled(), "a first read that failed must block acceptance");
  await button(dependency, "重试").click();
  await settled(9);
  await dependency.waitFor({ state: "detached" });
  await idle();
  ensure(await main.isEnabled(), "retry after a failed first read must release acceptance");
  await probe("轮询一次").click();
  await settled(10);
  await probe("延迟正常依赖响应").click();
  await probe("确认框打开时更新标签").click();
  await main.click();
  await output("延迟状态").filter({ hasText: "已挂起" }).waitFor({ state: "visible" });
  ensure(await main.getAttribute("aria-busy") === "true" && !await main.isEnabled(), "updated task must await a fresh plan");
  ensure(await main.innerText() === "验收通过", "checking must not rename the button");
  await confirmLayer.waitFor({ state: "visible" });
  ensure(!await button(confirmLayer, "确认验收").isEnabled(), "confirmation must wait for dependency refresh without disappearing");
  await checkpoint("individual-confirm-refreshing");
  await button(confirmLayer, "完成测试依赖响应").click();
  await settled(11);
  await button(confirmLayer, "确认验收").and(page.locator("button:enabled")).waitFor({ state: "visible" });
  await checkpoint("individual-confirm-refreshed");
  await button(confirmLayer, "取消").click();
  await confirmLayer.waitFor({ state: "detached" });
  await idle();
  ensure(await main.isEnabled(), "fresh task plan must restore acceptance");

  // 后台自动重验（15 秒那个）失败时不许惊动版面：没有一行、不顶开前提列、不禁主按钮，手上那份依赖仍然有效。
  // 先等失败真的落进共享状态（台子页另挂的订阅者念得出原因），再断言——反过来写可能抢在状态更新之前跑完、永远为真。
  const checks = desk.getByRole("list", { name: "验收前提", exact: true });
  const height = () => checks.evaluate(node => node.getBoundingClientRect().height);
  const quietHeight = await height();
  await probe("下次依赖请求失败").click();
  await probe("轮询一次").click();
  await settled(12);
  await output("依赖后台重验失败").filter({ hasText: "测试读取失败" }).waitFor({ state: "visible" });
  ensure(await row("dependency").count() === 0, "background revalidation failure must not raise a row");
  ensure(await desk.getByRole("alert").count() === 0, "background revalidation failure must not raise an alert");
  ensure(await height() === quietHeight, "background revalidation failure must not reflow the checks");
  ensure(await main.isEnabled(), "background revalidation failure must not block acceptance");
  await probe("模拟任务更新").click();
  await settled(13);
  await output("依赖后台重验失败").filter({ hasText: /^$/ }).waitFor({ state: "attached" });
}

// 勾上派生任务，主按钮就变成「验收 N 个任务」，走 /accept-family；确认层列出这批任务，发的指纹是打开那一刻的。
async function checkFamilyAcceptance(page, fixtureUrl, checkpoint) {
  const d = acceptanceDesk(page, fixtureUrl);
  const { ensure, row, main, idle, go, button, notice, confirmLayer } = d;
  const output = name => page.locator(`output[aria-label="${name}"]`);
  const probe = name => button(page.getByRole("region", { name: "请求探针", exact: true }), name);
  const childBox = title => row("child").filter({ has: page.locator(".acc-check-text").getByText(title, { exact: true }) }).getByRole("checkbox");
  const commitBox = confirmLayer.getByRole("checkbox", { name: "合并后提交", exact: true });

  await go("case3-parent");
  const plan = await d.plan("case3-parent");
  await childBox("case3-child").check();
  await main.filter({ hasText: /^验收 2 个任务$/ }).waitFor({ state: "visible" });
  await idle();
  await main.click();
  for (const title of ["case3-parent", "case3-child"]) ensure((await confirmLayer.innerText()).includes(title), `missing ${title} from confirmation`);
  ensure((await confirmLayer.innerText()).includes("2 个任务"), "family merge step must count the tasks");
  await commitBox.waitFor({ state: "visible" });
  ensure(await commitBox.isChecked(), "commit follows the project default");
  await commitBox.uncheck();
  await confirmLayer.getByText("不提交时一次只能合一个任务", { exact: true }).waitFor({ state: "visible" });
  ensure(!await confirmLayer.getByRole("button", { name: /^(确认验收|验收，不提交)$/ }).isEnabled(), "two merges without committing must not be confirmable");
  await commitBox.check();
  const sent = d.posted("/accept-family");
  await button(confirmLayer, "确认验收").click();
  const body = (await sent).postDataJSON();
  const expected = [plan.task, plan.descendants.find(row => row.taskId === "case3-child")].map(row => ({ taskId: row.taskId, fingerprint: row.fingerprint }));
  ensure(JSON.stringify(body.entries.map(({ taskId, fingerprint }) => ({ taskId, fingerprint }))) === JSON.stringify(expected), `family entries must carry both fingerprints: ${JSON.stringify(body)}`);
  ensure(body.commit === true, "family acceptance must send the commit choice shown in the layer");
  // case3 的父任务是 squash：合完之后子任务的基线得先更新，服务端合完父任务就停住——提示照实说一半。
  await notice("已完成 1 个任务；其余暂停");

  await go("case1-parent");
  await childBox("case1-grand").check();
  await row("selection", "未勾选的父任务").waitFor({ state: "visible" });
  await idle();
  ensure(!await main.isEnabled(), "cannot skip intermediate ancestor");
  await childBox("case1-child").check();
  await row("selection").waitFor({ state: "detached" });
  await main.filter({ hasText: /^验收 3 个任务$/ }).waitFor({ state: "visible" });
  await probe("延迟正常依赖响应").click();
  await probe("确认框打开时更新标签").click();
  await idle();
  await main.click();
  await confirmLayer.waitFor({ state: "visible" });
  await output("延迟状态").filter({ hasText: "已挂起" }).waitFor({ state: "visible" });
  ensure(!await button(confirmLayer, "确认验收").isEnabled(), "family confirmation must stay mounted but pause during refresh");
  await checkpoint("family-confirm-refreshing");
  await button(confirmLayer, "完成测试依赖响应").click();
  await button(confirmLayer, "确认验收").and(page.locator("button:enabled")).waitFor({ state: "visible" });
  await button(confirmLayer, "取消").click();
  await idle();
  await main.click();
  for (const name of ["case1-parent", "case1-child", "case1-grand"]) ensure((await confirmLayer.innerText()).includes(name), `missing ${name} from confirmation`);
  await button(confirmLayer, "确认验收").click();
  await notice("统一验收已完成，共 3 个任务");
  await checkpoint("family-accepted");
}

// 合并成了、清理没做完：两件事分开说，不能报成「已验收」。服务端此时把任务落在 stage=merged（「已合并」，
// shared 的 STAGE_LABELS），清理没做完那一行（FailureCheck）要在任务刷新成 merged 之后仍然看得见。
async function checkPartialCleanup(d) {
  const { ensure, desk, go, detail, notice } = d;
  await go("case12-parent");
  await d.accept();
  await notice("目录及文件已保留");
  ensure(/成果已合入 main（提交 [a-f0-9]{40,64}）/.test(await d.result.innerText()), "partial success must disclose the actual target and commit");
  const partial = d.row("failure", "合并已完成，清理没做完");
  await partial.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {
    throw new Error("merged-but-not-cleaned acceptance shows no row about the unfinished cleanup once the task refreshed to stage=merged");
  });
  ensure((await detail(partial)).includes("目录及文件已保留"), "partial success row must keep the cleanup detail");
  ensure(await desk.getByText("已验收", { exact: true }).count() === 0, "unreadable cleanup must not report success");
}
