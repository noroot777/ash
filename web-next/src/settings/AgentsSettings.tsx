import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, AgentType, AppSettings } from "@harness/shared";
import {
  AGENT_TYPES,
  CLI_MODEL_PRESETS,
  DEFAULT_APP_SETTINGS,
  REASONING_EFFORT_VALUES,
} from "@harness/shared";
import { Check, MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";
import { Button, Toggle } from "../components/ui.tsx";
import { api, type DetectedCli } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

function updateById(rows: AgentExecutorProfile[], updated: AgentExecutorProfile) {
  return rows.map((row) => {
    if (row.id === updated.id) return updated;
    if (updated.isDefault && row.type === updated.type) return { ...row, isDefault: false };
    return row;
  });
}

function ProfileRow({
  profile,
  onChange,
  notify,
}: {
  profile: AgentExecutorProfile;
  onChange: (profile: AgentExecutorProfile | null) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = async (value: Partial<AgentExecutorProfile>) => {
    setBusy(true);
    try {
      onChange(await api.patchAgent(profile.id, value));
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器保存失败");
    } finally {
      setBusy(false);
    }
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
    <><article className="settings-agent-row">
      <span className={`settings-agent-avatar is-${profile.type}`}>{profile.type === "claude" ? "C" : profile.type === "codex" ? "X" : "A"}</span>
      <div className="settings-agent-copy">
        <b>{profile.name}</b>
        <small>{profile.target.kind === "ssh" ? `ssh ${profile.target.host}` : "本地"}</small>
      </div>
      {profile.isDefault ? <span className="settings-default-tag">{profile.type} 默认</span> : (
        <button type="button" className="settings-text-action" disabled={busy} onClick={() => void patch({ isDefault: true })}>设为默认</button>
      )}
      <label>
        <span>模型</span>
        <input
          value={profile.model ?? ""}
          list={`models-${profile.id}`}
          disabled={busy}
          placeholder="跟随 CLI"
          onChange={(event) => onChange({ ...profile, model: event.target.value || undefined })}
          onBlur={(event) => void patch({ model: event.target.value.trim() })}
        />
      </label>
      <label>
        <span>思考强度</span>
        <select disabled={busy} value={profile.reasoningEffort ?? ""} onChange={(event) => void patch({ reasoningEffort: event.target.value })}>
          <option value="">跟随 CLI</option>
          {REASONING_EFFORT_VALUES[profile.type].map((effort) => <option value={effort} key={effort}>{effort}</option>)}
        </select>
      </label>
      <label>
        <span>速度</span>
        <select disabled={busy || profile.type !== "codex"} value={profile.speed ?? "standard"} onChange={(event) => void patch({ speed: event.target.value as "standard" | "fast" })}>
          <option value="standard">标准</option>
          <option value="fast">1.5x</option>
        </select>
      </label>
      <button className="settings-icon-danger" type="button" disabled={busy} onClick={() => setConfirmDelete(true)} aria-label={`删除 ${profile.name}`}>
        <Trash size={14} aria-hidden="true" />
      </button>
      <datalist id={`models-${profile.id}`}>
        {CLI_MODEL_PRESETS[profile.type].map((model) => <option value={model} key={model} />)}
      </datalist>
    </article>{confirmDelete && <ConfirmDialog title="删除执行器" message={`确定删除“${profile.name}”？已有任务会按类型默认执行器降级。`} confirmLabel="删除" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}</>
  );
}

function AddProfile({ onAdded, notify }: { onAdded: (profile: AgentExecutorProfile) => void; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AgentType>("claude");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const profile = await api.createAgent({
        type,
        name: name.trim() || `${type}@${host.trim() || "local"}${model.trim() ? `·${model.trim()}` : ""}`,
        model: model.trim() || undefined,
        target: host.trim() ? { kind: "ssh", host: host.trim() } : { kind: "local" },
        isDefault: false,
      });
      onAdded(profile);
      setOpen(false);
      setName("");
      setModel("");
      setHost("");
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器新增失败");
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <Button variant="primary" onClick={() => setOpen(true)}><Plus size={13} weight="bold" />新增执行器</Button>;
  return (
    <div className="settings-add-agent">
      <select value={type} onChange={(event) => setType(event.target.value as AgentType)}>
        {AGENT_TYPES.map((value) => <option value={value} key={value}>{value}</option>)}
      </select>
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Profile 名称（可选）" />
      <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="模型（可选）" />
      <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="ssh 主机（留空为本地）" />
      <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
      <Button variant="primary" disabled={busy} onClick={() => void add()}>{busy ? "添加中…" : "添加"}</Button>
    </div>
  );
}

export function AgentsSettings({ notify }: { notify: (message: string) => void }) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectedCli[] | null>(null);
  useEffect(() => {
    Promise.all([api.agents(), api.settings()]).then(([agents, nextSettings]) => {
      setProfiles(agents);
      setSettings(nextSettings);
    }).catch((error) => notify(error instanceof Error ? error.message : "执行器设置读取失败")).finally(() => setLoading(false));
  }, [notify]);
  const defaults = useMemo(() => AGENT_TYPES.map((type) => ({ type, profile: profiles.find((row) => row.type === type && row.isDefault) })), [profiles]);
  const change = (id: string, updated: AgentExecutorProfile | null) => setProfiles((current) => updated ? updateById(current, updated) : current.filter((row) => row.id !== id));
  const detect = async () => {
    setDetecting(true);
    try { setDetected(await api.detectClis()); }
    catch (error) { notify(error instanceof Error ? error.message : "本地 CLI 检测失败"); }
    finally { setDetecting(false); }
  };
  const register = async (cli: DetectedCli) => {
    if (!cli.type) return;
    try {
      const created = await api.createAgent({ type: cli.type, name: `${cli.type}@local`, target: { kind: "local" }, isDefault: !profiles.some((row) => row.type === cli.type) });
      setProfiles((current) => [...current, created]);
      notify(`${cli.name} 已注册为执行器`);
    } catch (error) { notify(error instanceof Error ? error.message : "注册失败"); }
  };
  return (
    <>
      <header className="settings-heading">
        <div><h1>执行器 Profile</h1><p>管理任务、团队调度者和审查者实际调用的 CLI 身份。</p></div>
        <Button disabled={detecting} onClick={() => void detect()}><MagnifyingGlass size={13} />{detecting ? "检测中…" : "检测本地智能体"}</Button>
      </header>
      <section className="settings-section">
        <h2>执行器</h2>
        <div className="settings-card settings-agent-card">
          {loading && <p className="settings-muted">读取中…</p>}
          {!loading && !profiles.length && <p className="settings-muted">还没有 Profile；未指定时服务端仍会按类型使用内置本地默认。</p>}
          {profiles.map((profile) => <ProfileRow key={profile.id} profile={profile} onChange={(updated) => change(profile.id, updated)} notify={notify} />)}
          <div className="settings-card-foot"><span>任务仍可逐个覆盖执行器、模型和思考强度。</span><AddProfile onAdded={(profile) => setProfiles((current) => [...current, profile])} notify={notify} /></div>
        </div>
      </section>
      {detected && (
        <section className="settings-section"><h2>检测结果</h2><div className="settings-card settings-cli-grid">
          {detected.map((cli) => {
            const registered = !!cli.type && profiles.some((profile) => profile.type === cli.type && profile.target.kind === "local");
            return <article key={cli.key}><span className={`settings-cli-state${cli.available ? " is-ready" : ""}`}>{cli.available ? <Check size={12} /> : "—"}</span><div><b>{cli.name}</b><small>{cli.available ? cli.version || cli.path : "未安装"}</small></div>{cli.available && cli.type && !registered && <button type="button" onClick={() => void register(cli)}>注册</button>}</article>;
          })}
        </div></section>
      )}
      <section className="settings-section"><h2>默认规则</h2><div className="settings-card">
        {defaults.map(({ type, profile }) => <div className="settings-row" key={type}><div><b>{type} 类型默认</b><small>任务未指定 executorId 时降级到此 Profile</small></div><span>{profile?.name ?? `内置 ${type}@local`}</span></div>)}
        <div className="settings-row"><div><b>新任务默认使用 worktree</b><small>仅 Git 项目生效；每张新任务仍可单独覆盖</small></div><Toggle label={settings.worktreeDefault ? "已开启" : "已关闭"} checked={settings.worktreeDefault} onChange={async (checked) => { try { setSettings(await api.patchSettings({ worktreeDefault: checked })); } catch (error) { notify(error instanceof Error ? error.message : "默认规则保存失败"); } }} /></div>
      </div></section>
      <p className="settings-note">供应商、API 密钥与更细的 CLI 参数暂由旧版设置承接。</p>
    </>
  );
}
