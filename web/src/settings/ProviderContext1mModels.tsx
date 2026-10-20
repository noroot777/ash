import { useMemo, useState } from "react";
import { ArrowsClockwise, CaretDown } from "@phosphor-icons/react";
import { Button, Checkbox } from "../components/ui.tsx";
import type { ProviderCatalog } from "./useProviderCatalog.ts";

function uniqueModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const model of models) {
    const value = model.trim();
    if (value) seen.add(value.replace(/\[1m\]$/i, ""));
  }
  return [...seen];
}

export function ProviderContext1mModels({
  providerId,
  defaultModel,
  pinnedModels,
  catalog,
  selectedModels,
  onChange,
}: {
  providerId?: string;
  defaultModel: string;
  pinnedModels: string[];
  /** 整个表单共用的那份模型目录：上面探过了，这里就有的挑。 */
  catalog: ProviderCatalog;
  selectedModels: string[];
  onChange: (models: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const panelId = `provider-${providerId ?? "new"}-context-1m`;
  const { models: probedModels, probing, error: probeError, probe } = catalog;

  const models = useMemo(
    () => uniqueModels([defaultModel, ...pinnedModels, ...probedModels, ...selectedModels]),
    [probedModels, defaultModel, pinnedModels, selectedModels],
  );
  const visibleModels = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return keyword ? models.filter((model) => model.toLowerCase().includes(keyword)) : models;
  }, [filter, models]);
  const selected = useMemo(() => new Set(selectedModels), [selectedModels]);

  const toggle = (model: string, checked: boolean) => {
    onChange(checked
      ? uniqueModels([...selectedModels, model])
      : selectedModels.filter((item) => item !== model));
  };

  return (
    <div className="provider-context-1m t-acc" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="provider-context-head t-acc-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="provider-context-title">
          <b>1M 上下文模型</b>
          <small>只有勾选的模型经过本地转发；其他模型保持直接连接。</small>
        </span>
        <span className={`provider-context-summary${selectedModels.length ? " is-active" : ""}`}>
          {selectedModels.length ? `已启用 ${selectedModels.length} 个` : "未启用"}
        </span>
        <span className="t-acc-chevron" aria-hidden="true"><CaretDown size={14} weight="bold" /></span>
      </button>

      <div className="t-acc-panel" id={panelId} aria-hidden={!open} inert={!open}>
        <div className="t-acc-panel-inner provider-context-panel">
          <div className="provider-context-toolbar">
            <input
              value={filter}
              placeholder="筛选模型"
              aria-label="筛选 1M 上下文模型"
              onChange={(event) => setFilter(event.target.value)}
            />
            <Button disabled={probing} onClick={() => void probe()}>
              <ArrowsClockwise size={12} className={probing ? "provider-spin" : ""} />
              {probing ? "探测中…" : "探测模型"}
            </Button>
          </div>
          {probeError && <small className="is-error">{probeError}</small>}
          {visibleModels.length ? (
            <ul className="provider-context-list">
              {visibleModels.map((model) => {
                const enabled = selected.has(model);
                return (
                  <li key={model} className={enabled ? "is-enabled" : ""}>
                    <Checkbox
                      checked={enabled}
                      onChange={(checked) => toggle(model, checked)}
                      label={model}
                    />
                    <span>{enabled ? "1M · 经本地转发" : "标准 · 直接连接"}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <small className="settings-muted">先设置默认或固定模型，也可以点击“探测模型”获取完整目录。</small>
          )}
        </div>
      </div>
    </div>
  );
}
