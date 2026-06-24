import { useCallback, useEffect, useRef, useState } from "react";

// Drives a transitions.dev enter/exit on an overlay that the parent mounts/unmounts
// via a boolean (every modal in this app: `{open && <Modal …/>}`). On mount it
// plays the enter animation next frame; `requestClose` plays the exit, then calls
// the parent's `onClose` (→ unmount) only after the close duration so the closing
// animation is actually seen. `closeVar` is the matching --…-close-dur custom prop
// so the JS timeout stays in sync with the stylesheet.
export type RevealState = "enter" | "open" | "closing";

export function useReveal(onClose: () => void, closeVar: string) {
  const [state, setState] = useState<RevealState>("enter");
  const closed = useRef(false);

  useEffect(() => {
    const id = requestAnimationFrame(() =>
      setState((s) => (s === "enter" ? "open" : s)),
    );
    return () => cancelAnimationFrame(id);
  }, []);

  const requestClose = useCallback(() => {
    if (closed.current) return; // guard double-fire (Esc + click, etc.)
    closed.current = true;
    setState("closing");
    const ms =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(closeVar),
      ) || 150;
    setTimeout(onClose, ms);
  }, [onClose, closeVar]);

  return { state, requestClose };
}

// Maps the reveal state to the .t-modal / .t-dropdown state class.
export function revealClass(state: RevealState): string {
  return state === "open" ? "is-open" : state === "closing" ? "is-closing" : "";
}

// Presence-driven variant for overlays the parent keeps mounted and toggles via
// an `open` prop (the command palette: `<CommandPalette open={…} />`). Returns
// `mounted` (keep the node in the DOM through the exit) and the reveal `state`.
// When `open` flips false it plays the close animation, then drops `mounted`.
export function usePresence(open: boolean, closeVar: string) {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<RevealState>(open ? "open" : "enter");
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setState("enter");
      const id = requestAnimationFrame(() => setState("open"));
      return () => cancelAnimationFrame(id);
    }
    if (!mountedRef.current) return; // never opened — nothing to animate out
    setState("closing");
    const ms =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(closeVar),
      ) || 150;
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, closeVar]);

  return { mounted, state };
}
