// 「个人 CLI 环境」设置节(§九)。每人自己的技能 / 全局指令 / 插件,按 CLI 分块。
//
// 这一屏要如实说清楚**边界**,不能让人以为装了就到处生效:
//  · 有独立配置目录的 CLI(claude / codex)才有个人级这一层。
//  · 没有等价环境变量的(gemini)如实标「只有项目级」,不假装。
//  · 项目级(仓库里的 .claude/skills、CLAUDE.md)照旧跟项目走,两层并存。
import { useCallback, useEffect, useState } from "react";
import type { PersonalCliEnv } from "@ash/shared";
import { ApiError } from "../lib/apiClient.ts";
import { personalCliApi } from "../lib/authApi.ts";
import { Button, TextInput } from "../components/ui.tsx";
import "./personal-cli-settings.css";

export function PersonalCliSettings({ notify }: { notify: (message: string) => void }) {
  const [envs, setEnvs] = useState<PersonalCliEnv[]>([]);
  const [mode, setMode] = useState<"single" | "multi" | null>(null);
  // 实例选了「共用宿主机 CLI」时这一整节**不生效**:CLI 起跑时压根没被注入个人配置目录。
  const [sharedHostCli, setSharedHostCli] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await personalCliApi.list();
      setMode(result.mode);
      setSharedHostCli(result.sharedHostCli);
      setEnvs(result.envs);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "读不出个人 CLI 环境");
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  if (mode === "single") {
    return (
      <section className="settings-section">
        <h2>个人 CLI 环境</h2>
        <p className="settings-hint">
          自用模式下 CLI 用的就是这台机器上的默认配置目录（<code>~/.claude</code>、<code>~/.codex</code>），
          订阅照用。「个人级」这一层只在多人模式下才有意义。
        </p>
      </section>
    );
  }

  return (
    <section className="settings-section pcli">
      <header>
        <h2>个人 CLI 环境</h2>
        <p className="settings-hint">
          你自己的技能、全局指令和插件。装一次<b>所有项目都能用</b>，跟项目里的{" "}
          <code>.claude/skills</code>、<code>CLAUDE.md</code> 两层并存 —— 那一层照旧跟项目走。
        </p>
      </header>
      {/* 目录还在盘上、编辑器也还能写,但 CLI 不会去读它 —— 不说清楚的话,用户会在这里
          装一个技能然后发现补全里没有,而界面上一切正常。 */}
      {sharedHostCli ? (
        <div className="auth-warning auth-warning--strong">
          <b>这一节现在不生效。</b>
          这台 ash 的「CLI 额度」设成了<b>共用这台机器的 CLI</b>，所以任务跑的是宿主机的{" "}
          <code>~/.claude</code>、<code>~/.codex</code>，不是下面这些个人目录 ——
          在这里装的技能、写的全局指令，CLI 都读不到。
          下面的内容原样留着（改回「每人自带 key」立刻恢复生效）；
          现在要让全员都用上某个技能，装到宿主机的配置目录里。
        </div>
      ) : null}
      {envs.map((env) => (
        <CliEnvBlock key={env.agentType} env={env} onChanged={setEnvsOf(setEnvs)} notify={notify} />
      ))}
    </section>
  );
}

/** 局部更新一个 CLI 块,不重拉整份 —— 编辑器里正打着的字不该被刷掉。 */
function setEnvsOf(set: (fn: (prev: PersonalCliEnv[]) => PersonalCliEnv[]) => void) {
  return (next: PersonalCliEnv) =>
    set((prev) => prev.map((item) => (item.agentType === next.agentType ? next : item)));
}

/**
 * ash MCP 在这个个人目录里登记了没有。
 *
 * 为什么值得占一块地方:缺了它的表现是**任务照跑、干完记 failed**,界面上没有任何一处
 * 说得出原因(agent 调 complete_task 撞回 "No such tool available",而那句话只躺在
 * 会话正文里)。ash 每次起跑都会自动补,所以这块平时是一行淡字;补不上才变红。
 */
function AshMcpNotice({ env }: { env: PersonalCliEnv }) {
  if (!env.ashMcp) return null;
  if (env.ashMcp.configured) {
    return (
      <p className="pcli-path">
        ash MCP 已登记为 <code>{env.ashMcp.serverName}</code> —— agent 靠它调{" "}
        <code>complete_task</code> 交卷。
      </p>
    );
  }
  return (
    <div className="auth-warning auth-warning--strong">
      <b>这个目录里没有 ash MCP 登记，用它跑的任务交不了卷。</b>
      agent 手上不会有 <code>complete_task</code> 这个工具，活干完了也只会显示成「失败」。
      ash 每次起跑都会尝试自动补上，这次没补成：{env.ashMcp.problem ?? "原因不明"}。
    </div>
  );
}

function CliEnvBlock({
  env,
  onChanged,
  notify,
}: {
  env: PersonalCliEnv;
  onChanged: (next: PersonalCliEnv) => void;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState<{ name: string; body: string; isNew: boolean } | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);

  if (!env.supported) {
    return (
      <div className="pcli-block pcli-block--unsupported">
        <h3>{env.agentType}</h3>
        <p className="settings-hint">{env.reason}</p>
      </div>
    );
  }

  const openSkill = async (name: string) => {
    try {
      const skill = await personalCliApi.readSkill(env.agentType, name);
      setEditing({ name, body: skill.body, isNew: false });
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "读不出这个技能");
    }
  };

  const saveSkill = async () => {
    if (!editing) return;
    try {
      onChanged(await personalCliApi.writeSkill(env.agentType, editing.name.trim(), editing.body));
      setEditing(null);
      notify("已保存");
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "保存失败");
    }
  };

  const openMemory = async () => {
    try {
      setMemory((await personalCliApi.readMemory(env.agentType)).body);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "读不出全局指令");
    }
  };

  return (
    <div className="pcli-block">
      <h3>{env.agentType}</h3>
      <p className="pcli-path">
        配置目录 <code>{env.configDir}</code>（注入为 <code>{env.envVar}</code>）
      </p>
      <AshMcpNotice env={env} />

      <div className="pcli-part">
        <div className="pcli-part-head">
          <b>个人技能</b>
          <Button onClick={() => setEditing({ name: "", body: SKILL_TEMPLATE, isNew: true })}>新建技能</Button>
        </div>
        {env.skills.length ? (
          <ul className="pcli-skills">
            {env.skills.map((skill) => (
              <li key={skill.name}>
                <button type="button" className="pcli-skill-name" onClick={() => void openSkill(skill.name)}>
                  /{skill.name}
                </button>
                <span>{skill.description || "（没写 description）"}</span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void personalCliApi
                      .deleteSkill(env.agentType, skill.name)
                      .then(onChanged, (e) => notify(e instanceof ApiError ? e.message : "删不掉"));
                  }}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-hint">还没有个人技能。新建一个，所有项目里都能用 <code>/名字</code> 调它。</p>
        )}
      </div>

      <div className="pcli-part">
        <div className="pcli-part-head">
          <b>个人全局 {env.memoryName}</b>
          <Button onClick={() => void openMemory()}>{memory === null ? "编辑" : "重新读取"}</Button>
        </div>
        {memory === null ? (
          <p className="settings-hint">
            {env.hasMemory ? "已经写过内容。" : "还没写过。"}
            它对你的每一个任务生效，跟仓库里那份 {env.memoryName} 叠加。
          </p>
        ) : (
          <>
            <textarea
              className="ui-input pcli-editor"
              rows={12}
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
            />
            <div className="pcli-actions">
              <Button variant="ghost" onClick={() => setMemory(null)}>取消</Button>
              <Button
                variant="primary"
                disabled={memoryBusy}
                onClick={() => {
                  setMemoryBusy(true);
                  void personalCliApi
                    .writeMemory(env.agentType, memory)
                    .then(
                      () => {
                        notify("已保存");
                        setMemory(null);
                      },
                      (e) => notify(e instanceof ApiError ? e.message : "保存失败"),
                    )
                    .finally(() => setMemoryBusy(false));
                }}
              >
                保存
              </Button>
            </div>
          </>
        )}
      </div>

      {env.plugins.length ? (
        <div className="pcli-part">
          <b>个人插件</b>
          <p className="settings-hint">{env.plugins.join("、")}</p>
        </div>
      ) : null}

      {editing ? (
        <div className="pcli-part pcli-part--editor">
          <div className="pcli-part-head">
            <b>{editing.isNew ? "新建技能" : `编辑 /${editing.name}`}</b>
          </div>
          {editing.isNew ? (
            <TextInput
              autoFocus
              placeholder="技能名（会成为磁盘上的目录名，也就是 /名字）"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          ) : null}
          <textarea
            className="ui-input pcli-editor"
            rows={16}
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
          <div className="pcli-actions">
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            <Button variant="primary" disabled={!editing.name.trim()} onClick={() => void saveSkill()}>
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const SKILL_TEMPLATE = `---
name: 技能名
description: 一句话说明什么时候该用它（agent 靠这句决定要不要调）
---

# 技能名

在这里写这个技能要做的事。
`;
