import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import { useIsInstanceAdmin, useIsMultiUser } from "../auth/authContext.ts";
import { Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { WorkflowPicker, useWorkflows } from "../workflow/WorkflowPicker.tsx";
import { HandoffSettings } from "./HandoffSettings.tsx";
import { InstanceModeCard } from "./InstanceModeCard.tsx";
import { SkillScanCard } from "./SkillScanCard.tsx";

export function DefaultsSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const workflows = useWorkflows();
  // 多人模式下「任务默认值」是个人面(各存各的),而技能扫描间隔、接力那几项是实例面
  // (§八)。这里只负责别把改不动的东西显示成能改 —— 真正的闸在服务端。
  const isMulti = useIsMultiUser();
  const isInstanceAdmin = useIsInstanceAdmin();
  const canManageInstance = !isMulti || isInstanceAdmin;

  useEffect(() => {
    api.settings()
      .then(setSettings)
      .catch((error) => notify(error instanceof Error ? error.message : "默认规则读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);

  const patchSkillRefresh = useCallback(
    async (seconds: number) => {
      try {
        setSettings(await api.patchSettings({ skillRefreshSeconds: seconds }));
      } catch (error) {
        notify(error instanceof Error ? error.message : "默认规则保存失败");
      }
    },
    [notify],
  );

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>默认规则</h1>
          <p>设置新任务的初始行为；创建任务时仍可单独覆盖。</p>
        </div>
      </header>
      <section className="settings-section">
        <h2>任务默认值</h2>
        {isMulti && (
          <p className="settings-note">这一节只对你生效，别人有各自的一份。</p>
        )}
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
      <HandoffSettings
        settings={settings}
        loading={loading}
        onSettings={setSettings}
        notify={notify}
      />
      <SkillScanCard
        seconds={settings.skillRefreshSeconds}
        loading={loading}
        readOnly={!canManageInstance}
        onChangeSeconds={patchSkillRefresh}
        notify={notify}
      />
      {canManageInstance && (
        <InstanceModeCard
          settings={settings}
          loading={loading}
          onSettings={setSettings}
          notify={notify}
        />
      )}
    </>
  );
}
