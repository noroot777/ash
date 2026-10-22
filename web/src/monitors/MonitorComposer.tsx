import { useState } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import {
  MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_WAKE_LABEL, MONITOR_WAKE_TARGETS, monitorDurationOptions,
} from "@ash/shared/monitor";
import type { MonitorWakeTarget } from "@ash/shared/monitor";
import { neverExitsVerdict } from "@ash/shared/command-never-exits";
import { END_CONDITION_HINT, parseEndCondition } from "@ash/shared/monitor-end-condition";
import type { StartMonitorInput } from "./useTaskMonitors.ts";

// **从共享常量推导，不要在这里另列一张表**：写死的那版在时长上限改掉之后整张失真
// （选「2 小时」实际只盯 5 分钟，而且提交值恰好等于缺省值，连「已钳到边界」的回执都没有）。
const DURATIONS = monitorDurationOptions();

/**
 * 手动起一个哨兵。
 *
 * 入口留给人而不只留给 agent 的理由：想盯的那件事常常是**人**先知道的（这轮翻译要跑两
 * 小时、CI 刚推上去），与其先叫醒 agent 让它替你起一个，不如自己挂上去——它下次醒来就
 * 已经带着结果了。工作目录不在表单里：后端一律用任务自己的工作目录，让人在这里填一个
 * 别的路径只会制造「盯错了地方」这一类排查起来最费劲的故障。
 *
 * ── 「醒来叫谁」只在服务端说不清的时候才问 ─────────────────────────────────────
 *
 * 哨兵唯一的出口是唤醒这个任务，而这个任务可能同时有两条会话（实现者那条、审查者那条）。
 * agent 自己挂的那一路服务端答得出来（回合凭据 + 回合角色），**手动挂的不属于任何一条
 * 会话**：这个任务上又有一次审查正在进行时，叫谁都是在猜，所以服务端会拒掉并把
 * `needsWakeTarget` 带回来（见 server 的 monitor-session.ts）。那一刻才长出这个二选一 ——
 * 平时不问，是因为绝大多数任务只有一条线，多问一句只会让人以为自己漏填了什么。
 *
 * ── 「它什么时候算完」一直给得出来，只有**必须选**那一下才多问一句 ───────────────
 *
 * 结束条件的输入框**永远在**（第 1 轮审查 F3）：判据认不出来的跟随器到处都是（脚本封装、
 * `eval`、换个名字的二进制），而那只是「要不要逼你选」的判据 —— 拿它去决定「你能不能配」，
 * 等于让每一次漏判顺手把那条命令的出路也没收掉：审查实测 `tail -n 0 -F /dev/null` 就落在
 * 这一档，一个真跟随器，界面上连那个框都不给。
 *
 * 命令被判定为自己不会结束时（`tail -F`、`while true`）才多出那段说明和二选一：它只剩「盯满
 * 时长」一条出路，而服务端对这类命令会直接拒。这里**边打字边用同一份判据**把那个选择当场
 * 摆出来：等一条拒绝再回来补，中间那一趟是白走的，何况被拒的那一刻人已经点过「起一个哨兵」了。
 * 条件本身能不能用也在这里当场判（同一个 `parseEndCondition`），不让人拿一句 400 当反馈。
 *
 * ── **逼选只发生在「这边自己就证明得出来」的那一档**（新一轮审查 F1）───────────────
 *
 * 判定可以压着一个**没人核得了的前提**（`unprovable`，见共享判据文件头 ⑨⑩）：`tail -f x` 要
 * 那个文件执行到那一句时还在、`kubectl logs -f pod` 要那个远端 pod 还在跑。上一版照旧逼选，
 * 于是出现了审查实测到的那一幕：**同一条命令在表单上按钮是灰的，原样走接口却 200 建得出来**。
 * 界面比接口更严，等于这条路只有用接口的人走得通。
 *
 * 所以这里只有两档，跟服务端那道闸一字不差：
 *  · **一个前提都不压**的那一种（`tail -F`、`while true`）逼选 —— 先把选择摆出来省掉一趟来回。
 *  · **压着前提**的那一种只**提示**：把那一环照实说出来，按钮照常可点。
 *
 * 中间那个「本地路径交给服务端去 stat」的档**已经没有了**（第 2 轮审查 F1）：`existsSync` 读
 * 得到的是创建这一刻，判定要的是执行到那一句时，两个时刻之间隔着整条命令的前几段 ——
 * `rm ./doomed.log; tail -f doomed.log` 实测退出 0 却被 409。时刻不对的核查不是证明。
 */
export function MonitorComposer({
  busy,
  needsWakeTarget,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  /** 服务端上一次拒绝的理由是「说不清醒来叫谁」：这时必须选一个才能再提交。 */
  needsWakeTarget: boolean;
  onCancel: () => void;
  onSubmit: (input: StartMonitorInput) => void;
}) {
  const [command, setCommand] = useState("");
  const [description, setDescription] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(MONITOR_DEFAULT_TIMEOUT_MS);
  const [wake, setWake] = useState<MonitorWakeTarget | null>(null);
  const [ending, setEnding] = useState<"stopWhen" | "untilExpiry" | null>(null);
  const [stopWhen, setStopWhen] = useState("");
  // 这条命令自己会不会结束 —— 跟服务端那道闸**同一份判据**，所以这里亮出来的选择跟它要的
  // 东西一定对得上（各写一份的话，判据一改就只有一边跟着变，另一边照旧放人去撞 409）。
  const forever = neverExitsVerdict(command);
  // **这边自己就盖得住整条退出语义吗** —— 一个前提都不压的那一种才算（见上面那段）。压着前提
  // 的只提示:那件事**没有哪一层**核得了（连服务端也不行），而「我核不了」不是「它成立」。
  const proven = forever !== null && forever.unprovable === null;
  const typed = stopWhen.trim();
  // 条件本身的毛病当场说（同一份 `parseEndCondition`），不让人拿一句 400 当反馈。
  const parsed = parseEndCondition(typed);
  const condError = parsed.ok ? null : parsed.error;
  // 必须选的那一下才算「没选完」：填了字样算选了「出现就收工」，不填就得明说是要盯到到期。
  const endingChosen = !proven || typed.length > 0 || ending === "untilExpiry";
  // 要选而没选时**不许提交**：带着空的唤醒目标 / 缺着结束条件发出去只会再吃同一句拒绝。
  const ready = command.trim().length > 0
    && (!needsWakeTarget || wake !== null)
    && endingChosen
    && !condError;

  return (
    <form
      className="monitor-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        onSubmit({
          command: command.trim(),
          description: description.trim() || undefined,
          timeoutMs,
          ...(wake ? { wake } : {}),
          // 填了就带上，**不看它是不是跟随型**：会自己结束的命令也可以要求提前收工
          // （盯一轮回归，`FAILED` 一出现就不必等它跑完）。没填就一个字都不带。
          ...(typed ? { stopWhen: typed } : {}),
          // 「我本来就是要盯到到期」只在明说了的时候才是一个需要表的态。
          ...(!typed && ending === "untilExpiry" ? { untilExpiry: true } : {}),
        });
      }}
    >
      <label>
        <span>命令</span>
        <textarea
          rows={2}
          value={command}
          placeholder={'tail -F build.log | grep --line-buffered -E "ERROR|BUILD OK"'}
          onChange={(event) => setCommand(event.target.value)}
        />
      </label>
      <p className="monitor-composer__hint">
        它吐出的每一行都会唤醒这个任务一次，所以命令本身就是过滤器：只放行你真要被叫醒的那几行，
        并且把失败的特征一起放进去——不然命令崩了，这边只会是一片安静。
      </p>
      <label>
        <span>说明</span>
        <input
          value={description}
          placeholder="盯翻译进度"
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <fieldset className="monitor-composer__ending">
        <legend>它什么时候算完</legend>
        {/* 照实说是哪个写法触发的这一问：泛泛一句「这条命令不会结束」会让人以为是自己
            写错了语法，而真正要做的只是在两种意图里挑一个。 */}
        {forever
          ? (
            <p className="monitor-composer__hint">
              {/* 两档各说各的话（见上面那段）：证明得出来的那一档是「逼选」，压着前提的那一档
                  是「提示」—— 把那一环照实说出来，人才判得了要不要现在就补一个条件。 */}
              {proven
                ? `这条命令自己永远不会结束（${forever.what}），所以它不会有「跑完了」那一下。`
                  + "下面二选一——都不选它就只剩盯满时长这一条出路，被盯的活早干完了，任务也还得等到期才被叫醒。"
                : `这条命令可能永远不会结束（${forever.what}）：${forever.unprovable}。`
                  + "真是那样它只剩盯满时长这一条出路，所以下面二选一可以现在就补上；"
                  + "不补也建得起来——那件事谁都核不了，这里不替你决定。"}
            </p>
          )
          : (
            <p className="monitor-composer__hint">
              命令自己跑完就算完。想让它提前收工就填一个字样：那一行照常推给你，哨兵随即结束。
            </p>
          )}
        {forever && (
          <div className="monitor-composer__ending-options">
            <label>
              <input
                type="radio"
                name="monitor-ending"
                checked={ending === "stopWhen" || typed.length > 0}
                onChange={() => setEnding("stopWhen")}
              />
              <span>等到某个字样出现就收工</span>
            </label>
            <label>
              <input
                type="radio"
                name="monitor-ending"
                checked={ending === "untilExpiry" && !typed}
                onChange={() => { setEnding("untilExpiry"); setStopWhen(""); }}
              />
              <span>就是要盯到到期（每出现一次叫我一次）</span>
            </label>
          </div>
        )}
        <input
          className="monitor-composer__ending-pattern"
          value={stopWhen}
          placeholder={'BUILD OK|FAILED'}
          aria-label="出现就收工的字样"
          onFocus={() => setEnding("stopWhen")}
          onChange={(event) => { setStopWhen(event.target.value); setEnding("stopWhen"); }}
        />
        {/* 语法照实说一遍：这里收的是字样不是正则，而「^(OK|FAILED)」是几乎所有人的第一
            反应 —— 不说清楚，他只会得到一条永远不命中的结束条件。措辞**不在这儿写**:它要
            跟拒绝文案和 MCP 工具说明一字不差（第 2 轮审查 N1:上一版这里写着「其余字符都当
            它本身」，而带括号的字样其实是当场拒掉）。 */}
        <p className="monitor-composer__hint">{condError ?? END_CONDITION_HINT}</p>
      </fieldset>
      <label>
        <span>盯多久</span>
        <select value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))}>
          {DURATIONS.map((duration) => (
            <option key={duration.ms} value={duration.ms}>{duration.label}</option>
          ))}
        </select>
      </label>
      {needsWakeTarget && (
        <fieldset className="monitor-composer__wake">
          <legend>醒来叫谁</legend>
          {/* 为什么要问这一句，照实说：这个任务上有一次审查正在进行，而手动挂的哨兵不属于
              任何一条会话。猜错的两种后果都不便宜——叫实现者会凭空烧一个回合、审查那条会话
              继续等不到人；叫审查会把本该给实现者的结果投进一条正在收尾的审查。 */}
          <p className="monitor-composer__hint">
            这个任务上有一次审查正在进行。哨兵每吐一行都会唤醒一条会话，所以得说清叫谁：
            盯的是这次审查在等的那件事就选「这次审查」，是实现那边的活就选「实现者」。
          </p>
          <div className="monitor-composer__wake-options">
            {MONITOR_WAKE_TARGETS.map((target) => (
              <label key={target}>
                <input
                  type="radio"
                  name="monitor-wake"
                  value={target}
                  checked={wake === target}
                  onChange={() => setWake(target)}
                />
                <span>{MONITOR_WAKE_LABEL[target]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="monitor-composer__actions">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="submit" className="is-primary" disabled={!ready || busy}>
          {busy && <SpinnerGap size={12} className="is-spinning" />}
          起一个哨兵
        </button>
      </div>
    </form>
  );
}
