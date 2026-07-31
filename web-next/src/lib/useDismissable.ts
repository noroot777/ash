import { useEffect, useRef, type RefObject } from "react";

export function useDismissable<
  Container extends HTMLElement,
  RestoreFocus extends HTMLElement = HTMLElement,
>({
  enabled,
  containerRef,
  onClose,
  restoreFocusRef,
}: {
  enabled: boolean;
  containerRef: RefObject<Container | null>;
  onClose: () => void;
  restoreFocusRef?: RefObject<RestoreFocus | null>;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;

    const closeOnOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || containerRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      restoreFocusRef?.current?.focus();
    };

    // Capture keeps dismissal reliable when the destination stops bubbling.
    // Click covers keyboard and assistive activation paths without pointerdown.
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("click", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("click", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [containerRef, enabled, restoreFocusRef]);
}
