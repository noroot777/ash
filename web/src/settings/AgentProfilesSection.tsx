import { useMemo, useState } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  LlmProvider,
} from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { hasCliConfigOverrides } from "@ash/shared/cli-overrides";
import { MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api, type DetectedCli } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { AgentDetectionResults } from "./AgentDetectionResults.tsx";
import { AgentProfileRow } from "./AgentProfileRow.tsx";

function profileAvatar(type: AgentType) {
  if (type === "claude") return "C";
  if (type === "codex") return "X";
  if (type === "antigravity") return "A";
  return type.slice(0, 1).toUpperCase();
}

function nextLocalName(type: AgentType, profiles: AgentExecutorProfile[]) {
  const names = new Set(profiles.map((profile) => profile.name));
  let index = 1;
  while (names.has(`${type}@local·${index}`)) index += 1;
  return `${type}@local·${index}`;
}

function AgentProfileGroup({
  type,
  profiles,
  allProfiles,
  providers,
  blockedByVersion,
  onProfileChanged,
  onProfileAdded,
  onProfilesDeleted,
  notify,
}: {
  type: AgentType;
  profiles: AgentExecutorProfile[];
  allProfiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  /**
   * 本次检测判定这个类型不能注册的理由(= 检测结果里那条 versionWarning);没检测过、
   * 或检测下来没问题就是 undefined。
   *
   * 服务端的 409 才是权威闸,这里只管**指引**:检测前它按用户口径只说「先去点检测」,
   * 用户照做之后要是「新增」还开着,点下去又被同一句话打回,就成了走不出去的死循环
   * (自由工作流第 1 轮审查)。所以检测结果一旦判 blocked,这个入口就跟检测卡片里那颗
   * 按钮同步改口。
   */
  blockedByVersion?: string;
  onProfileChanged: (id: string, profile: AgentExecutorProfile | null) => void;
  onProfileAdded: (profile: AgentExecutorProfile) => void;
  onProfilesDeleted: (ids: string[]) => void;
  notify: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const defaultProfile = profiles.find((profile) => profile.isDefault);

  const addLocal = async () => {
    // 门禁同时落在按钮和提交函数上(web/CLAUDE.md「主工作区」那条同款理由):
    // 只 disable 按钮的话,键盘/程序化触发照样能把请求发出去,又拿回那句「先去检测」。
    if (blockedByVersion) {
      notify(blockedByVersion);
      return;
    }
    setAdding(true);
    try {
      const profile = await api.createAgent({
        type,
        name: nextLocalName(type, allProfiles),
        isDefault: !allProfiles.some((candidate) => candidate.type === type),
      });
      onProfileAdded(profile);
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器新增失败");
    } finally {
      setAdding(false);
    }
  };

  const deleteType = async () => {
    setDeleting(true);
    const deletedIds: string[] = [];
    try {
      for (const profile of profiles) {
        await api.deleteAgent(profile.id);
        deletedIds.push(profile.id);
      }
      onProfilesDeleted(deletedIds);
      setConfirmDelete(false);
      notify(`${type} 类型的执行器已删除`);
    } catch (error) {
      if (deletedIds.length) onProfilesDeleted(deletedIds);
      notify(error instanceof Error ? error.message : `${type} 类型删除失败`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className={`agent-profile-group is-${type}`}>
      <header className="agent-profile-group-head">
        <span className={`settings-agent-avatar is-${type}`}>
          {profileAvatar(type)}
        </span>
        <div className="agent-profile-group-copy">
          <b>{type}</b>
          <small>{profiles.length} 个 Profile</small>
        </div>
        <span className="agent-profile-group-default" title={defaultProfile?.name}>
          默认 · {defaultProfile?.name ?? "内置本地执行器"}
        </span>
        <div className="agent-profile-group-actions">
          <Button
            variant="ghost"
            className="agent-profile-group-add"
            disabled={adding || deleting || !!blockedByVersion}
            onClick={() => void addLocal()}
          >
            {/* 措辞跟检测卡片那颗按钮保持一致 —— 同一页两个注册入口给不同说法,用户会
                以为其中一个还有戏。完整升级说明就在上面那张卡片里,这里不重复。 */}
            {blockedByVersion
              ? <>请先升级</>
              : <><Plus size={12} weight="bold" /> {adding ? "新增中…" : "新增"}</>}
          </Button>
          <button
            type="button"
            className="settings-icon-danger"
            disabled={adding || deleting}
            aria-label={`删除全部 ${type} 执行器`}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      {/* 「CLI 配置」这一列只有声明过可覆盖项的 CLI 才有（目前只有 claude）。表头和行里
          的格子共用 hasCliConfigOverrides 这一个判据，列数才不会错位；栅格宽度由
          .has-overrides 那条规则给。 */}
      <div
        className={`agent-profile-table${hasCliConfigOverrides(type) ? " has-overrides" : ""}`}
        role="table"
        aria-label={`${type} 执行器`}
      >
        <div className="agent-profile-columns" role="row" aria-hidden="true">
          <span>Profile / 位置</span>
          <span>供应商</span>
          <span>模型</span>
          <span>思考</span>
          <span>速度</span>
          {hasCliConfigOverrides(type) && <span>CLI 配置</span>}
          <span className="agent-profile-actions-heading">操作</span>
        </div>
        {profiles.map((profile) => (
          <AgentProfileRow
            key={profile.id}
            profile={profile}
            providers={providers}
            onChange={(updated) => onProfileChanged(profile.id, updated)}
            notify={notify}
          />
        ))}
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={`删除全部 ${type} 执行器`}
          message={`确定删除该类型的全部 ${profiles.length} 个 Profile？已有任务会按类型内置默认降级。`}
          confirmLabel="全部删除"
          danger
          busy={deleting}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void deleteType()}
        />
      )}
    </section>
  );
}

export function AgentProfilesSection({
  profiles,
  providers,
  loading,
  detecting,
  detected,
  registeringKey,
  onDetect,
  onRegister,
  onProfileChanged,
  onProfileAdded,
  onProfilesDeleted,
  notify,
}: {
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  loading: boolean;
  detecting: boolean;
  detected: DetectedCli[] | null;
  registeringKey: string | null;
  onDetect: () => void;
  onRegister: (cli: DetectedCli) => void;
  onProfileChanged: (id: string, profile: AgentExecutorProfile | null) => void;
  onProfileAdded: (profile: AgentExecutorProfile) => void;
  onProfilesDeleted: (ids: string[]) => void;
  notify: (message: string) => void;
}) {
  const profileGroups = useMemo(() => AGENT_TYPES.map((type) => ({
    type,
    profiles: profiles.filter((profile) => profile.type === type),
  })).filter((group) => group.profiles.length > 0), [profiles]);
  // 只认**本次检测**的结论:`detected` 为 null(还没点过检测)时这张表是空的,
  // 「新增」照常可点,拒绝仍由服务端 409 兜底 —— 用户没检测就不该在界面上看见版本判断。
  const blockedByVersion = useMemo(() => {
    const map = new Map<AgentType, string>();
    for (const cli of detected ?? []) {
      if (cli.type && cli.versionWarning) map.set(cli.type, cli.versionWarning);
    }
    return map;
  }, [detected]);

  return (
    <section className="settings-section">
      <div className="agent-profiles-section-head">
        <h2>执行器 Profile</h2>
        <div>
          <Button disabled={detecting} onClick={onDetect}>
            <MagnifyingGlass size={13} />
            {detecting ? "检测中…" : "检测本地智能体"}
          </Button>
        </div>
      </div>
      <div className="settings-card agent-profiles-card">
        <AgentDetectionResults
          detected={detected}
          profiles={profiles}
          registeringKey={registeringKey}
          onRegister={onRegister}
        />
        {loading && <p className="settings-muted">读取中…</p>}
        {!loading && !profiles.length && (
          <p className="settings-muted">还没有 Profile；检测本地智能体并注册。</p>
        )}
        {!!profileGroups.length && (
          <div className="agent-profile-groups">
            {profileGroups.map(({ type, profiles: typeProfiles }) => (
              <AgentProfileGroup
                key={type}
                type={type}
                profiles={typeProfiles}
                allProfiles={profiles}
                providers={providers}
                blockedByVersion={blockedByVersion.get(type)}
                onProfileChanged={onProfileChanged}
                onProfileAdded={onProfileAdded}
                onProfilesDeleted={onProfilesDeleted}
                notify={notify}
              />
            ))}
          </div>
        )}
        <div className="settings-card-foot agent-profile-foot">
          <span>供应商决定账号与模型目录；任务仍可逐个覆盖执行器、模型和智能水平。</span>
        </div>
      </div>
    </section>
  );
}
