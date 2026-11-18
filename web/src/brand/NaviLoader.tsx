import { NaviMark, type NaviMarkProps } from "./NaviMark.tsx";

/**
 * 加载动画「找北」：只有针在转，甩出去、晃几下、回到正北歇一拍；歇着的时候就是静止的标。
 * 等一块内容读出来的地方用它。旁边已经有一句「正在读取…」时不用给 label；它独自表示「在加载」时给一个。
 */
export function NaviLoader({ className, ...props }: NaviMarkProps) {
  return <NaviMark {...props} className={className ? `navi-loader ${className}` : "navi-loader"} />;
}
