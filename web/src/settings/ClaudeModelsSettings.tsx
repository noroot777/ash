import { useEffect, useState } from "react";
import type { AppSettings } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import { useIsInstanceAdmin, useIsMultiUser } from "../auth/authContext.ts";
import { cliCatalogNote, useCliModelCatalog } from "../lib/cliModelCatalog.ts";
import { api } from "../lib/api.ts";

export function ClaudeModelsSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [models, setModels] = useState("");
  const [hours, setHours] = useState(6);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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

  const save = async () => {
    const custom = [...new Set(models.split(/[\n,]+/).map((id) => id.trim()).filter(Boolean))];
    setSaving(true);
    try {
      const next = await api.patchSettings({ claudeCustomModelIds: custom, claudeModelRefreshHours: hours });
      setSettings(next);
      setModels(next.claudeCustomModelIds.join("\n"));
      cli.refresh();
      notify("Claude 模型目录设置已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Claude 模型目录保存失败");
    } finally {
      setSaving(false);
    }
  };

  const changed = models !== settings.claudeCustomModelIds.join("\n") || hours !== settings.claudeModelRefreshHours;

  return (
    <section className="claude-model-settings" aria-label="Claude 官方账号模型目录">
      <div className="claude-model-settings-head">
        <div>
          <b>Claude 官方账号 · 完整模型 ID</b>
          <small>选 opus 等别名时由 CLI 决定具体版本；选完整 ID 时传入指定版本。</small>
        </div>
        <button type="button" className="model-refresh" disabled={cli.refreshing || !!cli.catalog?.skipped}
          onClick={cli.refresh}> {cli.refreshing ? "获取中…" : "立即从官方获取"}</button>
      </div>
      <small className={cli.catalog?.error ? "is-error" : ""}>{cliCatalogNote(cli.catalog)}</small>
      <div className="claude-model-settings-fields">
        <label>
          <span>自动获取间隔</span>
          <span className="claude-model-hours"><input type="number" min={1} max={168} step={1}
            aria-label="Claude 模型目录自动获取间隔（小时）" value={hours}
            disabled={loading || saving || !canEdit}
            onChange={(event) => setHours(Number(event.target.value))} /> 小时</span>
        </label>
        <label>
          <span>自己添加完整 ID（每行一个，也可用逗号分隔）</span>
          <textarea rows={3} value={models} disabled={loading || saving || !canEdit}
            placeholder={"claude-opus-4-6\nclaude-sonnet-4-6"}
            onChange={(event) => setModels(event.target.value)} />
        </label>
      </div>
      <div className="claude-model-settings-foot">
        <small>{!canEdit ? "多人实例的目录设置由管理员管理" : "官方目录仅提供候选；账号能否使用以实际请求为准。"}</small>
        <button type="button" disabled={loading || saving || !changed || !canEdit || !Number.isInteger(hours) || hours < 1 || hours > 168}
          onClick={() => void save()}>{saving ? "保存中…" : "保存目录设置"}</button>
      </div>
    </section>
  );
}
