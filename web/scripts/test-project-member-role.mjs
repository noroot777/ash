// 「加人的时候就能定角色」的回归测试。跑：npm -w web run test:project-member-role
//
// 后端 `POST /api/projects/:id/members` 一直就收 role，缺的只是这一屏上的入口 —— 以前
// 只能先按成员加进来、再翻到名单里改一次，中间那一段对方拿的是错的权限。这条测试钉的
// 是入口这一侧：
//   ① 加人那一块有角色下拉，默认「成员」；
//   ② 选「项目管理员」再加，请求里带的就是 admin，落到名单里那一行也是管理员；
//   ③ 加完角色回落成「成员」——下一次加人不继承上一次那个更高的权限。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { chooseOption, optionLabels, selectedValue, selectTrigger } from "./select-helpers.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await page.goto(`${web.origin}/scripts/fixtures/project-member-role.html`);

  const add = page.locator(".pmem-add");
  await add.waitFor();
  const who = selectTrigger(page, "选择要加入的用户");
  const role = selectTrigger(page, "加入后的角色");

  // ① 角色下拉就摆在加人那一块里，默认是普通成员 —— 加人这一下不该悄悄给出管理员。
  await role.waitFor();
  assert.equal(await selectedValue(role), "member", "加人时角色默认应为「成员」");
  assert.deepEqual(
    await optionLabels(role),
    ["成员", "项目管理员"],
    "角色下拉的两项要跟名单里那颗一致",
  );

  // 用户下拉是主角，角色那颗不跟它平分宽度，否则一屏里名字先被截断。
  const widths = await add.evaluate((el) => {
    const [user, roleSel] = [...el.querySelectorAll(".ui-dropdown")];
    return { user: user.getBoundingClientRect().width, role: roleSel.getBoundingClientRect().width };
  });
  assert.ok(widths.user > widths.role * 1.5, `用户下拉应明显宽于角色下拉：${JSON.stringify(widths)}`);

  // ② 选成项目管理员再加：请求里必须带 admin，名单里那一行也得是管理员。
  await chooseOption(who, "u-bo");
  await chooseOption(role, "admin");
  await page.getByRole("button", { name: "加入项目" }).click();
  const boRow = page.locator(".pmem-row", { hasText: "小博" });
  await boRow.waitFor();
  assert.deepEqual(
    JSON.parse(await page.getByTestId("posted").innerText()),
    [{ userId: "u-bo", role: "admin" }],
    "加人请求里要带上选中的角色",
  );
  await selectTrigger(page, "小博 的项目角色").waitFor();
  assert.equal(
    await selectedValue(selectTrigger(page, "小博 的项目角色")),
    "admin",
    "名单里那一行也该是项目管理员",
  );
  assert.match(await page.getByTestId("notices").innerText(), /已加入项目：项目管理员/);

  // ③ 加完回落成「成员」：下一个人不该继承上一轮那个更高的权限。
  assert.equal(await selectedValue(role), "member", "加完一轮后角色应回落为「成员」");
  assert.equal(await selectedValue(who), "", "加完一轮后用户下拉应清空");

  await chooseOption(who, "u-cai");
  await page.getByRole("button", { name: "加入项目" }).click();
  await page.locator(".pmem-row", { hasText: "小蔡" }).waitFor();
  assert.deepEqual(
    JSON.parse(await page.getByTestId("posted").innerText()).at(-1),
    { userId: "u-cai", role: "member" },
    "没改角色就该按普通成员加",
  );

  console.log("project member role tests passed");
} finally {
  await browser?.close();
  await web.close();
}
