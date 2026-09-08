export async function checkTaskCreationOrigin(page, fixtureUrl) {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  await page.goto(fixtureUrl);
  const row = title => page.locator(".workspace-task-row").filter({ hasText: title });
  const cases = [["用户新建", "用户创建"], ["用户从父任务派生", "用户创建"],
    ["Codex 派生的任务", "Codex 派生"], ["外部智能体创建", "智能体创建"]];
  for (const [title, label] of cases) {
    await row(title).waitFor({ state: "visible" });
    ensure(await row(title).locator(".task-creation-badge").innerText() === label, `wrong list origin: ${title}`);
    await row(title).click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
    ensure(await page.locator(".task-origin-bar .task-creation-badge").innerText() === label, `wrong detail origin: ${title}`);
    if (title === "Codex 派生的任务") {
      ensure((await page.locator(".task-origin-bar").innerText()).includes("Codex Dev"), "creator executor snapshot is missing");
    }
  }
  await page.locator('.workspace-task-row[data-task-id="source-agent"]').click();
  await page.getByRole("heading", { name: "父任务已改名", exact: true }).waitFor({ state: "visible" });
  ensure((await page.locator(".task-origin-bar").innerText()).includes("来源未记录"), "legacy task must remain unknown");
}
