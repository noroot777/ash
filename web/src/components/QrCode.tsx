import { useMemo } from "react";
import { qrMatrix } from "../lib/qr.ts";

/**
 * 把一段文本画成二维码。恒为白底黑码,不跟主题走:扫码器认的是明暗对比,深色主题下反过来
 * 画有一部分相机认不出。四周留 4 格空白也是标准要求的,不是留白好看。
 */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const path = useMemo(() => {
    const modules = qrMatrix(value);
    if (!modules) return null;
    const quiet = 4;
    let d = "";
    modules.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }));
    return { d, span: modules.length + quiet * 2 };
  }, [value]);
  if (!path) return null;
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${path.span} ${path.span}`}
      shapeRendering="crispEdges"
    >
      <rect width={path.span} height={path.span} fill="white" />
      <path d={path.d} fill="black" />
    </svg>
  );
}
