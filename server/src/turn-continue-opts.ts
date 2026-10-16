// `continueTask` 的**入口参数**。单独一份,原因有两个:
//
// ① 它是这整条链的**契约**:哪一轮是谁起的、算不算任务的执行、要不要旁路、起跑前还要过哪道闸
//    —— 这些字段的语义各自都踩过坑,所以注释比字段本身长得多。它住在 orchestrator 里的时候,
//    那个文件被这份契约顶过了单文件 700 行的硬上限(本轮审查 F4)。
// ② 调用方要的本来就只是这份类型:`runs.ts` 原来靠 `Parameters<typeof continueTask>[2]` 绕一圈
//    才拿得到它,现在直接 `import type`。
//
// 这里**只放类型**,不放运行时代码 —— 它被回合入口、投递、审查派发多处 import,混进运行时
// 逻辑就会在那几条链上引出新的加载顺序。
import type { AgentType } from "@ash/shared";
import type { ResumeReason } from "./orchestrator.js";
import type { TurnSource } from "./runs.js";

export type ContinueOpts = {
    agent?: AgentType;
    executorId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    attachments?: string[];
    system?: ResumeReason;
    /**
     * 「执行意图」与「输入来源」分开表示(第 xNb655YqYzcA 链第 4 轮):这一回合是
     * **任务的执行**(让位交接/手动运行/重试把到期的用户回复当启动输入),所以终态
     * 任务不走续聊语义(followUpFrom 不护旧终态,队列照常占位)——这一点与 system
     * 同口径;但输入是**真实用户消息**,落盘记录、工作目录基线、检查点消费、失败时
     * 的未送达交代全按用户消息走——这一点与 system 相反。只给 system 一个标记时,
     * 二者绑死:让位交接只能二选一,要么用户原文不进会话记录,要么终态重试被误当续聊。
     */
    executionTurn?: boolean;
    /** 旁路回合结束后恢复进入旁路前的任务状态。 */
    sideTurn?: boolean;
    /**
     * 这一回合的身份:**谁起的 + 为哪一次审查的哪一轮而起,一个对象**(见 runs.ts 的
     * `TurnSource`)。缺省 = `{ role: "single" }`。
     *
     * 两样绑在一起是因为它们分开过一次就出过事:上一版是 `sessionRole?` 与 `reviewSource?`
     * 两个各自可缺的字段,于是「reviewer 但没带审查代次」在类型上完全合法 —— 首次派审带了,
     * 自动投递/手动恢复/答复提问三条恢复入口各自漏了,活着的审查者从此挂不上哨兵
     * (本轮审查 F2 实测 HTTP 409)。现在漏传在编译期就过不去。
     */
    turnSource?: TurnSource;
    freshSession?: boolean;
    /** 内部旁路回合可钉在一个准确工作目录（例如验收快照的 detached worktree）。 */
    cwd?: string;
    /**
     * 指名续**这一条**会话行（而不是按 agentType+role 现挑）。给「重跑上一回合」用：
     * 那条路的硬要求就是落回崩掉的那一条会话，挑错人 = 换个人重说一遍。
     * 行已不存在时退回新开会话（读它的调用方刚读过库，正常不会发生）。
     */
    resumeSessionId?: string;
    /**
     * 这一轮的字是**后端代写**的（验证打回的报告、验收冲突的交接说明），但它必须占一个
     * 真人回合 —— 带 system 会被当成「系统续跑」，followUpFrom 就护不住任务原来的终态。
     * 于是落盘时标一位 by:"system"，让读端（Inspector 的「后续追问」、侧边栏铺开那一列）
     * 能把它跟我自己打的字分开。默认 false = 真人发的。
     */
    byBackend?: boolean;
    /**
     * **这一回合是谁点的**(多人模式)。共享项目里 B 可以在 A 的任务上回复/重跑/派审,
     * 而那一轮烧的是 B 自己的 key —— 所以执行器、供应商、个人 CLI 环境与 git 署名
     * 全部按 B 解析,而不是按 `tasks.ownerUserId`(§八「共享项目里的跨人操作」)。
     *
     * **只有真人发起的路径传它**:调度器、队列推进、上游唤醒、团队派活这些后端路径
     * 不传,它们照旧按任务归属人跑 —— 那才是「这个任务是谁的活」。
     */
    actingUserId?: string | null;
    /**
     * 调用方已在入口**原子占住** turn（claimTurn 成功后传 true）：这里不再抢锁，用
     * sessionRole 接管（reclaimTurn）并照常在 finally 释放。入口占位是并发双 202 谎报
     * 的唯一解——只读预检查后的任何 await 间隙都可能被另一次启动抢先。
     */
    turnHeld?: boolean;
    /**
     * 起跑前再查一遍冻结事实（分组暂停 / 任务被删或归档），命中就在 spawn 之前撤回。
     *
     * 给「预检查离 spawn 很远」的启动路径开：重试按钮、自由审查重跑 —— 它们从只读预检查
     * 到真正拉起 CLI 之间隔着权威重读、执行器解析、工作目录准备、上一条输入的读取，中途
     * 还会把回合锁交接一次。普通续聊不开：在一个排队中/分组暂停的任务上发消息本来就允许，
     * 那不是被冻结的启动（说明见 turn-freeze.ts）。
     */
    freezeGuard?: boolean;
    /**
     * 「用户这句话已经**落盘**了」的回调 —— 在原话作为一个真人回合写进会话之后立刻调，
     * 不等这一轮跑完（`continueTask` 要等整轮结束才 resolve，那时早过了）。
     *
     * 给排队/定时消息用：它们要在这一刻、而不是更早，才把库里那条标成 sent。早一步标，
     * 进程死在中间就是「托盘里没了、会话里也没有」——用户那句话凭空蒸发
     * （见 docs/incidents.md「排队消息凭空消失」）。
     */
    onDelivered?: () => void | Promise<unknown>;
    /**
     * 「这个任务此刻还能不能被**这条消息**叫醒」——**占住回合之后**再问一次，返回理由
     * 字符串就撤回这一轮（返回 false，一个字都不送）。
     *
     * 给哨兵事件用。它的资格判定原本只发生在投递扫描那一层，可抢到投递租约与真正起这
     * 一轮之间还隔着「等当前回合退干净」：那段时间里用户完全可以把任务标成完成，而租约
     * 不是送达 —— 于是一条尚未进会话的事件照样把一个已经 done 的任务拉回 running、多烧
     * 一轮会话（第 4 轮审查实测：总线真的走了 paused → done → running → done）。
     *
     * 只在这条路上开：真人排的队列消息在终态上走的是相反语义（「下次醒来处理」就是他排
     * 它的意思），给它挂这道闸等于把他的话吞了。
     */
    wakeGuard?: () => Promise<string | null>;
    throwOnTeamUnavailable?: boolean;
};
