import { useEffect, useState } from "react";
import type { AppSettings } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { WorkflowPicker, useWorkflows } from "../workflow/WorkflowPicker.tsx";

export function DefaultsSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const workflows = useWorkflows();

  useEffect(() => {
    api.settings()
      .then(setSettings)
      .catch((error) => notify(error instanceof Error ? error.message : "默认规则读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>默认规则</h1>
          <p>设置新任务的系统级初始行为；创建任务时仍可单独覆盖。</p>
        </div>
      </header>
      <section className="settings-section">
        <h2>任务默认值</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>新任务默认使用 worktree</b>
              <small>仅 Git 项目生效；每张新任务仍可单独覆盖</small>
            </div>
            <Toggle
              label={settings.worktreeDefault ? "已开启" : "已关闭"}
              checked={settings.worktreeDefault}
              disabled={loading}
              onChange={async (checked) => {
                try {
                  setSettings(await api.patchSettings({ worktreeDefault: checked }));
                } catch (error) {
                  notify(error instanceof Error ? error.message : "默认规则保存失败");
                }
              }}
            />
          </div>
          <div className="settings-row">
            <div>
              <b>新任务默认走哪条起手式</b>
              <small>项目可以再单独指一条；任务在创建那一刻把线拷进自己兜里，之后改这儿不影响它</small>
            </div>
            <WorkflowPicker
              value={settings.defaultWorkflowId}
              items={workflows}
              inheritLabel="用系统推荐的那条"
              disabled={loading}
              onChange={async (workflowId) => {
                try {
                  setSettings(await api.patchSettings({ defaultWorkflowId: workflowId }));
                } catch (error) {
                  notify(error instanceof Error ? error.message : "默认规则保存失败");
                }
              }}
            />
          </div>
        </div>
      </section>
    </>
  );
}
