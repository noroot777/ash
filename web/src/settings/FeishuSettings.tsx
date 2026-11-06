import { useEffect, useState } from "react";
import type { FeishuBinding, FeishuGroups, FeishuStatus, ProjectView } from "@ash/shared";
import { api } from "../lib/api.ts";
import { FeishuBindingCard } from "./FeishuBindingCard.tsx";
import { FeishuConnectionCard } from "./FeishuConnectionCard.tsx";
import { FeishuCredentialsCard } from "./FeishuCredentialsCard.tsx";
import { FeishuGroupsCard } from "./FeishuGroupsCard.tsx";
import { FeishuPushCard } from "./FeishuPushCard.tsx";
import { TRANSIENT_STATES, connectionView } from "./feishuText.ts";
import type { SettingsSection } from "./sections.ts";
import { FAST_POLL_MS, SLOW_POLL_MS, useFeishuPoll } from "./useFeishuPoll.ts";
import "./feishu-settings.css";

// 设置 → 飞书。方案见 docs/feishu-integration.md，契约见 shared/src/im.ts。
//
// 三份服务端状态各拉各的：连接状态（实例级）、我的绑定、群绑定。分开拉是因为它们的节奏不同
// ——有一个码在等认领时，绑定那份要两秒拉一次，而连接状态没理由跟着一起勤。
//
// 谁能改什么由服务端在状态里回的 canManage 决定（自用模式恒为真；多人模式只有管理员）：
// 凭证和推送是整台实例共用的，绑定和群是每个人自己的。前端收起改不动的控件只是为了别让人
// 白填一遍，真正的闸在后端。

const statusInterval = (status: FeishuStatus | null) =>
  status && TRANSIENT_STATES.includes(status.connection.state) ? FAST_POLL_MS : SLOW_POLL_MS;
const bindingInterval = (binding: FeishuBinding | null) =>
  binding && (binding.state === "code" || binding.state === "pending") ? FAST_POLL_MS : SLOW_POLL_MS;
const groupsInterval = (groups: FeishuGroups | null) =>
  groups && groups.claims.length > 0 ? FAST_POLL_MS : SLOW_POLL_MS;

function Pending({ title, error, text }: { title: string; error: string | null; text: string }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      <div className="settings-card"><p className="settings-muted">{error ?? text}</p></div>
    </section>
  );
}

export function FeishuSettings({ notify, onOpen }: {
  notify: (message: string) => void;
  onOpen: (section: SettingsSection, anchor?: string | null) => void;
}) {
  const status = useFeishuPoll(api.feishuStatus, statusInterval, "读取飞书状态失败");
  const binding = useFeishuPoll(api.feishuBinding, bindingInterval, "读取飞书绑定失败");
  const groups = useFeishuPoll(api.feishuGroups, groupsInterval, "读取群绑定失败");
  const [projects, setProjects] = useState<ProjectView[]>([]);

  useEffect(() => {
    let alive = true;
    // 项目清单只用来填下拉和勾选框，读不到就当没有项目，不拦整页。
    api.projects().then((rows) => { if (alive) setProjects(rows); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const current = status.data;
  const view = current ? connectionView(current.connection.state, current.connection.error, current.connection.reconnectAttempts) : null;
  // 状态本身没读到时不下「不在线」的结论：那张卡自己会报读取失败。
  const online = current && view ? { ok: current.connection.state === "connected", label: view.label } : { ok: true, label: "" };

  return (
    <div className="feishu-settings">
      <header className="settings-heading">
        <div>
          <h1>飞书</h1>
          <p>
            把要你拍板的事（提问、待验收、失败）推成飞书卡片，在手机上点一下就处理；长会话、diff 和预览仍回网页看。
            {current?.multiUser && " 多人模式下每个人绑自己的飞书；飞书应用和推送选项是整台实例共用的，只有管理员能改。"}
          </p>
        </div>
      </header>
      {current ? (
        <>
          <FeishuConnectionCard status={current} pollError={status.error} syncedAt={status.syncedAt} onStatus={status.apply} notify={notify} />
          <FeishuCredentialsCard status={current} onStatus={status.apply} notify={notify} />
          <FeishuPushCard status={current} projects={projects} onStatus={status.apply} notify={notify} />
        </>
      ) : (
        <Pending title="连接" error={status.error} text="读取飞书状态…" />
      )}
      {binding.data ? (
        <FeishuBindingCard binding={binding.data} online={online} projects={projects} onBinding={binding.apply} notify={notify} />
      ) : (
        <Pending title="绑定" error={binding.error} text="读取绑定状态…" />
      )}
      {groups.data ? (
        <FeishuGroupsCard
          groups={groups.data}
          projects={projects}
          bound={binding.data?.state === "bound" && !binding.data.stale}
          onGroups={groups.apply}
          onOpen={onOpen}
          notify={notify}
        />
      ) : (
        <Pending title="群" error={groups.error} text="读取群绑定…" />
      )}
    </div>
  );
}
