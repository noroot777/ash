import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentExecutorProfile, LlmProvider } from "@ash/shared";
import { hasCliConfigOverrides, cliSpeedOverrideConflict } from "@ash/shared/cli-overrides";
import { Star } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { Select, type SelectOption } from "../components/Select.tsx";
import { EffortPicker } from "../components/EffortPicker.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  providerProtocolForAgent,
  providersForAgent,
} from "./agentProviderRules.ts";
import { ProfileOverridesControl } from "./ProfileOverridesControl.tsx";
import { ProfileRowMenu } from "./ProfileRowMenu.tsx";
import { ProviderModelInput, type ClaudeModelMode } from "./ProviderModelInput.tsx";

const SPEED_CHOICES: SelectOption<"standard" | "fast">[] = [
  { value: "standard", label: "标准" },
  { value: "fast", label: "1.5x" },
];

export function AgentProfileRow({
  profile,
  providers,
  onChange,
  onProviderChanged,
  onClaudeModeChange,
  notify,
}: {
  profile: AgentExecutorProfile;
  providers: LlmProvider[];
  onChange: (profile: AgentExecutorProfile | null) => void;
  onProviderChanged: (provider: LlmProvider) => void;
  onClaudeModeChange?: (mode: ClaudeModelMode) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.name);
  const cancelNameCommit = useRef(false);
  const renameTip = useHoverTip();
  const providerOptions = providersForAgent(profile.type, providers);
  const provider = providers.find((candidate) => candidate.id === profile.providerId);
  const protocol = providerProtocolForAgent(profile.type);
  // 速度那一列的静默失效:1.5x 和「覆盖 CLI 配置」都靠 --settings 注入,而 claude 只认
  // 最后一个 —— profile 自己的额外参数里写了一条,加速档就一个字也到不了 CLI 手上。
  const speedConflict = cliSpeedOverrideConflict(profile.type, profile.extraArgs ?? [], profile.speed);

  // 供应商候选：官方账号 + 本类型协议匹配的供应商；当前选的那家如果协议已经不匹配
  // （改过供应商协议），仍要留在列表里，否则下拉显示空白，看着像「没设过」。
  const providerChoices = useMemo<SelectOption[]>(() => {
    const rows: SelectOption[] = [{
      value: "",
      label: protocol ? "CLI 官方账号" : "暂不支持",
      detail: protocol ? "不接第三方供应商" : "",
    }];
    if (provider && !providerOptions.some((candidate) => candidate.id === provider.id)) {
      rows.push({ value: provider.id, label: provider.name, detail: "协议不匹配" });
    }
    for (const candidate of providerOptions) {
      rows.push({
        value: candidate.id,
        label: candidate.name,
        detail: candidate.hasKey ? "" : "缺 Key",
      });
    }
    return rows;
  }, [protocol, provider, providerOptions]);

  useEffect(() => {
    if (!editingName) setNameDraft(profile.name);
  }, [editingName, profile.name]);

  const patch = async (value: Partial<AgentExecutorProfile>) => {
    setBusy(true);
    try {
      onChange(await api.patchAgent(profile.id, value));
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const commitName = async () => {
    if (cancelNameCommit.current) {
      cancelNameCommit.current = false;
      setEditingName(false);
      setNameDraft(profile.name);
      return;
    }
    const name = nameDraft.trim();
    setEditingName(false);
    if (!name) {
      setNameDraft(profile.name);
      notify("Profile 名称不能为空");
      return;
    }
    if (name === profile.name) return;
    if (!await patch({ name })) setNameDraft(profile.name);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteAgent(profile.id);
      onChange(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器删除失败");
      setBusy(false);
    }
  };

  return (
    <>
      <article className="agent-profile-row" role="row">
        <div className="agent-profile-identity" role="cell">
          {editingName ? (
            <input
              className="agent-profile-name-input"
              aria-label={`${profile.name} 的 Profile 名称`}
              autoFocus
              disabled={busy}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelNameCommit.current = true;
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <>
              <button
                type="button"
                className="agent-profile-name-button"
                disabled={busy}
                {...renameTip.anchorProps}
                onClick={() => { renameTip.hide(); setEditingName(true); }}
              >
                {profile.name}
              </button>
              <HoverTip at={renameTip.at}>点击编辑名称</HoverTip>
            </>
          )}
        </div>
        <div className="agent-profile-cell" role="cell">
          <Select
            size="compact"
            label={`${profile.name} 的供应商`}
            value={profile.providerId ?? ""}
            options={providerChoices}
            disabled={busy || !protocol}
            filterable={providerOptions.length > 6}
            filterPlaceholder="筛选供应商…"
            placeholder={protocol ? "CLI 官方账号" : "暂不支持"}
            onChange={(providerId) => void patch({ providerId: providerId || null, model: "", reasoningEffort: "" })}
          />
        </div>
        <div className="agent-profile-cell" role="cell">
          <ProviderModelInput
            type={profile.type}
            provider={provider}
            value={profile.model ?? ""}
            disabled={busy}
            compact
            onClaudeModeChange={onClaudeModeChange}
            // 换模型不动档位：对不上时由旁边那颗智能水平胶囊出提示，让用户自己决定改哪边。
            // 以前这里静默归一，结果是「我明明选了 ultra，回头一看变成空的」。
            onChange={(model) => onChange({ ...profile, model: model || undefined })}
            onCommit={(model) => {
              void patch({ model }).then((saved) => {
                if (saved) setEffortOpen(true);
              });
            }}
          />
        </div>
        <div className="agent-profile-cell" role="cell">
          <EffortPicker
            type={profile.type}
            model={profile.model ?? null}
            value={profile.reasoningEffort ?? ""}
            disabled={busy}
            label={`${profile.name} 的智能水平`}
            followLabel="跟随 CLI"
            open={effortOpen}
            onOpenChange={setEffortOpen}
            onChange={(reasoningEffort) => void patch({ reasoningEffort })}
          />
        </div>
        <div className="agent-profile-cell" role="cell">
          <Select
            size="compact"
            label={`${profile.name} 的速度`}
            value={profile.speed ?? "standard"}
            options={SPEED_CHOICES}
            disabled={busy || profile.type === "antigravity"}
            onChange={(speed) => void patch({ speed })}
          />
        </div>
        {/* 覆盖 CLI 自身配置的那一档**自己占一列**，不进右边那堆 hover 才现身的图标：
            它盖掉的是用户自己配置文件里的值，看不见就等于「明明改了别人的配置却没说」。
            表头那一格由 AgentProfilesSection 按同一个判据渲染，两边必须同进同出。 */}
        {hasCliConfigOverrides(profile.type) && (
          <div className="agent-profile-cell" role="cell">
            <ProfileOverridesControl
              profileName={profile.name}
              type={profile.type}
              value={profile.configOverrides ?? {}}
              model={profile.model}
              provider={provider}
              extraArgs={profile.extraArgs ?? []}
              disabled={busy}
              onSave={async (configOverrides) => {
                const saved = await patch({ configOverrides });
                if (saved) notify(`${profile.name} 的 CLI 配置覆盖已保存`);
                return saved;
              }}
              onProviderChanged={(updated) => {
                onProviderChanged(updated);
                notify(`已在「${updated.name}」开启 1M，下一轮起生效`);
              }}
            />
          </div>
        )}
        {/* 行尾这一格粘在表格右缘（窄到横向滚动时也够得着）：默认的那一行常显「默认」，
            其余动作收在常驻的一颗「更多」里。 */}
        <div className="agent-profile-actions" role="cell">
          {profile.isDefault && (
            <span className="settings-default-tag">
              <Star size={12} weight="fill" aria-hidden="true" />默认
            </span>
          )}
          <ProfileRowMenu
            profileName={profile.name}
            extraArgs={profile.extraArgs ?? []}
            isDefault={!!profile.isDefault}
            busy={busy}
            onSaveArgs={async (extraArgs) => {
              const saved = await patch({ extraArgs });
              if (saved) notify(`${profile.name} 的 CLI 参数已保存`);
              return saved;
            }}
            onMakeDefault={() => void patch({ isDefault: true })}
            onDelete={() => setConfirmDelete(true)}
          />
        </div>
        {/* 「选了 1.5x，其实被自己那条 --settings 顶掉了」这类静默失效必须在行里看得见。
            整行跨列显示：速度那一格只有 56px，塞不下一句人话，而缩成一个记号等于要求
            用户先怀疑它。覆盖那一档的同类冲突由胶囊自己显示（它有值可写）。 */}
        {speedConflict && <p className="agent-profile-row-warning">{speedConflict}</p>}
        {/* 多人模式下「这个执行器根本派不出任务」跟上面那种静默失效是同一类问题：
            不在行里说，用户要等到派活失败才知道。服务端现算（auth/dispatch-gate.ts），
            自用模式下这个字段不存在，所以这一行在自用模式恒不渲染。 */}
        {profile.dispatchBlocked && (
          <p className="agent-profile-row-warning is-blocked">{profile.dispatchBlocked}</p>
        )}
        {/* ash MCP 没接上或判不准：不说的话，用户要等第一个任务交不了卷才知道。 */}
        {profile.ashMcp?.detail && <p className="agent-profile-row-warning">{profile.ashMcp.detail}</p>}
      </article>
      {confirmDelete && (
        <ConfirmDialog
          title="删除执行器"
          message={`确定删除“${profile.name}”？已有任务会按类型默认执行器降级。`}
          confirmLabel="删除"
          danger
          busy={busy}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
