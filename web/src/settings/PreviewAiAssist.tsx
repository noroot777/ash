import { useCallback, useEffect, useRef, useState } from "react";
import { CircleNotch, Robot, Stop } from "@phosphor-icons/react";
import type { PreviewAssistState } from "@ash/shared/preview-assist";
import type { ProjectPreviewConfig } from "@ash/shared/preview";
import { Button } from "../components/ui.tsx";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import { api } from "../lib/api.ts";
import { parseExecutorValue, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { useExecutorCatalog } from "../workflow/executorCatalog.ts";
import {
  forgetAssistTrace,
  interruptedAssistState,
  markAssistInterrupted,
  readAssistTrace,
  rememberedExecutor,
  rememberExecutor,
  traceAssistJob,
} from "./previewAssistMemory.ts";

// 「AI 协助」——把「这个项目该怎么起」这件事交给一个真的 CLI 智能体去判断，**并且由 ash
// 真跑一遍**，跑起来了才填回上面的输入框。
//
// 界面上要一直说清楚两件事，因为它们决定用户敢不敢点：
//   ① 现在到底在干嘛（第几轮、是在读项目还是在试跑）——这活儿要几分钟，一个转圈的按钮
//      会让人以为卡死了，然后在智能体跑到一半时刷新页面；
//   ② 每一轮试跑的结果都摆出来（脚本 + 成没成 + 失败原因 + 日志尾巴）。就算三轮都没成，
//      这几段日志本身就是用户手写那条脚本时最需要的东西 —— 别让一次失败等于什么都没留下。
//
// 「作业不见了」也算一种结果，见 previewAssistMemory.ts：服务端的进度是内存态，ash 重启
// 就没了，光凭 `job: null` 分不清「没点过」和「点过但被重启吞了」，所以那条记录在本地。
//
// 选谁干活这一段用全站统一的三段胶囊（composer/ExecutorPickerField.tsx）。
export function PreviewAiAssist({ projectId, script, launch, disabled, onFilled, notify }: {
  projectId: string;
  script: string;
  launch: ProjectPreviewConfig["launch"];
  disabled: boolean;
  /** AI 真的把它起起来了：把脚本填进输入框。 */
  onFilled: (script: string) => void;
  notify: (message: string) => void;
}) {
  const catalog = useExecutorCatalog();
  const types = registeredAgentTypes(catalog.profiles);
  const [executor, setExecutor] = useState(() => rememberedExecutor(projectId));
  const [job, setJob] = useState<PreviewAssistState | null>(null);
  /** 摆出来的这张卡是本地记录推出来的「中断」，不是服务端回的作业。 */
  const [interrupted, setInterrupted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = useRef<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setExecutor(rememberedExecutor(projectId)); setJob(null); setInterrupted(false); filled.current = null; }, [projectId]);

  const running = job?.status === "running";
  const poll = useCallback(async () => {
    try {
      const result = await api.previewAssist(projectId);
      if (!active.current) return;
      if (result.job) {
        // 跑着就记住身份，落终态就把记录删掉 —— 留着的话，服务端 10 分钟后清掉终态，
        // 同一个 null 会被下面误读成「被重启吞了」。
        if (result.job.status === "running") traceAssistJob(projectId, result.job);
        else forgetAssistTrace(projectId);
        setInterrupted(false);
        setJob(result.job);
        return;
      }
      // 服务端这儿没有了。本地记着一条，说明是这个浏览器点起来的那个作业被 ash 重启吞了。
      const trace = readAssistTrace(projectId);
      if (!trace) { setInterrupted(false); setJob(null); return; }
      if (!trace.interrupted) markAssistInterrupted(projectId, trace);
      setInterrupted(true);
      setJob(interruptedAssistState(projectId, trace));
    } catch { /* 轮询失败就等下一拍，别把界面搞成一片红 */ }
  }, [projectId]);
  // 开着页面就先问一次：上一次点开的作业可能还在跑（换页面、刷新都不该把它弄丢），
  // 也可能已经被一次重启吞掉了（那就把「中断」摆出来，而不是装作没点过）。
  useEffect(() => { void poll(); }, [poll]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void poll(); }, 1200);
    return () => clearInterval(timer);
  }, [running, poll]);
  // 成功那一刻把脚本填上去。认 jobId 而不是认脚本内容：同一条脚本连着成功两次也该只填一次，
  // 而用户在这之后手工改过的内容不该被下一拍轮询再盖回来。
  useEffect(() => {
    if (job?.status !== "succeeded" || !job.script || filled.current === job.jobId) return;
    filled.current = job.jobId;
    onFilled(job.script);
    notify("AI 已真的把它起起来一次，脚本已填入上面的输入框，确认后点保存");
  }, [job, onFilled, notify]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = executor
        ? parseExecutorValue(executor, catalog.profiles, { agentType: types[0] ?? "claude", executorId: null })
        : null;
      const result = await api.startPreviewAssist(projectId, {
        script,
        launch,
        executorId: picked?.executorId ?? null,
        agentType: picked?.agentType ?? null,
      });
      if (!active.current) return;
      filled.current = null;
      // 开起来了就记住它；开头就落了终态（挑执行器失败那种）就把上一条记录清掉，别让它
      // 之后被读成「这个作业被重启吞了」。
      if (result.job.status === "running") traceAssistJob(projectId, result.job);
      else forgetAssistTrace(projectId);
      setInterrupted(false);
      setJob(result.job);
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "启动失败");
    } finally { if (active.current) setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      const result = await api.cancelPreviewAssist(projectId);
      forgetAssistTrace(projectId);
      if (active.current) setJob(result.job);
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "取消失败");
    } finally { if (active.current) setBusy(false); }
  };
  // 中断那张卡是本地记录推出来的，服务端没有对应的东西可轮询，所以得给它一个出口，
  // 否则它会在这个项目上一直挂着（不点「AI 协助填写」就不会被新作业顶掉）。
  const dismiss = () => { forgetAssistTrace(projectId); setJob(null); setInterrupted(false); };

  return <div className="preview-assist">
    <div className="preview-assist-actions">
      <Button variant={running ? undefined : "primary"} disabled={disabled || busy || running} onClick={() => void start()}>
        <Robot size={13} aria-hidden="true" />{running ? "AI 正在判断…" : "AI 协助填写"}
      </Button>
      {running && <Button disabled={busy} onClick={() => void cancel()}><Stop size={13} aria-hidden="true" />停止</Button>}
      {types.length + catalog.profiles.length > 0 && <div className="preview-assist-executor">
        <ExecutorPickerField
          label="让谁来判断"
          value={executor}
          types={types}
          profiles={catalog.profiles}
          knownProfiles={catalog.profiles}
          fallbackType={types[0] ?? "claude"}
          disabled={disabled || busy || running}
          unsetText="默认执行器"
          onUnset={() => { setExecutor(""); rememberExecutor(projectId, ""); }}
          onChange={(next) => { setExecutor(next); rememberExecutor(projectId, next); }}
        />
      </div>}
    </div>
    <div className="preview-help">
      {/* 这段小字要挡住的是「它会不会乱动我的仓库」这个顾虑 —— 这一颗按钮会在用户的项目
          目录里起真进程，不说清楚就没人敢点。判定方式也得说，否则「AI 填的」在用户眼里
          和「猜的」没区别。 */}
      <small>AI 在<b>项目目录</b>里读文件判断启动方式，ash 再借一个空闲端口把它给的脚本<b>真跑一遍</b>——端口上真有响应才算数，随后进程会被停掉，起不来就甩回去重来（最多 {job?.maxRounds ?? 3} 轮）。它被要求不改仓库里的任何文件、不替你装依赖。</small>
    </div>
    {error && <p className="preview-assist-error" role="alert">{error}</p>}
    {job && <PreviewAssistProgress job={job} onDismiss={interrupted ? dismiss : undefined} />}
  </div>;
}

function PreviewAssistProgress({ job, onDismiss }: { job: PreviewAssistState; onDismiss?: () => void }) {
  const tone = job.status === "succeeded" ? " is-ok" : job.status === "failed" ? " is-bad" : "";
  return <div className={`preview-assist-progress${tone}`} role="status" aria-live="polite">
    <div className="preview-assist-step">
      {job.status === "running" && <CircleNotch size={13} className="preview-assist-spin" aria-hidden="true" />}
      <span>{job.step}</span>
      {job.status === "running" && job.round > 0 && <b>{job.round}/{job.maxRounds}</b>}
    </div>
    {/* 上面那行状态已经说了「在哪个地址上起来过」，这里只说接下来该做什么——同一件事写两遍
        会把真正的下一步（还得点保存）淹掉。 */}
    {job.status === "succeeded" && <p className="preview-assist-verdict">
      脚本已填进上面的输入框；确认无误后点「保存预览设置」，任务里的「打开预览」就按它启动。
    </p>}
    {job.status !== "succeeded" && job.error && <p className="preview-assist-verdict">{job.error}</p>}
    {onDismiss && <div className="preview-assist-dismiss">
      <Button onClick={onDismiss}>知道了</Button>
    </div>}
    {/* 跑完也留着它的原话：没给出脚本那条路上，「它为什么认为起不来」全在这段里，
        收起来就等于让用户面对一句「没成」。 */}
    {job.say && <details className="preview-assist-say" open={job.status === "failed"}>
      <summary>{job.executorLabel} {job.status === "running" ? "正在说" : "最后说的"}</summary><pre>{job.say}</pre>
    </details>}
    {job.attempts.map((attempt) => <details key={attempt.round} className={`preview-assist-attempt${attempt.ok ? " is-ok" : ""}`} open={!attempt.ok && job.status !== "running"}>
      <summary>第 {attempt.round} 轮 · {attempt.ok ? "起来了" : attempt.reason ?? "没起来"}</summary>
      {attempt.script && <pre className="preview-assist-script">{attempt.script}</pre>}
      {attempt.log && <pre className="preview-assist-log">{attempt.log.slice(-2000)}</pre>}
    </details>)}
  </div>;
}
