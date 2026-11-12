// DOM 回归里操作 components/Select.tsx 的共用写法。
//
// 设置页的原生 `<select>` 换成了这个组件：触发器是一颗 `aria-haspopup="listbox"` 的按钮，
// 选项画在 portal 到 body 的浮层里。Playwright 的 `selectOption` / `inputValue` 只认原生
// select，所以这里给两样替代：触发器和每个选项上都挂着 `data-value`，按值点、按值读。

/** 按 Select 的可访问名称找触发器（等价于原来的 getByRole("combobox", { name })）。 */
export function selectTrigger(scope, name) {
  return scope.getByRole("button", { name, exact: true });
}

/** 展开这颗 Select，点值为 value 的那一项。 */
export async function chooseOption(trigger, value) {
  await trigger.click();
  const list = await trigger.getAttribute("aria-controls");
  await trigger.page().locator(`[id="${list}"] [role="option"][data-value="${value}"]`).click();
}

/** 这颗 Select 现在选着哪个值。 */
export function selectedValue(trigger) {
  return trigger.getAttribute("data-value");
}

/** 展开这颗 Select，读出全部选项的名字（读完收起来）。 */
export async function optionLabels(trigger) {
  await trigger.click();
  const list = await trigger.getAttribute("aria-controls");
  const labels = await trigger.page().locator(`[id="${list}"] [role="option"] > b`).allInnerTexts();
  await trigger.page().keyboard.press("Escape");
  await trigger.page().locator(`[id="${list}"]`).waitFor({ state: "detached" });
  return labels;
}
