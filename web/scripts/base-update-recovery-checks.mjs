// 验收台（web/src/acceptance/AcceptanceControls.tsx）在台子页上的定位器：一行决定、一列前提。
// 每一行是 `[data-check=<key>]`，行尾的出路在 `.acc-check-tools` 里，要细看的原文收在展开层
// `.acc-check-detail`（点 `button.acc-check-main` 才出来）。确认层、目标菜单都 portal 到 body。
export function acceptanceDesk(page, fixtureUrl) {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  const desk = page.getByRole("region", { name: "验收台", exact: true });
  const row = (key, hasText) => {
    const rows = desk.locator(`[data-check="${key}"]`);
    return hasText ? rows.filter({ hasText }) : rows;
  };
  // 主按钮上永远只写动作名；读取中 aria-busy、文字不变。
  const main = desk.locator("button.acc-btn.is-primary");
  const idle = () => desk.locator("button.acc-btn.is-primary:not([aria-busy])").waitFor({ state: "visible" });
  const go = async task => {
    const url = new URL(fixtureUrl);
    url.search = new URLSearchParams({ task, clock: "manual" }).toString();
    await page.goto(url.href);
    await page.getByRole("heading", { name: task, exact: true }).waitFor({ state: "visible" });
    await idle();
  };
  const detail = async line => {
    const toggle = line.locator("button.acc-check-main");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    return line.locator(".acc-check-detail").innerText();
  };
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const result = page.getByRole("status", { name: "操作结果", exact: true });
  const notice = text => result.filter({ hasText: text }).waitFor({ state: "visible" }).catch(async error => {
    throw new Error(`expected notice ${text}, got: ${await result.innerText().catch(() => "(none)")}\n${error.message}`);
  });
  const confirmLayer = page.getByRole("dialog", { name: "确认验收", exact: true });
  const dialog = page.getByRole("dialog");
  const accept = async () => {
    await idle();
    ensure(await main.isEnabled(), "acceptance should be available here");
    await main.click();
    await button(confirmLayer, "确认验收").click();
  };
  const accepted = () => desk.locator(".acc-done").filter({ hasText: "已验收" }).waitFor({ state: "visible" });
  const target = desk.getByRole("button", { name: /^合入目标 .+，点开更换$/ });
  const menu = page.getByRole("menu", { name: "合入目标", exact: true });
  const option = name => menu.getByRole("menuitemradio", { name, exact: true });
  const openMenu = async () => {
    await target.click();
    // 分支读回来之前菜单里只有「读取分支」那一行，数选项要等它们到齐。
    await menu.getByRole("menuitemradio").first().waitFor({ state: "visible" });
  };
  const plan = async task => (await page.request.get(new URL(`/api/tasks/${encodeURIComponent(task)}/branch-plan`, fixtureUrl).href)).json();
  const posted = suffix => page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname.endsWith(suffix));
  return { ensure, desk, row, main, idle, go, detail, button, result, notice, confirmLayer, dialog, accept, accepted, target, menu, option, openMenu, plan, posted };
}

// 改合入目标：菜单里点一条，发 `POST merge-target {branch, fingerprint}`，指纹是**打开菜单那一刻**的。
// 任务分支（ash/ harness/ 前缀）点下去只在层里出警告，要再点「改到这里」才发。
export async function changeTarget(d, task, branch) {
  const { fingerprint } = (await d.plan(task)).task;
  await d.openMenu();
  const sent = d.posted("/merge-target");
  await d.option(branch).click();
  if (/^(ash|harness)\//.test(branch)) {
    await d.menu.getByRole("status").filter({ hasText: "这是一条任务分支" }).waitFor({ state: "visible" });
    await d.button(d.menu, "改到这里").click();
  }
  const body = (await sent).postDataJSON();
  d.ensure(body.branch === branch && body.fingerprint === fingerprint, `merge-target must carry the fingerprint seen when the menu opened: ${JSON.stringify(body)}`);
  await d.notice(`合入目标已改为 ${branch}`);
}

export async function checkBaseUpdateRecovery(page, fixtureUrl, checkpoint = async () => {}) {
  const d = acceptanceDesk(page, fixtureUrl);
  const { ensure, row, main, go, button, dialog, notice } = d;
  const files = page.locator('output[aria-label="diff 文件"]');
  const recover = () => button(row("base-update"), "处理");
  for (const task of ["case16-child", "case17-child", "case19-child"]) {
    const complete = task !== "case19-child";
    await go(task);
    await row("base-update", "上次基线更新没结算完").waitFor({ state: "visible" });
    await recover().waitFor({ state: "visible" });
    // 没结算完的基线更新是一条红行，主按钮跟着灰；改合入目标也锁着。
    await row("blocker", "基线更新待处理").and(page.locator(".is-block")).waitFor({ state: "visible" });
    ensure(!await main.isEnabled(), "pending update must block acceptance");
    ensure(!await d.target.isEnabled(), "pending update must lock the merge target");
    if (complete) {
      await files.filter({ hasText: "unrelated-main.txt" }).waitFor({ state: "visible" });
      await button(row("parent"), "更新基线").click();
      await dialog.getByRole("heading", { name: "更新子分支基线？", exact: true }).waitFor({ state: "visible" });
      await button(dialog, "更新基线").click();
      await d.result.filter({ hasText: /工作区已变化|子分支已被其它操作修改/ }).waitFor({ state: "visible" });
    }
    await recover().click();
    const title = complete ? "完成已生效的基线更新？" : "放弃本次基线更新？";
    await dialog.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
    ensure((await dialog.innerText()).includes("处理后开工提交"), "confirmation must show the resulting diff base");
    if (complete) ensure((await dialog.innerText()).includes("保留当前提交"), "completion must explain preservation of current work");
    await checkpoint(`${task}-recovery-confirm`);
    await button(dialog, "取消").click();
    ensure(await recover().isEnabled(), "cancel must preserve the pending operation");
    await recover().click();
    await button(dialog, complete ? "确认完成基线更新" : "确认放弃基线更新").click();
    await notice(complete ? "已按更新后的起点完成结算" : "已放弃本次基线更新");
    await row("base-update").waitFor({ state: "detached" });
    await d.target.and(page.locator("button:enabled")).waitFor({ state: "visible" });
    ensure(await d.target.count() === 1, "recovery must not duplicate the target editor");
    const expected = task === "case17-child" ? "child.txt,newer.txt" : "child.txt";
    await files.filter({ hasText: new RegExp(`^${expected.replaceAll(".", "\\.")}$`) }).waitFor({ state: "visible" });
    ensure(!(await page.getByRole("region", { name: "恢复后的分支改动", exact: true }).innerText()).includes("unrelated-main.txt"), "main's unrelated file leaked into the review diff");
    await checkpoint(`${task}-recovery-diff`);
  }
  await checkManualBaseRecovery(page, fixtureUrl, checkpoint);
  await checkRecoveredGrandchild(page, fixtureUrl, checkpoint);
}

export async function checkManualBaseRecovery(page, fixtureUrl, checkpoint = async () => {}) {
  const d = acceptanceDesk(page, fixtureUrl);
  const { ensure, row, go, button, dialog, notice } = d;
  const recover = () => button(row("base-update"), "处理");
  const acknowledgement = dialog.getByRole("checkbox", { name: "我已核对基点和差异范围，保留当前代码并重新审查", exact: true });
  for (const task of ["case20-child", "case21-child", "case22-child", "case23-child"]) {
    await go(task);
    await recover().waitFor({ state: "visible" });
    if (task === "case21-child") {
      await button(row("parent"), "更新基线").click();
      await button(dialog, "更新基线").click();
      await d.result.filter({ hasText: /记录损坏.*手动解除挂起/ }).waitFor({ state: "visible" });
    }
    await recover().click();
    await dialog.getByRole("heading", { name: "核对基点并手动解除挂起？", exact: true }).waitFor({ state: "visible" });
    await dialog.getByText(/现存备份（\d+）/).click();
    ensure((await dialog.innerText()).includes(`refs/ash/base-update-backups/${task}/`), "manual dialog must expose real existing backup coordinates");
    ensure((await dialog.innerText()).includes("确认时将保存的备份"), "planned refs must be labelled as future backups");
    ensure(!await button(dialog, "保留代码并解除挂起").isEnabled(), "scope acknowledgement must not be preselected");
    const preview = dialog.getByRole("region", { name: "恢复差异预览", exact: true });
    if (task !== "case23-child") {
      ensure((await preview.innerText()).includes("child.txt"), "manual preview must disclose the recovered task delta");
      ensure(!(await preview.innerText()).includes("unrelated-main.txt"), "manual proposal must not include unrelated main files");
    }
    await checkpoint(`${task}-manual-dialog`);
    await acknowledgement.check();
    await button(dialog, "取消").click();
    await recover().click();
    ensure(!await button(dialog, "保留代码并解除挂起").isEnabled(), "reopening must require fresh acknowledgement");
    await acknowledgement.check();
    await button(dialog, "保留代码并解除挂起").click();
    await notice("已按核对的基点手动解除挂起");
    await row("base-update").waitFor({ state: "detached" });
    await d.target.and(page.locator("button:enabled")).waitFor({ state: "visible" });
    await page.locator('output[aria-label="diff 文件"]').filter({ hasText: task === "case23-child" ? /^$/ : /^child\.txt$/ }).waitFor({ state: task === "case23-child" ? "attached" : "visible" });
    await checkpoint(`${task}-manual-result`);
    // 恢复之后改合入目标仍然走得通：菜单标着当前目标，改到一条任务分支要先过警告，带的是新指纹。
    await d.openMenu();
    ensure(await d.option("main").getAttribute("aria-checked") === "true", "menu must mark the current target");
    await page.keyboard.press("Escape");
    await d.menu.waitFor({ state: "detached" });
    await changeTarget(d, task, `ash/${task.replace("-child", "-parent").slice(0, 8)}`);
  }
}

export async function checkRecoveredGrandchild(page, fixtureUrl, checkpoint = async () => {}) {
  const d = acceptanceDesk(page, fixtureUrl);
  const { ensure, desk, row, main, go, button, dialog, notice } = d;
  const files = page.locator('output[aria-label="diff 文件"]');
  await go("case24-grand");
  await row("parent", "等待「case24-child」的父成果合入").and(page.locator(".is-block")).waitFor({ state: "visible" });
  ensure(!await main.isEnabled(), "waiting parent must block acceptance");
  ensure(await button(desk, "更新基线").count() === 0, "unmerged middle task must not authorize baseline replacement");
  await go("case24-child");
  await button(row("base-update"), "处理").click();
  await dialog.getByRole("checkbox", { name: "我已核对基点和差异范围，保留当前代码并重新审查", exact: true }).check();
  await button(dialog, "保留代码并解除挂起").click();
  await row("base-update").waitFor({ state: "detached" });
  await d.accept();
  await d.accepted();
  await go("case24-grand");
  const parent = row("parent").and(page.locator(".is-block"));
  await parent.waitFor({ state: "visible" });
  ensure(!await main.isEnabled(), "a dependency that needs a baseline update must block acceptance");
  ensure(await button(parent, "更新基线").isEnabled(), "accepted rewritten middle task must expose an executable update action");
  ensure((await parent.innerText()).includes("当前版本已合入"), "dependency must not ask for a merge that already happened");
  await checkpoint("grandchild-needs-update");
  await button(parent, "更新基线").click();
  ensure((await dialog.innerText()).includes("用已验收版本替换旧基线"), "confirmation must disclose replacing inherited history");
  await checkpoint("grandchild-update-confirm");
  await button(dialog, "更新基线").click();
  await notice("基线已更新，请核对改动并按影响范围重新验证");
  await files.filter({ hasText: /^grand\.txt$/ }).waitFor({ state: "visible" });
  await checkpoint("grandchild-updated-diff");
  await d.accept();
  await d.accepted();
  await checkpoint("grandchild-accepted");
}
