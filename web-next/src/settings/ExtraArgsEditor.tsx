import { useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";

export function ExtraArgsEditor({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const token = draft.trim();
    if (!token) return;
    onChange([...value, token]);
    setDraft("");
  };

  return (
    <div className={`agent-args-editor${compact ? " is-compact" : ""}`}>
      <div className="agent-args-head">
        <span>额外 CLI 参数</span>
        <small>每项作为一个 token 传递；项内空格和引号保持原样。</small>
      </div>
      <div className="agent-args-list">
        {value.map((token, index) => (
          <span className="agent-arg-token" key={index}>
            <input
              aria-label={`参数 ${index + 1}`}
              value={token}
              disabled={disabled}
              onChange={(event) => onChange(value.map((item, itemIndex) => (
                itemIndex === index ? event.target.value : item
              )))}
            />
            <button
              type="button"
              aria-label={`删除参数 ${token}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
            >
              <X size={11} weight="bold" />
            </button>
          </span>
        ))}
        <span className="agent-arg-token is-new">
          <input
            value={draft}
            disabled={disabled}
            placeholder={value.length ? "继续添加" : "例如 --dangerously-skip-permissions"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button variant="ghost" disabled={disabled || !draft.trim()} onClick={add}>
            <Plus size={11} weight="bold" /> 添加
          </Button>
        </span>
      </div>
    </div>
  );
}
