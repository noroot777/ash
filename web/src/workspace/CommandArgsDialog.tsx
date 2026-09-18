import { useState } from "react";
import { Play } from "@phosphor-icons/react";
import {
  fillCommandPlaceholders,
  MAX_PLACEHOLDER_VALUE_LENGTH,
  missingCommandValues,
  parseCommandPlaceholders,
} from "@ash/shared/project-commands";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import "./command-args-dialog.css";

// 带 `{{占位符}}` 的常用命令,点执行时先弹这个框收值(shared/src/project-commands.ts)。
// 取值只是**送给后端**的参数,真正的替换在服务端做 —— 这里预览出来的那行脚本是给人看的,
// 不参与执行。
//
// 上次填过的值记在 localStorage 里,下次开框就是上次那套(改端口/换分支这类命令,多数时候
// 值是同一个;每次从空白开始等于把便利又收回去了)。没记过的退回占位符自己的默认值。

const storageKey = "ash:command-args";

type ValueMap = Record<string, string>;

function readRemembered(key: string): ValueMap {
  try {
    const all = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    const mine = all[key];
    if (!mine || typeof mine !== "object") return {};
    const out: ValueMap = {};
    for (const [name, value] of Object.entries(mine as Record<string, unknown>)) {
      if (typeof value === "string") out[name] = value;
    }
    return out;
  } catch { return {}; }
}

function remember(key: string, values: ValueMap): void {
  try {
    const all = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    all[key] = values;
    localStorage.setItem(storageKey, JSON.stringify(all));
  } catch { /* 禁用存储时只是下次不预填,不影响执行。 */ }
}

/** 开框时每个占位符的初值：上次填的 → 占位符默认值 → 空。 */
export function initialCommandValues(rememberKey: string, script: string): ValueMap {
  const remembered = readRemembered(rememberKey);
  const values: ValueMap = {};
  for (const placeholder of parseCommandPlaceholders(script)) {
    values[placeholder.name] = remembered[placeholder.name] ?? placeholder.defaultValue ?? "";
  }
  return values;
}

export function CommandArgsDialog({ commandName, actionLabel, script, rememberKey, busy, onRun, onClose }: {
  commandName: string;
  /** 「启动」/「重启」/「执行」——按钮和标题都用它。 */
  actionLabel: string;
  script: string;
  rememberKey: string;
  busy?: boolean;
  onRun: (values: ValueMap) => void;
  onClose: () => void;
}) {
  const placeholders = parseCommandPlaceholders(script);
  const [values, setValues] = useState<ValueMap>(() => initialCommandValues(rememberKey, script));
  const missing = missingCommandValues(script, values);
  // 预览行只为「看清这次到底要跑什么」。取值非法(换行之类)时 fill 会抛,那就先不预览。
  const preview = (() => {
    try { return fillCommandPlaceholders(script, values); }
    catch { return null; }
  })();

  const run = () => {
    if (missing.length || busy) return;
    remember(rememberKey, values);
    onRun(values);
  };

  return <ConfirmDialog
    title={`${actionLabel}「${commandName}」`}
    message="这条命令带占位符，填好取值再执行。取值原样替换进命令。"
    eyebrow="RUN COMMAND"
    icon={<Play size={18} weight="fill" />}
    className="command-args-dialog"
    confirmLabel={actionLabel}
    confirmDisabled={missing.length > 0}
    busy={busy}
    onConfirm={run}
    onClose={onClose}
  >
    <div className="command-args__fields">
      {placeholders.map((placeholder, index) => (
        <label className="command-args__field" key={placeholder.name}>
          <span>
            {placeholder.name}
            {placeholder.defaultValue === null
              ? <em className="is-required">必填</em>
              : <em>留空 = {placeholder.defaultValue || "空"}</em>}
          </span>
          <input
            value={values[placeholder.name] ?? ""}
            autoFocus={index === 0}
            spellCheck={false}
            maxLength={MAX_PLACEHOLDER_VALUE_LENGTH}
            disabled={busy}
            placeholder={placeholder.defaultValue ?? ""}
            onChange={(event) => setValues((current) => ({ ...current, [placeholder.name]: event.target.value }))}
          />
        </label>
      ))}
    </div>
    {preview !== null && <pre className="command-args__preview" aria-label="这次要执行的命令">{preview}</pre>}
  </ConfirmDialog>;
}
