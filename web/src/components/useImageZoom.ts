import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from "react";

/**
 * 看图时的缩放与平移：大图灯箱和文件查看器共用这一份，工具条是 `ImageZoomControls`。
 *
 * 图片本身照旧按 CSS 的 max-width/max-height 「适应容器」排版，缩放只叠一层 transform：
 * `scale` 是相对适应尺寸的倍数（1 = 适应容器），`x/y` 是相对排版位置的平移。这样排版
 * 永远不变，滚轮、拖拽、双指只改 transform，不会触发重排；换图或容器尺寸一变就回到 1。
 * 平移的边界按图片的 offsetParent 算，所以容器得是定位元素（灯箱是 fixed，文件查看器
 * 的图片区是 relative）。
 */
type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };

const FIT: View = { scale: 1, x: 0, y: 0 };
const BUTTON_STEP = 1.5;

export type ImageZoom = ReturnType<typeof useImageZoom>;

export function useImageZoom(src: string, containerRef: RefObject<HTMLElement | null>) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(FIT);
  const [animated, setAnimated] = useState(false);
  const [dragging, setDragging] = useState(false);
  // 适应窗口时一个显示像素对应多少原图像素的倒数：读数按原图像素算，100% = 实际大小。
  const [fitRatio, setFitRatio] = useState(1);
  const pointers = useRef(new Map<number, Point>());
  // 单指按下的位置；第二根手指一落下就作废，那是捏合不是点击。
  const press = useRef<Point | null>(null);

  const [zoomSrc, setZoomSrc] = useState(src);
  if (zoomSrc !== src) {
    setZoomSrc(src);
    setView(FIT);
    setAnimated(false);
  }

  // 至少能放到适应尺寸的 4 倍，也至少能看到原图像素的 2 倍。
  const maxScale = Math.max(4, 2 / fitRatio);
  // 排版只缩不放（max-width/max-height），所以没被缩小时 clientWidth 与 naturalWidth 整数相等、
  // 比值恰好是 1；只要被缩小过哪怕 1 像素，这里就严格大于 1。不需要也不该再拿阈值去猜。
  const actualScale = 1 / fitRatio;

  const measure = useCallback(() => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.clientWidth) return;
    setFitRatio(image.clientWidth / image.naturalWidth);
  }, []);

  useLayoutEffect(() => {
    if (imageRef.current?.complete) measure();
  }, [measure, src]);

  // 换图时上一张没收尾的手势作废，免得半截拖拽/捏合落到新图上。
  useEffect(() => {
    pointers.current.clear();
    press.current = null;
    setDragging(false);
  }, [src]);

  // 看的是容器而不是窗口：文件查看器所在的中栏会随侧栏开合、铺满放大而变宽变窄，窗口却没动。
  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    // 观察器挂上就会先报一次当前尺寸，那一次不是「变了」——当成变化会把刚打开就做的缩放撤掉。
    let last = { width: box.clientWidth, height: box.clientHeight };
    const observer = new ResizeObserver(() => {
      const size = { width: box.clientWidth, height: box.clientHeight };
      if (size.width === last.width && size.height === last.height) return;
      last = size;
      setAnimated(false);
      setView(FIT);
      measure();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [containerRef, measure]);

  // 平移只在图比视口大的那条轴上放开，且图的边缘不能拖进视口里留出空白。
  const clamp = useCallback((next: View): View => {
    const image = imageRef.current;
    const box = image?.offsetParent as HTMLElement | null;
    if (!image || !box) return next;
    const axis = (offset: number, size: number, viewport: number, value: number) => {
      const scaled = size * next.scale;
      if (scaled <= viewport) return 0;
      const center = offset + size / 2;
      return Math.min(scaled / 2 - center, Math.max(viewport - center - scaled / 2, value));
    };
    return {
      scale: next.scale,
      x: axis(image.offsetLeft, image.offsetWidth, box.clientWidth, next.x),
      y: axis(image.offsetTop, image.offsetHeight, box.clientHeight, next.y),
    };
  }, []);

  // 以视口里的某一点为锚缩放：缩放前后那一点下面始终是图上同一个位置。不给锚点就以图心为锚。
  // 目标倍数按「当前倍数」现算：连续的滚轮/捏合事件可能赶在重渲染之前到，闭包里的倍数是旧的。
  const zoom = useCallback((target: (scale: number) => number, anchor?: Point, pan?: Point) => {
    setView((current) => {
      const scale = Math.min(maxScale, Math.max(1, target(current.scale)));
      const image = imageRef.current;
      const box = image?.offsetParent as HTMLElement | null;
      let { x, y } = current;
      if (anchor && image && box) {
        const rect = box.getBoundingClientRect();
        const ratio = scale / current.scale;
        const dx = anchor.x - (rect.left + image.offsetLeft + image.offsetWidth / 2 + current.x);
        const dy = anchor.y - (rect.top + image.offsetTop + image.offsetHeight / 2 + current.y);
        x += dx * (1 - ratio);
        y += dy * (1 - ratio);
      }
      if (pan) {
        x += pan.x;
        y += pan.y;
      }
      return scale === 1 ? FIT : clamp({ scale, x, y });
    });
  }, [clamp, maxScale]);

  const zoomIn = useCallback(() => {
    setAnimated(true);
    zoom((scale) => scale * BUTTON_STEP);
  }, [zoom]);
  const zoomOut = useCallback(() => {
    setAnimated(true);
    zoom((scale) => scale / BUTTON_STEP);
  }, [zoom]);
  const reset = useCallback(() => {
    setAnimated(true);
    setView(FIT);
  }, []);
  // 适应窗口 ⇄ 实际大小；原图本来就不比窗口大时，「实际大小」就是适应尺寸，改成放大一倍。
  const toggle = useCallback((anchor?: Point) => {
    setAnimated(true);
    zoom((scale) => scale > 1 ? 1 : actualScale > 1 ? actualScale : 2, anchor);
  }, [actualScale, zoom]);

  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    // React 的 onWheel 是被动监听，拦不住页面缩放，只能自己挂非被动的。
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      // 触控板双指捏合以 ctrlKey 滚轮事件送来，幅度比鼠标滚轮一格小一个量级。
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002));
      setAnimated(false);
      zoom((scale) => scale * factor, { x: event.clientX, y: event.clientY });
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [containerRef, zoom]);

  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    press.current = pointers.current.size === 1 ? { x: event.clientX, y: event.clientY } : null;
    setAnimated(false);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = { x: event.clientX, y: event.clientY };
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId);
    pointers.current.set(event.pointerId, point);
    if (others.length === 0) {
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      setView((current) => current.scale > 1 ? clamp({ ...current, x: current.x + dx, y: current.y + dy }) : current);
      return;
    }
    // 双指：两指间距之比是缩放，两指中点的位移是平移。以挪动前的中点为锚缩放，再把它搬到
    // 新中点——两指下面始终是图上同一处。
    const other = others[0]![1];
    const before = Math.hypot(previous.x - other.x, previous.y - other.y);
    const after = Math.hypot(point.x - other.x, point.y - other.y);
    if (!before) return;
    const mid = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
    zoom((scale) => scale * (after / before), mid, { x: (point.x - previous.x) / 2, y: (point.y - previous.y) / 2 });
  };
  const onPointerEnd = (event: PointerEvent<HTMLImageElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pointers.current.size > 0) return;
    setDragging(false);
    // 按下到松开几乎没动才算点击（适应窗口 ⇄ 实际大小）；拖过、捏过都不算。
    const start = press.current;
    press.current = null;
    if (event.type === "pointerup" && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) {
      toggle({ x: event.clientX, y: event.clientY });
    }
  };

  const style: CSSProperties = {
    transform: view.scale === 1 ? undefined : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    transition: animated ? "transform 180ms cubic-bezier(.2, .7, .2, 1)" : "none",
    cursor: view.scale > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
  };

  return {
    imageRef,
    percent: Math.round(view.scale * fitRatio * 100),
    imageProps: {
      style,
      onLoad: measure,
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
    canZoomIn: view.scale < maxScale - 0.001,
    canZoomOut: view.scale > 1,
    zoomIn,
    zoomOut,
    reset,
    toggle,
  };
}
