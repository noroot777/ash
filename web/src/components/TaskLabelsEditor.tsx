import { useState } from "react";
import { Plus, X } from "@phosphor-icons/react";

export type TaskLabelChange = {
  kind: "add" | "remove";
  label: string;
};

export function TaskLabelsEditor({
  labels,
  disabled = false,
  onChange,
}: {
  labels: string[];
  disabled?: boolean;
  onChange: (labels: string[], change: TaskLabelChange) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const label = draft.trim().replace(/^#/, "");
    setDraft("");
    if (!label || labels.includes(label)) return;
    onChange([...labels, label], { kind: "add", label });
  };

  return (
    <div className="task-label-editor">
      {labels.map((label) => (
        <button
          type="button"
          key={label}
          disabled={disabled}
          aria-label={`移除标签 ${label}`}
          onClick={() => onChange(
            labels.filter((item) => item !== label),
            { kind: "remove", label },
          )}
        >
          {label}<X size={10} aria-hidden="true" />
        </button>
      ))}
      {!disabled && (
        <label>
          <Plus size={11} aria-hidden="true" />
          <input
            value={draft}
            placeholder="添加"
            aria-label="添加标签"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={add}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add();
              }
            }}
          />
        </label>
      )}
    </div>
  );
}
