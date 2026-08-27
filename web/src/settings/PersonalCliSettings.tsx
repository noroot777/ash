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

  const load = useCallback(async () => {
    try {
      const result = await personalCliApi.list();
      setMode(result.mode);
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
