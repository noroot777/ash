import { useEffect, useRef } from "react";

/**
 * 对话框底部的执行器水印:加粗淡灰大字,写着这一回合由哪个智能体来跑,切换时自动换。
 *
 * 字号跟着容器高度走。这里必须用 ResizeObserver 实测,不能用容器查询单位 `cqh` ——
 * `container-type: size` 会让容器不再由内容决定高度,而对话框恰恰是内容(textarea 可
 * 拖拽、附件行按需出现)撑出来的高度,一改就塌。
 *
 * 放在要装饰的框里当直接子元素即可,它自己观察父元素。父元素需要
 * `position: relative` 和 `overflow: hidden`。
 */
export function AgentPlate({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const plate = ref.current;
    const box = plate?.parentElement;
    if (!plate || !box) return;

    const apply = () => {
      const word = plate.firstElementChild as HTMLElement | null;
      if (!word) return;
      // 先按高度定字号,再按宽度收:名字长的(antigravity)不至于糊出框外。
      const byHeight = Math.min(Math.max(box.clientHeight * 0.34, 24), 92);
      plate.style.setProperty("--plate-size", `${byHeight}px`);
      const room = box.clientWidth - 24;
      const natural = word.scrollWidth;
      if (natural > room && room > 0) {
        plate.style.setProperty("--plate-size", `${byHeight * (room / natural)}px`);
      }
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(box);
    return () => observer.disconnect();
  }, [name]);

  return (
    // 名字在执行器胶囊上已经能读到,这里不重复播报。
    <div className="agent-plate" ref={ref} aria-hidden="true">
      <span className="agent-plate-word" key={name}>
        {name}
      </span>
    </div>
  );
}
