import { useCallback, useEffect, useRef, useState } from "react";

// Enter is pure CSS (a keyframe that plays when the node mounts — see .t-modal /
// .t-dropdown in index.css), so these hooks only own the EXIT: hold the node in
// the DOM while `.is-closing` plays the out keyframe, then drop it. Doing the
// enter in CSS avoids the brittle "mount at a base state, flip a class next
// frame" rAF dance, which loses races under React re-renders / StrictMode.

function readMs(varName: string): number {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(varName),
    ) || 150
  );
}

// For overlays the parent mounts/unmounts via `{open && <Modal/>}`. `requestClose`
// plays the exit, then calls the parent's `onClose` (→ unmount) after the close
// duration so the closing animation is actually seen.
export function useReveal(onClose: () => void, closeVar: string) {
  const [closing, setClosing] = useState(false);
  const closed = useRef(false);
  const requestClose = useCallback(() => {
    if (closed.current) return; // guard double-fire (Esc + click, etc.)
    closed.current = true;
    setClosing(true);
    setTimeout(onClose, readMs(closeVar));
  }, [onClose, closeVar]);
  return { closing, requestClose };
}

// For overlays the parent keeps mounted and toggles via an `open` prop (the
// command palette). Returns `mounted` (keep the node in the DOM through the exit)
// and `closing` (drives `.is-closing`). When `open` flips false it plays the out
// keyframe, then drops `mounted`.
export function usePresence(open: boolean, closeVar: string) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mountedRef.current) return; // never opened — nothing to animate out
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, readMs(closeVar));
    return () => clearTimeout(t);
  }, [open, closeVar]);

  return { mounted, closing };
}
