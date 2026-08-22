import { useEffect, useRef } from "react";

/** 水印倾斜角度,和 agent-plate.css 里的 --plate-tilt 必须一致。 */
const TILT_DEG = -9;
/** 旋转后的字占对话框多大:留白靠这个数控制。 */
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
  probe.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const m = probe.measureText(text);
  const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  return ink > 0 ? ink / size : 0.73;
}

/**
 * 对话框的执行器水印:以对话框中心为心斜铺一层极淡的大字,写着这一回合由哪个智能体
 * 来跑,切换时自动换。
 *
 * 字号按容器实测求解,不能用容器查询单位 `cqh` —— `container-type: size` 会让容器不再
 * 由内容决定高度,而对话框恰恰是内容(textarea 可拖拽、附件行按需出现)撑出来的高度。
 * 字宽和 ink 高度都随字号线性变化,所以量一次当前值换算出「每 1px 字号的尺寸」,再按
 * 旋转后的外接框同时满足宽、高两个约束,一次算到位,不用迭代逼近。
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
      // offsetWidth 不受 transform 影响,拿到的是旋转前的字宽
      const widthPerPx = word.offsetWidth / current;
      const heightPerPx = inkPerPx(style, word.textContent ?? "");

      const rad = (TILT_DEG * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const spanPerPx = {
        width: widthPerPx * cos + heightPerPx * sin,
        height: widthPerPx * sin + heightPerPx * cos,
      };

      const size = Math.min(
        (box.clientWidth * FILL) / spanPerPx.width,
        (box.clientHeight * FILL) / spanPerPx.height,
      );
      plate.style.setProperty("--plate-size", `${Math.max(12, size)}px`);
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
