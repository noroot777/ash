import { useEffect, useState } from "react";
import type { AppSettings } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { WorkflowPicker, useWorkflows } from "../workflow/WorkflowPicker.tsx";

// 预设几档就够了：这个值只影响「装了新技能后多久自己冒出来」，没人需要精确到秒。
// 0 = 不轮询（打开输入框那一下仍会拉一次，所以永远不会是空的）。
const SKILL_REFRESH_CHOICES = [
  { value: 0, label: "不自动刷新" },
  { value: 30, label: "每 30 秒" },
  { value: 60, label: "每 1 分钟" },
  { value: 300, label: "每 5 分钟" },
  { value: 900, label: "每 15 分钟" },
];

export function DefaultsSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const workflows = useWorkflows();
  // 库里存着预设之外的值（接口能存 10~3600 任意整数）时补一档，免得下拉显示空白。
  const seconds = settings.skillRefreshSeconds;
  const skillRefreshChoices = SKILL_REFRESH_CHOICES.some((choice) => choice.value === seconds)
    ? SKILL_REFRESH_CHOICES
    : [...SKILL_REFRESH_CHOICES, { value: seconds, label: `每 ${seconds} 秒` }].sort((a, b) => a.value - b.value);

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
          <div className="settings-row">
            <div>
              <b>输入框里 <code>/技能</code> 清单多久刷一次</b>
              <small>
                指的是页面隔多久去问一次服务端，不是服务端多久扫一次盘（它每次都真扫，命中缓存约 0.5ms）。
                装了新技能等不及可以关掉输入框再打开，那一下一定是新的
              </small>
            </div>
            <select
              value={String(settings.skillRefreshSeconds)}
              disabled={loading}
              aria-label="技能清单刷新间隔"
              onChange={async (event) => {
                const seconds = Number(event.target.value);
                try {
                  setSettings(await api.patchSettings({ skillRefreshSeconds: seconds }));
                } catch (error) {
                  notify(error instanceof Error ? error.message : "默认规则保存失败");
                }
              }}
            >
              {skillRefreshChoices.map((choice) => (
                <option key={choice.value} value={String(choice.value)}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
    </>
  );
}
