export async function checkTaskCreationOrigin(page, fixtureUrl) {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  await page.goto(fixtureUrl);
  const row = title => page.locator(".workspace-task-row").filter({ hasText: title });
  const open = async title => {
    await row(title).waitFor({ state: "visible" });
    await row(title).click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
  };
  const detailBadges = () => page.locator(".task-detail-header .task-creation-badge, .task-origin-bar .task-creation-badge");
  // 用户自己建的任务不挂徽标：那是绝大多数，标了等于没标。徽标只标智能体开的活，
  // 且长在顶栏那一行里，不再自己占一条。
  for (const title of ["用户新建", "用户从父任务派生"]) {
    await row(title).waitFor({ state: "visible" });
    ensure(await row(title).locator(".task-creation-badge").count() === 0, `user-created task must stay unlabeled: ${title}`);
    await open(title);
    ensure(await detailBadges().count() === 0, `user-created detail must stay unlabeled: ${title}`);
  }
  const cases = [["Codex 派生的任务", "Codex 派生"], ["外部智能体创建", "智能体创建（自报）"],
    ["群聊委派的任务", "Codex 群聊委派"]];
  for (const [title, label] of cases) {
    await row(title).waitFor({ state: "visible" });
    ensure(await row(title).locator(".task-creation-badge").innerText() === label, `wrong list origin: ${title}`);
    await open(title);
    ensure(await page.locator(".task-detail-header .task-creation-badge").innerText() === label, `wrong detail origin: ${title}`);
    ensure(await page.locator(".task-origin-bar .task-creation-badge").count() === 0, `the badge must not go back to its own line: ${title}`);
    if (title === "Codex 派生的任务") {
      ensure((await page.locator(".task-origin-bar").innerText()).includes("Codex Dev"), "creator executor snapshot is missing");
    }
    if (title === "群聊委派的任务") {
      ensure((await page.locator(".task-origin-bar").innerText()).includes("聊天 Codex"), "chat member snapshot is missing");
    }
  }
  await page.locator('.workspace-task-row[data-task-id="source-agent"]').click();
  await page.getByRole("heading", { name: "父任务已改名", exact: true }).waitFor({ state: "visible" });
  ensure(await page.locator(".task-origin-bar").count() === 0, "unknown origin without a parent must not add an empty bar");
  await open("旧任务保留父链接");
  ensure(await detailBadges().count() === 0, "parent relationship must not imply a creator");
  await page.locator(".task-origin-bar").getByRole("button", { name: "来自团队 · 父任务已改名", exact: true }).click();
  await page.getByRole("heading", { name: "父任务已改名", exact: true }).waitFor({ state: "visible" });
  ensure(await page.locator(".task-origin-bar").count() === 0, "legacy parent must still have no empty origin bar");
}
