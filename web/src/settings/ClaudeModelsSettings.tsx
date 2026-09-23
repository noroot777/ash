import { useEffect, useState } from "react";
import type { AppSettings } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import type { CliModelCatalog } from "@ash/shared/cli-presets";
import { useIsInstanceAdmin, useIsMultiUser } from "../auth/authContext.ts";
import { cliCatalogNote, useCliModelCatalog } from "../lib/cliModelCatalog.ts";
import { api } from "../lib/api.ts";

type RefreshResult = { text: string; error: boolean };

function refreshFailure(catalog: CliModelCatalog | null): string {
  if (catalog?.error) return catalog.error;
  if (catalog?.skipped) return catalog.skipped;
  if (catalog?.probeSupported === false) return "当前 ash 服务端尚不支持官方文档模型目录，请更新并重启服务端";
  return "服务端未返回官方目录，请检查服务端版本或网络";
}

export function ClaudeModelsSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [models, setModels] = useState("");
  const [hours, setHours] = useState(6);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetchResult, setFetchResult] = useState<RefreshResult | null>(null);
  const isMulti = useIsMultiUser();
  const isAdmin = useIsInstanceAdmin();
  const canEdit = !isMulti || isAdmin;
  const cli = useCliModelCatalog("claude");

  useEffect(() => {
    api.settings().then((current) => {
      setSettings(current);
      setModels(current.claudeCustomModelIds.join("\n"));
      setHours(current.claudeModelRefreshHours);
    }).catch((error) => notify(error instanceof Error ? error.message : "Claude 模型设置读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);

  const persist = async () => {
    const custom = [...new Set(models.split(/[\n,]+/).map((id) => id.trim()).filter(Boolean))];
    const next = await api.patchSettings({ claudeCustomModelIds: custom, claudeModelRefreshHours: hours });
    setSettings(next);
    setModels(next.claudeCustomModelIds.join("\n"));
  };

  const changed = models !== settings.claudeCustomModelIds.join("\n") || hours !== settings.claudeModelRefreshHours;
  const validHours = Number.isInteger(hours) && hours >= 1 && hours <= 168;

  const refreshCatalog = async (): Promise<RefreshResult> => {
    try {
      const catalog = await cli.refresh();
      if (catalog?.source === "docs") {
        return { text: `已从官方更新模型目录 · ${catalog.models.length} 个候选 · ${new Date(catalog.probedAt ?? Date.now()).toLocaleTimeString()}`, error: false };
      }
      return { text: `官方目录未更新：${refreshFailure(catalog)}`, error: true };
    } catch (error) {
      return { text: error instanceof Error ? error.message : "官方目录获取失败", error: true };
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await persist();
      const result = await refreshCatalog();
      const savedResult = { ...result, text: `目录设置已保存；${result.text}` };
      setFetchResult(savedResult);
      notify(savedResult.text);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Claude 模型目录保存失败");
    } finally {
      setSaving(false);
    }
  };

  const refreshNow = async () => {
    setFetchResult({ text: "正在从官方获取模型目录…", error: false });
    if (changed) {
      if (!canEdit || !validHours) return;
      setSaving(true);
      try {
        await persist();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Claude 模型目录保存失败，未获取官方目录";
        setFetchResult({ text: message, error: true });
        notify(message);
        return;
      } finally {
        setSaving(false);
      }
    }
    const result = await refreshCatalog();
    setFetchResult(result);
    notify(result.text);
  };

  return (
    <section className="claude-model-settings" aria-label="Claude 官方账号模型目录">
      <div className="claude-model-settings-head">
        <div>
          <b>Claude 官方账号 · 模型目录</b>
          <small>选 opus 等别名时由 CLI 决定具体版本；选完整 ID 时传入指定版本。</small>
        </div>
        <div className="claude-model-fetch">
          <label>
            <span>自动获取间隔</span>
            <span className="claude-model-hours"><input type="number" min={1} max={168} step={1}
              aria-label="Claude 模型目录自动获取间隔（小时）" value={hours}
              disabled={loading || saving || !canEdit}
              onChange={(event) => setHours(Number(event.target.value))} /> 小时</span>
          </label>
          <button type="button" className="model-refresh"
            disabled={loading || saving || cli.refreshing || (changed && (!canEdit || !validHours))}
            onClick={() => void refreshNow()}>{saving ? "保存中…" : cli.refreshing ? "获取中…" : "立即从官方获取"}</button>
        </div>
      </div>
      <small className={cli.catalog?.error ? "is-error" : ""}>{cliCatalogNote(cli.catalog)}</small>
      {fetchResult && <small className={fetchResult.error ? "is-error" : ""} role="status" aria-live="polite">{fetchResult.text}</small>}
      <label className="claude-model-custom">
        <span>自己添加完整 ID（每行一个，也可用逗号分隔）</span>
        <textarea rows={3} value={models} disabled={loading || saving || !canEdit}
          placeholder={"claude-opus-4-6\nclaude-sonnet-4-6"}
          onChange={(event) => setModels(event.target.value)} />
      </label>
      <div className="claude-model-settings-foot">
        <small>{!canEdit ? "多人实例的目录设置由管理员管理" : "官方目录仅提供候选；账号能否使用以实际请求为准。"}</small>
        <button type="button" disabled={loading || saving || !changed || !canEdit || !validHours}
          onClick={() => void save()}>{saving ? "保存中…" : "保存目录设置"}</button>
      </div>
    </section>
  );
}
