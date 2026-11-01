// 一组按钮充当的单选 / 分页，**键盘的那一半**。
//
// `<input type=radio>` 和 `<select>` 自带方向键换选、整组一个 Tab 停靠点；换成一排
// 按钮之后这些一并丢掉,而页面上到处都是这种按钮组(协议二选一、启动方式 chip、
// 审查改动的保存方式、PillTabs、任务模式、起手式条、Inspector 图标条、服务日志条)。
// 在每一处各补一遍 `onKeyDown` 的结果实测过:补过的那几处好用,没补的照旧只能 Tab
// 一颗颗按过去,有的认 Home/End 有的不认,而差别从代码上根本看不出来。
//
// 所以这里只抽**键盘契约**,不抽长相:那些地方的内容物差得很远(图标 chip / 标题加
// 副标题的卡片 / 纯文字 / 带状态点的服务名),硬塞进同一个组件只会长出一堆 slot 参数。
// 各自照旧渲染自己的按钮,把这里给的 props 摊上去即可。
//
// 约定只有一条:**组容器要带上 `groupProps`(或它自己已经是同名 role)**,按钮摊
// `itemProps`。候选从容器现读(`closest` 找到组 → 组内查 `[role=…][data-choice-value]`),
// 所以:
//   · 不需要把 ref 传进来 —— 容器的 ref 常常另有主人(服务日志条那个要用来横向滚动),
//     一旦这里也要一个,接的人就得自己合并两个 ref;
//   · 禁用项自动跳过(`:not(:disabled)`),谁被禁用由各自的渲染决定;
//   · 只认带 `data-choice-value` 的那些,所以外部塞进同一个容器的按钮(新建任务那条
//     tab 条里的「开聊」、起手式条末尾的「新建」)不会被漫游接管 —— 它不是这一组的
//     取值,走到它也不叫换选。
import type { KeyboardEvent } from "react";

type ChoiceRole = "radio" | "tab";

// 四个方向键都认。组是横排还是竖排由 CSS 定,这里不猜;多认两个键不会误伤(组内不滚动),
// 少认才会 —— 竖排的组只认左右键等于键盘用户走不动。
const STEP: Record<string, number> = {
  ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1,
};

const GROUP_ROLE = { radio: "radiogroup", tab: "tablist" } as const;

/**
 * @param values 组内全部取值,按渲染顺序 —— 只用来决定「一个都没选中时 Tab 停在哪」。
 * @param value  当前值;`""` = 还没选(新建表单的初始态)。
 */
export function useRovingChoice<T extends string>(
  values: readonly T[],
  value: T | "",
  onChange: (value: T) => void,
  role: ChoiceRole = "radio",
) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const delta = STEP[event.key] ?? 0;
    const home = event.key === "Home";
    const end = event.key === "End";
    if (!delta && !home && !end) return;
    const group = event.currentTarget.closest(`[role="${GROUP_ROLE[role]}"]`);
    const items = [...(group?.querySelectorAll<HTMLElement>(`[role="${role}"][data-choice-value]:not(:disabled)`) ?? [])];
    const from = items.indexOf(event.currentTarget);
    if (from < 0) return;
    const to = home ? 0 : end ? items.length - 1 : (from + delta + items.length) % items.length;
    const picked = items[to]?.dataset.choiceValue as T | undefined;
    if (!picked) return;
    event.preventDefault();
    items[to].focus();
    onChange(picked);
  };

  // 选中的那一颗是组的 Tab 停靠点(WAI-ARIA 的 roving tabindex);一个都没选中时
  // 停在第一颗上,否则整组会被 Tab 跳过去,键盘用户根本进不来。
  const stop = value || values[0];

  return {
    groupProps: { role: GROUP_ROLE[role] },
    itemProps: (candidate: T) => ({
      role,
      [role === "tab" ? "aria-selected" : "aria-checked"]: candidate === value,
      tabIndex: candidate === stop ? 0 : -1,
      "data-choice-value": candidate,
      onKeyDown,
    }),
  };
}
