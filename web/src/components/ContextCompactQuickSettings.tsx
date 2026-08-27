import { useEffect, useState } from "react";
import { CaretDown, Sliders } from "@phosphor-icons/react";
import type { AgentExecutorProfile, Session } from "@ash/shared";
import {
  cliConfigOverrideConflict,
  cliConfigOverrideHints,
  hasCliConfigOverrides,
} from "@ash/shared/cli-overrides";
import { api } from "../lib/api.ts";
import { fmtOverrideValue, useCliOverrideDraft } from "../lib/cliOverrideDraft.ts";
import { useCliHostEnv } from "../lib/useCliHostEnv.ts";

/**
 * 上下文水位面板里的**快捷设置**:就地改这条会话所用执行器的「上下文窗口 + 压缩触发点」。
 *
 * 为什么放在这儿:看见「距压缩还剩 216k」的那一刻,正是用户想改这两个数的那一刻 ——
 * 而权威入口在设置页 → 执行器 → 那颗「未覆盖」胶囊里,隔着三跳。这里是同一份字段的
 * 第二个入口,不是第二套配置:草稿与校验共用 `lib/cliOverrideDraft.ts`,写入走同一个
 * `PATCH /agents/:id`,后端仍是权威那道闸。
 *
 * 三句必须说出口的话(不说的话这个快捷入口就成了「改了个啥也不知道」):
 * ① 改的是**执行器 profile**,不是这一条任务 —— 所有用它的任务都会跟着变;
 * ② 当前这一轮的 CLI 进程早就带着旧环境变量起跑了,**下一轮才生效**;
 * ③ 填的数和实际触发水位之间隔着一层 CLI 内部算法,所以照旧把算出来的水位摆在旁边。
 */
export function ContextCompactQuickSettings({
  session,
  open,
  onToggle,
}: {
  session: Session;
  open: boolean;
  onToggle: () => void;
}) {
  // "idle" = 还没拉。**收起就退回 idle**,展开则重新拉一次:「收起再展开」是用户遇到
  // 读取失败时最自然的恢复动作,把结果缓存住(哪怕只缓存那次错误)就等于告诉他「刷新
  // 整页吧」。成功的那份也一起丢,重开时顺带拿到别处改过的最新配置。
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  // 「重试」按的是这个:展开状态没变,靠它把同一个 effect 再跑一遍。
  const [attempt, setAttempt] = useState(0);

  // 展开才去拉执行器清单:这颗面板挂在每条会话的最后一条气泡上,一进任务就拉一遍
  // 纯属浪费,而用户十有八九只是来看一眼水位。
  //
  // 依赖里**不能有 load.status** —— effect 自己第一句就把它改成 "loading",那会立刻
  // 触发清理(alive=false)把自己发出的请求作废,界面永远停在「读取执行器配置…」。
  useEffect(() => {
    if (!open) {
      setLoad({ status: "idle" });
      return;
    }
    let alive = true;
    setLoad({ status: "loading" });
    api.agents()
      .then((profiles) => { if (alive) setLoad({ status: "ready", profiles }); })
      .catch((error: unknown) => {
        if (alive) setLoad({ status: "failed", error: error instanceof Error ? error.message : "执行器清单读不到" });
      });
    return () => { alive = false; };
  }, [attempt, open]);

  if (!hasCliConfigOverrides(session.agentType)) return null;

  const profile = load.status === "ready" ? matchProfile(load.profiles, session) : null;

  return (
    <div className="context-compact-quick">
      <button
        type="button"
        className={`context-compact-toggle${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Sliders size={11} aria-hidden="true" />
        <span>压缩设置</span>
        <CaretDown size={10} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        load.status === "failed"
          ? (
            <p className="context-compact-note is-warn">
              读不到执行器清单：{load.error}
              {/* 原地重试,免得为了一次网络抖动去收起再展开(更别说刷新整页)。 */}
              <button type="button" className="context-compact-retry" onClick={() => setAttempt((n) => n + 1)}>
                重试
              </button>
            </p>
          )
          : load.status !== "ready"
            ? <p className="context-compact-note">读取执行器配置…</p>
            : profile
              ? (
                <CompactOverrideForm
                  key={profile.id}
                  profile={profile}
                  onSaved={(saved) => setLoad((current) => (current.status === "ready"
                    ? { status: "ready", profiles: current.profiles.map((item) => (item.id === saved.id ? saved : item)) }
                    : current))}
                />
              )
              : (
                <p className="context-compact-note">
                  认不出这条会话用的执行器 profile（{session.executor}），
                  可能已被改名或删除。去设置页 → 执行器里改。
                </p>
              )
      )}
    </div>
  );
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; profiles: AgentExecutorProfile[] }
  | { status: "failed"; error: string };

/**
 * 会话行记的是 profile 主键;`executorId` 为空的是**该字段上线之前**建的老会话,
 * 只剩一个可改名的展示名。名字能唯一对上就认,对上多个或对不上就如实说不认识 ——
 * 猜错的代价是「改了另一个执行器的配置」,比多点两下去设置页坏得多。
 */
function matchProfile(profiles: AgentExecutorProfile[], session: Session): AgentExecutorProfile | null {
  if (session.executorId) return profiles.find((item) => item.id === session.executorId) ?? null;
  const byName = profiles.filter((item) => item.name === session.executor && item.type === session.agentType);
  return byName.length === 1 ? byName[0]! : null;
}

function CompactOverrideForm({
  profile,
  onSaved,
}: {
  profile: AgentExecutorProfile;
  onSaved: (profile: AgentExecutorProfile) => void;
}) {
  const value = profile.configOverrides ?? {};
  // 这份表单只在展开期间存在(收起即卸载),所以草稿恒为「编辑中」,不需要外部同步。
  const { specs, draft, set, parsed, errors, dirty } = useCliOverrideDraft(profile.type, value, true);
  const hostEnv = useCliHostEnv();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // hint 跟着草稿走,不是跟着已保存的值走 —— 这行字的意义就是「改之前先看看会变成什么」。
  const hints = cliConfigOverrideHints(profile.type, parsed, hostEnv);
  const conflict = cliConfigOverrideConflict(profile.type, profile.extraArgs ?? []);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.patchAgent(profile.id, { configOverrides: parsed });
      onSaved(saved);
      setJustSaved(true);
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="context-compact-form">
      {specs.map((spec) => (
        <div className="context-compact-row" key={spec.key}>
          <label htmlFor={`ctx-ov-${profile.id}-${spec.key}`}>{spec.label}</label>
          <span className="context-compact-input">
            <input
              id={`ctx-ov-${profile.id}-${spec.key}`}
              inputMode="numeric"
              disabled={saving}
              placeholder={spec.placeholder}
              value={draft[spec.key] ?? ""}
              onChange={(event) => {
                setJustSaved(false);
                set(spec.key, event.target.value);
              }}
            />
            {spec.unit && <small>{spec.unit}</small>}
          </span>
          <button
            type="button"
            className="context-compact-preset"
            disabled={saving}
            onClick={() => {
              setJustSaved(false);
              set(spec.key, String(spec.recommended));
            }}
          >
            用 {fmtOverrideValue(spec.recommended, spec.unit)}
          </button>
        </div>
      ))}

      {conflict && <p className="context-compact-note is-warn">{conflict}</p>}
      {hints.map((hint) => <p className="context-compact-note" key={hint}>{hint}</p>)}

      <div className="context-compact-actions">
        <span className={errors.length || saveError ? "is-error" : ""}>
          {saveError ?? errors[0]
            ?? (dirty
              ? `写给执行器「${profile.name}」，下一轮生效`
              : justSaved
                ? "已保存 · 下一轮生效"
                : `执行器「${profile.name}」的当前设置`)}
        </span>
        <button
          type="button"
          className="context-compact-save"
          disabled={saving || !dirty || errors.length > 0}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
