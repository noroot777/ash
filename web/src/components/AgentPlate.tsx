import { useEffect, useRef } from "react";

/** 字占对话框多大:留白靠这个数控制。 */
const FILL = 0.8;

let probe: CanvasRenderingContext2D | null = null;

/**
 * 每 1px 字号对应的 ink 高度。用 canvas 量真实字形边界,而不是行盒——大写字母没有
 * 下伸部,行盒比字形高出近三成,拿行盒算会让字明显偏小。
 */
function inkPerPx(style: CSSStyleDeclaration, text: string): number {
  const size = parseFloat(style.fontSize) || 1;
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return 0.73;
  probe.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const m = probe.measureText(text);
  const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  return ink > 0 ? ink / size : 0.73;
}

/**
 * 对话框的执行器水印:在对话框中心铺一层极淡的斜体大字,写着这一回合由哪个智能体
 * 来跑,切换时自动换。
 *
 * 字号按容器实测求解,不能用容器查询单位 `cqh` —— `container-type: size` 会让容器不再
 * 由内容决定高度,而对话框恰恰是内容(textarea 可拖拽、附件行按需出现)撑出来的高度。
 * 字宽和 ink 高度都随字号线性变化,所以量一次当前值换算出「每 1px 字号的尺寸」,再取
 * 宽、高两个约束里更紧的那个,一次算到位,不用迭代逼近。
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
      const style = getComputedStyle(word);
      const current = parseFloat(style.fontSize) || 1;
      const widthPerPx = word.offsetWidth / current;
      const heightPerPx = inkPerPx(style, word.textContent ?? "");

      const size = Math.min(
        (box.clientWidth * FILL) / widthPerPx,
        (box.clientHeight * FILL) / heightPerPx,
      );
      plate.style.setProperty("--plate-size", `${Math.max(12, size)}px`);
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(box);

    // webfont 落地后字宽会变,但框的尺寸没变,ResizeObserver 不会响 —— 不补这一下,
    // 水印会一直按 fallback 字体的宽度停在错误尺寸,直到下次拖动输入框。
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) apply();
    });

    return () => {
      alive = false;
      observer.disconnect();
    };
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
