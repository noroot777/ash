import { useCallback, useEffect, useState } from "react";
import type { AppSettings, HandoffTarget } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { Plus, Trash } from "@phosphor-icons/react";
import { Button, TextInput, Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { WorkflowPicker, useWorkflows } from "../workflow/WorkflowPicker.tsx";
import { SkillScanCard } from "./SkillScanCard.tsx";

const HANDOFF_URL_RE = /^https?:\/\/\S+$/;

export function DefaultsSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  // 接力目标另存一份草稿:半填的行(名字有了 url 还没敲完)留在本地继续编辑,
  // 只有完整合法的行才落库,所以不能每次都用服务端返回值倒灌回输入框。
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const workflows = useWorkflows();

  useEffect(() => {
    api.settings()
      .then((loaded) => {
        setSettings(loaded);
        setTargets(loaded.handoffTargets);
      })
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

  const saveTargets = useCallback(
    async (next: HandoffTarget[]) => {
      setTargets(next);
      const complete = next
        .filter((item) => item.name.trim() && HANDOFF_URL_RE.test(item.url.trim()))
        .map((item) => ({ name: item.name.trim(), url: item.url.trim().replace(/\/+$/, "") }));
      if (JSON.stringify(complete) === JSON.stringify(settings.handoffTargets)) return;
      try {
        setSettings(await api.patchSettings({ handoffTargets: complete }));
      } catch (error) {
        notify(error instanceof Error ? error.message : "接力目标保存失败");
      }
    },
    [notify, settings.handoffTargets],
  );

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
      <section className="settings-section">
        <h2>任务接力</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>接力目标机器</b>
              <small>另一台 harness 的根地址，须与本机在同一内网可达；当前版本无鉴权，别配公网地址</small>
            </div>
            <Button
              variant="ghost"
              disabled={loading}
              onClick={() => setTargets([...targets, { name: "", url: "" }])}
            >
              <Plus size={13} aria-hidden="true" />添加
            </Button>
          </div>
          {targets.map((item, index) => (
            <div className="settings-row handoff-target-row" key={index}>
              <TextInput
                placeholder="名字（如 家里的台式机）"
                className="handoff-target-name"
                value={item.name}
                disabled={loading}
                onChange={(event) => {
                  const next = targets.slice();
                  next[index] = { ...item, name: event.target.value };
                  setTargets(next);
                }}
                onBlur={() => void saveTargets(targets)}
              />
              <TextInput
                placeholder="http://192.168.1.50:4317"
                value={item.url}
                disabled={loading}
                onChange={(event) => {
                  const next = targets.slice();
                  next[index] = { ...item, url: event.target.value };
                  setTargets(next);
                }}
                onBlur={() => void saveTargets(targets)}
              />
              <Button
                variant="icon"
                aria-label={`删除接力目标 ${item.name || item.url || String(index + 1)}`}
                disabled={loading}
                onClick={() => void saveTargets(targets.filter((_, i) => i !== index))}
              >
                <Trash size={13} aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      </section>
      <SkillScanCard
        seconds={settings.skillRefreshSeconds}
        loading={loading}
        onChangeSeconds={patchSkillRefresh}
        notify={notify}
      />
    </>
  );
}
