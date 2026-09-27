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
  lostAssistState,
  pendingAssistTrace,
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
// 「作业不见了」也算一种结果，见 previewAssistMemory.ts：服务端的进度是内存态，光凭
// `job: null` 分不清「没点过」「被重启吞了」「正常跑完之后过期了」，所以那条记录在本地，
// 再配上服务端自报的实例身份才说得准。
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
  /** 摆出来的这张卡是本地记录推出来的（重启中断 / 过期 / 没收到回复），不是服务端回的作业。 */
  const [lost, setLost] = useState(false);
  /**
   * 成功了，但没敢直接覆盖：脚本摆在这儿等他自己决定要不要换。
   *
   * 连「为什么没覆盖」一起记着 —— 这两种情形下用户面前的东西完全不同（一种是他自己刚敲的几行，
   * 一种是他压根没看见这次跑），话说错了他就没法判断该点哪颗。
   */
  const [offered, setOffered] = useState<{ script: string; reason: "edited" | "unwatched" } | null>(null);
  // 成功之后**输入框到底怎么了**。卡片上的那句话只能照这个说 —— 「有没有待选脚本」推不出
  // 「填了没填」（第 3 轮审查：点完「保留我写的」，卡片照旧说「脚本已填进上面的输入框」，
  // 用户于是以为框里那条手写的是 ash 验证过的）。
  const [applied, setApplied] = useState<"filled" | "kept" | "shown" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = useRef<string | null>(null);
  const active = useRef(true);
  /** 服务端最后一次自报的实例身份。点下去的那一刻要把它记进本地那条记录。 */
  const instance = useRef<string>("");
  /** 这份作业是不是这台浏览器点出来的（见 absorb）。不是就只许看，不许动输入框。 */
  const mine = useRef(false);
  /** 服务端上一次让我们看见的那份作业身份。POST 断线之后靠它认「这一发有没有落地」。 */
  const lastSeen = useRef<string | null>(null);
  // 点下去那一刻输入框里是什么。成功之后拿它跟现在比：**不一样就说明用户在这几分钟里
  // 自己写了东西**，那份手写的比 AI 的结果更该留着（第 2 轮审查：原来是无条件覆盖）。
  const startedWith = useRef<string | null>(null);
  const current = useRef(script);
  useEffect(() => { current.current = script; });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    setExecutor(rememberedExecutor(projectId));
    setJob(null); setLost(false); setOffered(null); setApplied(null);
    filled.current = null; startedWith.current = null; mine.current = false; lastSeen.current = null;
  }, [projectId]);

  const running = job?.status === "running";
  /** 服务端回什么就照着摆什么；回 null 就交给本地那条记录去解释。 */
  const absorb = useCallback((result: { job: PreviewAssistState | null; instance: string }) => {
    instance.current = result.instance;
    const trace = readAssistTrace(projectId);
    lastSeen.current = result.job?.jobId ?? null;
    if (result.job) {
      // **这份结果该不该动用户的输入框,只取决于它是不是这台浏览器点出来的。** 服务端把终态
      // 留 10 分钟(preview-assist-jobs.ts),所以别的窗口点的、甚至这台浏览器上一次已经处理
      // 过的,都会被下一次挂载照样读到一遍(第 3 轮审查:用户保留并保存了自己手写的脚本,十
      // 分钟内刷一下页面,旧的 AI 结果又被填回输入框,再点保存就把刚存的改回去了)。
      mine.current = !!trace && (trace.jobId === result.job.jobId || !trace.jobId);
      // 本地这条追踪**只许记我们自己那份、而且还在跑的作业**，其余一切情形都把它抹掉：
      //   · 我们的、跑着 → 每拍都刷（轮次跟着走，中断那句话才说得出第几轮）
      //   · 我们的、落终态 → 抹掉：留着的话服务端 10 分钟后清掉终态，同一个 null 会被下面读成「出事了」
      //   · 别处点的那份 → **一个字都不能记**。记下去，下一拍就凭「jobId 对上了」把它认成自己点的，
      //     然后照样去动用户的输入框（第 4 轮审查复现：同事在跑，你只是打开了这个页面，你已经保存
      //     的脚本就被换掉了）。同时我们手上那条也作废了 —— 一个项目同时只有一份作业在跑，服务端
      //     既然报的是别人那份，我们那份已经不在了。
      if (mine.current && result.job.status === "running") traceAssistJob(projectId, result.job, result.instance);
      else forgetAssistTrace(projectId);
      // 刷新过页面、但作业还在跑：这一刻框里是什么就拿它当基准,用户接着在这几分钟里写的
      // 东西照样受保护(否则 startedWith 一直是空的,成功时按「没动过」直接覆盖)。
      if (result.job.status === "running" && mine.current && startedWith.current === null) {
        startedWith.current = current.current;
      }
      setLost(false);
      setJob(result.job);
      return;
    }
    if (!trace) { setLost(false); setJob(null); return; }
    setLost(true);
    setJob(lostAssistState(projectId, trace, trace.instance === result.instance));
  }, [projectId]);
  const poll = useCallback(async () => {
    try {
      const result = await api.previewAssist(projectId);
      if (active.current) absorb(result);
    } catch { /* 轮询失败就等下一拍，别把界面搞成一片红 */ }
  }, [projectId, absorb]);
  // 开着页面就先问一次：上一次点开的作业可能还在跑（换页面、刷新都不该把它弄丢），
  // 也可能已经没了（那就说清是重启吞了还是自己过期了，而不是装作没点过）。
  useEffect(() => { void poll(); }, [poll]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void poll(); }, 1200);
    return () => clearInterval(timer);
  }, [running, poll]);
  // 成功那一刻把脚本填上去。认 jobId 而不是认脚本内容：同一条脚本连着成功两次也该只填一次，
  // 而用户在这之后手工改过的内容不该被下一拍轮询再盖回来。
  //
  // **动输入框是有门槛的**，三档往下让：
  //   · 不是这台浏览器点的 → 只展示（第 3 轮审查：刷新一下就把旧结果盖回用户刚保存的脚本上）
  //   · 是我们点的，但这条页面生命里没看着它开工（关着页面跑完的） → 摆出来让他自己挑
  //   · 看着它开工、而且框里还是当初那份 → 直接填，这才是用户点那颗按钮想要的
  useEffect(() => {
    if (job?.status !== "succeeded" || !job.script || filled.current === job.jobId) return;
    filled.current = job.jobId;
    if (!mine.current) { setApplied("shown"); return; }
    if (startedWith.current === null) {
      setOffered({ script: job.script, reason: "unwatched" });
      notify("AI 上一次真的把它起起来过；这个页面没看着它跑，所以没有直接覆盖输入框");
      return;
    }
    // 跑之前那份还原封不动 → 直接填。动过了 → 不覆盖，把 AI 这条摆出来让他自己选。
    if (current.current !== startedWith.current) {
      setOffered({ script: job.script, reason: "edited" });
      notify("AI 已真的把它起起来一次；你在这期间改过启动脚本，所以没有直接覆盖");
      return;
    }
    onFilled(job.script);
    setApplied("filled");
    notify("AI 已真的把它起起来一次，脚本已填入上面的输入框，确认后点保存");
  }, [job, onFilled, notify]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setOffered(null);
    setApplied(null);
    startedWith.current = script;
    const before = lastSeen.current;
    // **先记后发**：服务端是同步预占的，请求一旦发出去它就可能已经接单了。等响应回来再记，
    // 中间断线就等于这台浏览器从此不知道有这么个作业在跑（第 2 轮审查复现过）。
    pendingAssistTrace(projectId, instance.current);
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
      absorb(result);
    } catch (failure) {
      // 没拿到回复 ≠ 没接单：预占是同步的（preview-assist-jobs.ts），请求只要到了服务端就
      // 已经有一份作业了，而它完全可以在响应丢掉之后照样跑完、跑成功——**那就是一次真起来过
      // 的验证，不能当成「这一发没开起来」丢掉**（第 3 轮审查：页面只显示 Failed to fetch，
      // 脚本不填）。判据是作业身份跟点之前看到的那份不一样 = 服务端新开了一份 = 就是这一发；
      // 一样就说明这一发根本没落地（400/409 那种），照常把错误摆出来并把刚记的那条抹掉；
      // 连问都问不通就留着它，下次打开页面还有据可查。
      const checked = await api.previewAssist(projectId).catch(() => null);
      if (!active.current) return;
      if (checked?.job && checked.job.jobId !== before) { filled.current = null; absorb(checked); return; }
      if (checked) forgetAssistTrace(projectId);
      setError(failure instanceof Error ? failure.message : "启动失败");
    } finally { if (active.current) setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      const result = await api.cancelPreviewAssist(projectId);
      forgetAssistTrace(projectId);
      if (active.current) { setLost(false); setJob(result.job); }
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "取消失败");
    } finally { if (active.current) setBusy(false); }
  };
  // 「作业不见了」那张卡是本地记录推出来的，服务端没有对应的东西可轮询，所以得给它一个
  // 出口，否则它会在这个项目上一直挂着（不点「AI 协助填写」就不会被新作业顶掉）。
  const dismiss = () => { forgetAssistTrace(projectId); setJob(null); setLost(false); };
  const takeOffered = () => {
    if (!offered) return;
    onFilled(offered.script);
    startedWith.current = offered.script;
    setOffered(null);
    setApplied("filled");
    notify("已用 AI 试出来的那条脚本替换输入框里的内容");
  };
  const keepMine = () => {
    setOffered(null);
    setApplied("kept");
    notify("已保留你手写的启动脚本，上面输入框没有被改动");
  };

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
    {job && <PreviewAssistProgress job={job} offered={offered} applied={applied} onTakeOffered={takeOffered} onKeepMine={keepMine} onDismiss={lost ? dismiss : undefined} />}
  </div>;
}

function PreviewAssistProgress({ job, offered, applied, onTakeOffered, onKeepMine, onDismiss }: {
  job: PreviewAssistState;
  /** 成功了但没敢直接覆盖：这条脚本等用户自己拍板，连带没覆盖的原因。 */
  offered: { script: string; reason: "edited" | "unwatched" } | null;
  /** 成功之后输入框到底怎么了：填了 AI 的 / 留了手写的 / 一个字没动。 */
  applied: "filled" | "kept" | "shown" | null;
  onTakeOffered: () => void;
  onKeepMine: () => void;
  onDismiss?: () => void;
}) {
  const tone = job.status === "succeeded" ? " is-ok" : job.status === "failed" ? " is-bad" : "";
  return <div className={`preview-assist-progress${tone}`} role="status" aria-live="polite">
    <div className="preview-assist-step">
      {job.status === "running" && <CircleNotch size={13} className="preview-assist-spin" aria-hidden="true" />}
      <span>{job.step}</span>
      {job.status === "running" && job.round > 0 && <b>{job.round}/{job.maxRounds}</b>}
    </div>
    {/* 上面那行状态已经说了「在哪个地址上起来过」，这里只说接下来该做什么——同一件事写两遍
        会把真正的下一步（还得点保存）淹掉。**而这句话只能照 applied 说**：说成「已填入」却
        没填，用户就会以为框里那条手写的是 ash 验证过的（第 3 轮审查）。 */}
    {job.status === "succeeded" && applied === "filled" && <p className="preview-assist-verdict">
      脚本已填进上面的输入框；确认无误后点「保存预览设置」，任务里的「打开预览」就按它启动。
    </p>}
    {job.status === "succeeded" && applied === "kept" && <><p className="preview-assist-verdict">
      已按你的选择<b>保留你自己写的那条</b>：上面输入框一个字都没动，它没有经过 ash 试跑。AI 真起来过的是这一条，要换就把它复制过去：
    </p><pre className="preview-assist-script">{job.script}</pre></>}
    {job.status === "succeeded" && applied === "shown" && <><p className="preview-assist-verdict">
      这条结果不是这个页面点出来的（别的页面点的，或者上一次留下的——服务端把结果留 10 分钟），所以<b>没有动上面输入框里的内容</b>。要用它就把下面这条复制过去，或者自己再点一次「AI 协助填写」：
    </p><pre className="preview-assist-script">{job.script}</pre></>}
    {/* 用户在这几分钟里自己写了东西、或者压根没看见这次跑：他手上那份留着，AI 这条摆出来由他
        挑。静默覆盖等于把人家刚敲的几行删了，而那几行不在任何一个撤销栈里（第 2 轮审查）。 */}
    {job.status === "succeeded" && offered && <div className="preview-assist-offer">
      <p className="preview-assist-verdict">{offered.reason === "edited"
        ? "你在这期间改过上面的启动脚本，所以没有直接覆盖。AI 真起来过的是这一条："
        : "这次是在你没看着的时候跑完的（中间换过页面或刷新过），所以没有直接覆盖上面的输入框。AI 真起来过的是这一条："}</p>
      <pre className="preview-assist-script">{offered.script}</pre>
      <div className="preview-assist-offer-actions">
        <Button variant="primary" onClick={onTakeOffered}>用这条替换</Button>
        <Button onClick={onKeepMine}>保留我写的</Button>
      </div>
    </div>}
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
