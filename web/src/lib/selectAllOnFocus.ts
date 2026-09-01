import type { FocusEvent, MouseEvent } from "react";

/**
 * 「一个数字、进来就是要换掉」的小输入框：一聚焦就整个选中，鼠标点一下即可直接敲新值，
 * 不用先退格或全选清掉旧值。
 *
 * 只在未聚焦时拦鼠标（原生行为是 mouseup 把光标落到点击位置，会把 focus 时的全选冲掉）；
 * 已经聚焦时完全放行，挪光标和拖选保持原生手感。
 */
export const selectAllOnFocus = {
  onFocus: (event: FocusEvent<HTMLInputElement>) => {
    event.currentTarget.select();
  },
  onMouseDown: (event: MouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (document.activeElement === input) return;
    event.preventDefault();
    input.focus();
  },
} as const;
