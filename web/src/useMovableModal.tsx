import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CornersIn, CornersOut } from "@phosphor-icons/react";
import { Tip } from "./Tip";

type Position = { left: number; top: number };
type DragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const clampPosition = (position: Position, width: number, height: number): Position => ({
  left: clamp(position.left, 0, Math.max(0, window.innerWidth - width)),
  top: clamp(position.top, 0, Math.max(0, window.innerHeight - height)),
});

export function useMovableModal() {
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef<Position | null>(null);
  const [position, setPositionState] = useState<Position | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const setPosition = useCallback((next: Position | null) => {
    positionRef.current = next;
    setPositionState(next);
  }, []);

  const isPositioned = position !== null;
  useEffect(() => {
    if (isFullscreen || !isPositioned || !cardRef.current) return;
    const card = cardRef.current;
    const keepInViewport = () => {
      if (!positionRef.current) return;
      const next = clampPosition(positionRef.current, card.offsetWidth, card.offsetHeight);
      if (next.left !== positionRef.current.left || next.top !== positionRef.current.top) setPosition(next);
    };
    keepInViewport();
    const resizeObserver = new ResizeObserver(keepInViewport);
    resizeObserver.observe(card);
    window.addEventListener("resize", keepInViewport);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", keepInViewport);
    };
  }, [isFullscreen, isPositioned, setPosition]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isFullscreen || event.button !== 0) return;
    if ((event.target as Element).closest("button, input, textarea, select, a, [role='button']")) return;
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
    setPosition({ left: rect.left, top: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [isFullscreen, setPosition]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(clampPosition(
      { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY },
      drag.width,
      drag.height,
    ));
  }, [setPosition]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    dragRef.current = null;
    setIsFullscreen((current) => !current);
  }, []);

  const cardStyle: CSSProperties | undefined = isFullscreen
    ? {
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        maxWidth: "none",
        maxHeight: "none",
        borderRadius: 0,
      }
    : position
      ? { position: "fixed", left: position.left, top: position.top }
      : undefined;

  return {
    cardRef,
    cardStyle,
    isFullscreen,
    toggleFullscreen,
    headerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
      className: isFullscreen ? "select-none" : "touch-none select-none cursor-grab active:cursor-grabbing",
    },
  };
}

export function ModalFullscreenButton({
  isFullscreen,
  onToggle,
}: {
  isFullscreen: boolean;
  onToggle: () => void;
}) {
  const label = isFullscreen ? "还原窗口" : "全屏显示";
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-pressed={isFullscreen}
        onClick={onToggle}
        className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
      >
        {isFullscreen ? <CornersIn size={16} /> : <CornersOut size={16} />}
      </button>
    </Tip>
  );
}
