import { useState } from "react";
import type { GitAction, GitActionRequest } from "@ash/shared/git-workbench";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

export interface ActionField {
  key: string;
  label: string;
  initial?: string;
  placeholder?: string;
  type?: "text" | "textarea" | "select" | "checkbox";
  options?: { value: string; label: string }[];
  required?: boolean;
}
export interface ActionPrompt {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  typed?: string;
  fields?: ActionField[];
  action: (values: Record<string, string>) => GitAction;
}
export type AskAction = (prompt: ActionPrompt) => void;
export const initialActionValues = (prompt: ActionPrompt) =>
  Object.fromEntries(
    (prompt.fields || []).map((field) => [field.key, field.initial || ""]),
  );
export function ActionDialog({
  prompt,
  snapshot,
  run,
  isBlocked,
  close,
}: {
  prompt: ActionPrompt;
  snapshot: Pick<GitActionRequest, "root" | "version">;
  run: (
    action: GitAction,
    confirmation: string | undefined,
    snapshot: Pick<GitActionRequest, "root" | "version">,
  ) => Promise<boolean>;
  isBlocked: (kind: GitAction["kind"]) => boolean;
  close: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialActionValues(prompt),
  );
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const valid =
    !failed &&
    !isBlocked(prompt.action(values).kind) &&
    (!prompt.typed || prompt.typed === typed) &&
    (prompt.fields || []).every(
      (field) => !field.required || values[field.key]?.trim(),
    );
  const submitAction = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await run(
      prompt.action(values),
      prompt.typed ? typed : undefined,
      snapshot,
    );
    setBusy(false);
    if (ok) close();
    else setFailed(true);
  };
  return (
    <ConfirmDialog
      title={prompt.title}
      message={prompt.message}
      confirmLabel={prompt.confirmLabel || prompt.title}
      danger={prompt.danger}
      busy={busy}
      confirmDisabled={!valid}
      onConfirm={() => void submitAction()}
      onClose={close}
      className="git-action-dialog gwb-design"
    >
      <div className="gwb-form">
        {prompt.fields?.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            {field.type === "select" ? (
              <select
                value={values[field.key]}
                onChange={(event) =>
                  setValues({ ...values, [field.key]: event.target.value })
                }
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "checkbox" ? (
              <input
                type="checkbox"
                checked={values[field.key] === "true"}
                onChange={(event) =>
                  setValues({
                    ...values,
                    [field.key]: String(event.target.checked),
                  })
                }
              />
            ) : field.type === "textarea" ? (
              <textarea
                rows={4}
                value={values[field.key]}
                onChange={(event) =>
                  setValues({ ...values, [field.key]: event.target.value })
                }
                placeholder={field.placeholder}
              />
            ) : (
              <input
                value={values[field.key]}
                onChange={(event) =>
                  setValues({ ...values, [field.key]: event.target.value })
                }
                placeholder={field.placeholder}
              />
            )}
          </label>
        ))}
        {prompt.typed && (
          <label>
            <span>
              输入 <code>{prompt.typed}</code> 确认
            </span>
            <input
              aria-label="输入目标以确认"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        {failed && (
          <p role="alert">
            本次操作未完成，详情已保留在页面与操作日志中。请关闭此窗口，检查最新状态后重新操作。
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
