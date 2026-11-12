import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { ExtraArgsEditor } from "./ExtraArgsEditor.tsx";
import { anchoredBelowEnd, useFollowAnchor, type AnchoredPlace } from "./anchoredPlace.ts";

/**
 * 「额外 CLI 参数」的编辑浮层。入口在执行器表行尾那颗「更多」里（ProfileRowMenu），
 * 所以它挂在那颗按钮下面、右边缘对齐，portal 到 body：表格窄到横向滚动时它不会被裁掉。
 * 关掉统一走 useDismissable（点外面、Esc、焦点回「更多」）。
 */
export function ProfileArgsPopover({
  profileName,
  value,
  disabled,
  anchorRef,
  onClose,
  onSave,
}: {
  profileName: string;
  value: string[];
  disabled: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSave: (value: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [place, setPlace] = useState<AnchoredPlace | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const normalized = draft.map((token) => token.trim()).filter(Boolean);
  const dirty = normalized.join("\u0000") !== value.join("\u0000");

  useDismissable({ enabled: true, containerRef: boxRef, restoreFocusRef: anchorRef, onClose });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const box = boxRef.current;
    if (!anchor || !box) return;
    setPlace(anchoredBelowEnd(anchor, box));
  }, [anchorRef, draft.length]);
  useFollowAnchor(true, anchorRef, boxRef, setPlace);

  // 打开就把焦点交进来：停在「更多」上的话，键盘用户按 Tab 会跑到同排别的格子去。
  useEffect(() => {
    boxRef.current?.querySelector<HTMLInputElement>("input:not([disabled])")?.focus();
  }, []);

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (await onSave(normalized)) onClose();
  };

  return createPortal(
    <div
      className="agent-profile-args-popover is-anchored"
      ref={boxRef}
      role="dialog"
      aria-label={`${profileName} 的额外 CLI 参数`}
      style={place ? { left: place.left, top: place.top, bottom: place.bottom, zIndex: place.zIndex } : { visibility: "hidden" }}
    >
      <div className="agent-profile-args-popover-head">
        <div>
          <b>额外 CLI 参数</b>
          <small>{profileName} · 每项按单个 token 传递</small>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭参数编辑">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <ExtraArgsEditor value={draft} disabled={disabled} onChange={setDraft} />
      <div className="agent-profile-args-popover-actions">
        <span>{dirty ? "有未保存更改" : `${normalized.length} 项参数`}</span>
        <Button variant="ghost" disabled={disabled} onClick={onClose}>取消</Button>
        <Button disabled={disabled || !dirty} onClick={() => void save()}>
          {disabled ? "保存中…" : "保存参数"}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
