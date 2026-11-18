import { BARS, NEEDLE_NORTH, NEEDLE_SOUTH, VIEW } from "./naviMark.ts";

// 所有实例共用这一份元素。墨色跟文字色走，指北那半截是 --navi-north（styles/navi-brand.css）。
const NEEDLE = (
  <g className="navi-mark__needle">
    <polygon points={NEEDLE_SOUTH} />
    <polygon points={NEEDLE_NORTH} className="navi-mark__north" />
  </g>
);
const BAR_SHAPES = BARS.map((points) => <polygon key={points} points={points} />);

export interface NaviMarkProps {
  size?: number;
  /** 它独自代表 navi 时给，读屏才念得出来；旁边已经写着名字就不用。 */
  label?: string;
  className?: string;
}

/** navi 的标，静止的那张。 */
export function NaviMark({ size = 16, label, className }: NaviMarkProps) {
  return (
    <svg
      className={className ? `navi-mark ${className}` : "navi-mark"}
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {NEEDLE}
      {BAR_SHAPES}
    </svg>
  );
}
