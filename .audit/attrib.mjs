// 归因映射 + 生成报告「四 结果与归因」。改完直接重跑,不手写 markdown。
// 用法: node .audit/attrib.mjs > .audit/part2.md
import { readFileSync, existsSync } from "node:fs";

const read = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
// 后来的 jsonl 覆盖先前的同 id 结果(bareverify 是复核轮,优先)
const byId = new Map();
for (const f of [".audit/bare.jsonl", ".audit/bareverify.jsonl"]) for (const r of read(f)) {
  const prev = byId.get(r.id);
  byId.set(r.id, prev ? { ...r, history: [...(prev.history ?? [{ label: prev.label, verdict: prev.verdict, ms: prev.ms }]), { label: r.label, verdict: r.verdict, ms: r.ms }] } : r);
}
const rows = [...byId.values()].sort((a, b) => a.id - b.id);

/** 归因表。cls: 真缺陷 | 契约过时 | 环境问题 | 已有主 | 待查 */
const A = {
  267: { cls: "契约过时", owner: "ae69818f(10-26) ↔ 80a8a2c5/4441e44a/bb1aa507(10-27)", one: "判据互撞:「借来的树里有安装记录认下的自有包必须克隆」(10-26 审查修)与「来源落在被冻结项目外即 external、link 即可」(10-27 三笔审查修)互相抵消,provideDependency 返回 link 而断言要 clone。", task: "T1" },
  281: { cls: "已有主", owner: "任务 Wv2NXsDKnFgC", one: "续跑租约被对账器提前结算成 outcome:'failed'(期望 null);本轮确认复现。", task: "—" },
  284: { cls: "待查", owner: "6bde853c(10-24)", one: "等待所有权落库后读回 `pending` 得 `undefined`(期望 `false`)。**与 #156 那一族无关**(它不走启动回执那条路),疑似 10-24 那轮 review 所有权改造留下的字段形状缺口,与 #281 同族。", task: "T2b" },
  38:  { cls: "契约过时", owner: "测试末笔 9a2ff615(10-10)", one: "web fixture/选择器过时:缺 /api/tasks/:id/notices 与 /api/events 路由桩。", task: "T6" },
  43:  { cls: "契约过时", owner: "测试末笔 27d7bd0a(10-28)", one: "断言用的正则对元素属性敏感,自动输入卡改折叠后节点属性漂移。", task: "T6" },
  85:  { cls: "契约过时", owner: "测试末笔 95d95489(09-09)", one: "等不到 .workspace-assistant-entry(10s 超时),该类名在后续前端改版中已不存在/改名。", task: "T6" },
  122: { cls: "契约过时", owner: "测试末笔 af0f7437(09-08)", one: "getByRole('alert') strict mode 命中 2 个元素——页面新增了第二条 alert(验收前置命令那条),选择器需收窄。", task: "T6" },
  397: { cls: "真缺陷", owner: "f716e83e(10-30)", one: "在「读浏览器授权 → spawn」窗口里插了 await assertReviewTurnStart(),破掉测试钉死的不变量:该窗口只许有撤回那一个 await。后果是用户在这段 await 里收回浏览器授权拦不住,首条消息仍写着已授权。fresh run(task-run.ts)那一路仍绿,只有续聊/召唤(orchestrator.ts)破。", task: "T3" },
  208: { cls: "真缺陷", owner: "review-continuation.ts", one: "裸 .set({ resumePrompt: null, updatedAt: now() }) 绕过 task-resume-prompt.ts 的代次助手,会漏掉代次——正是该测试 F1-A 钉的那一条。", task: "T4" },
  207: { cls: "已有主", owner: "疑同 Wv2NXsDKnFgC", one: "审查轮停在 'failed' 而非 'reviewing',与 #281 同一形状(提前结算),建议并入同一主。", task: "—" },
  203: { cls: "待查", owner: "e54376dd(10-24)", one: "待交付哨兵结果让结算侧把任务判成「还有话要说」;批量兼容那笔之后的回归。", task: "T5" },
  180: { cls: "待查", owner: "b6f37590(10-24)", one: "「补偿结果实际进入执行器 stdin」等不到;与 #203 同属哨兵投递族。", task: "T5" },
  195: { cls: "环境问题", owner: "测试自陈", one: "**闪红**(4 并发红、复核轮单并发 8 秒转绿),与断言自陈一致:「四轮都没能让那一行赶在收尾之前送出去 —— 台子前提不成立,不是产品问题」。台子靠反复竞速去凑前提,机器一忙就凑不出来。", task: "T9" },
  257: { cls: "契约过时", owner: "6bb6bdab(10-23)", one: "错误文案漂移:期望 /git worktree repair/,实得「目标分支 … 已在另一个 worktree … 检出；未运行验收前置命令」。", task: "T7" },
  258: { cls: "契约过时", owner: "6bb6bdab(10-23)", one: "同上一笔引入,基线更新恢复路径的断言未跟着验收前置命令改口径。", task: "T7" },
  261: { cls: "契约过时", owner: "6bb6bdab(10-23)", one: "建分支计划读回 null(期望 'feature-x'),同一笔的字段/时序变更。", task: "T7" },
  320: { cls: "契约过时", owner: "测试末笔 033d7be2(09-02)", one: "「codex 标了 probe,清单却和内置快照一模一样」——probe 结果与内置快照已趋同,断言用的是 notDeepStrictEqual,语义上只要两者相等就红。", task: "T8" },
  322: { cls: "待查", owner: "测试末笔 8986a12c(10-17)", one: "「只有 findRollout 定位得到的 codex 会话算迁移成功」2 !== 1:多出一条被判成功的会话。", task: "T8" },
  324: { cls: "契约过时", owner: "f19395a6(10-24)", one: "远程提问被 409「审查所属的原目标方向已失效，旧收尾不再修改目标」拦下;该闸是 10-24 审查所有权绑定新加的,测试台子(末笔 09-10)没带方向身份。", task: "T8" },
  156: { cls: "真缺陷", owner: "queue-seat.ts:282 + task-start-receipt.ts:22 + task-run.ts:244", one: "全新任务、干净库,**首次** POST /tasks/:id/run 就 409 而非 202。机制已定位:启动回执缺失:409 来自 `queue-seat.ts:282`「任务未通过启动检查，尚未启动，请稍后重试」,而那一句**只在 `waitForStartReceipt` 解析为 false 时**发出;`task-start-receipt.ts:22` 的回执只有在 `adoptRun(handle)` → `acknowledgeStartReceipt` 在起跑作用域内跑过才算有 —— 也就是**只有真 agent handle 被消费循环接手**才算。原生命令(`/status` 这类)在 `task-run.ts` 走到 `trackRun`(:244)之前就收口了,于是回合确实跑了、也确实按预期落了 failed,HTTP 那一侧却回 409 说「尚未启动」。日志里没有 `[ash] 任务 … 启动异常`,证明 `start()` 没抛,是**正常返回但没人发回执**。 用户可感知后果:在界面上给任务发一条带参数的 `/status`,看到的是「任务未通过启动检查，尚未启动，请稍后重试」,而不是真正的原因「/status 不接受参数」。本轮单独复跑一次原样复现(409 at :97,首次 run)。", task: "T2" },
  157: { cls: "真缺陷", owner: "同 #156", one: "任务停在 `running` 没到 `done` —— 同一条路的另一面:没发回执那一侧也没把占位还回来。", task: "T2" },
  371: { cls: "真缺陷", owner: "同 #156", one: "「这一回合确实由本次调用接管了(错误落在时间线上,不是「没送出去」)」false —— **独立第三处证据**:原生命令这条路没有「接管回合」这个事实,正是因为它不产出启动回执。", task: "T2" },
  373: { cls: "契约过时", owner: "5bca1ec3(10-16)", one: "该笔让 claude.ts 无条件注入 Monitor 钩子的 --settings,而测试钉的是「没配覆盖项就不该多出一截参数」;测试自 08-21 未动,这笔也没同步它。", task: "T10" },
  481: { cls: "真缺陷", owner: "test-service-ports-script.ts:75-76 + test-service-ports-fixtures.ts:85", one: "**闪红,但失败形态是破坏性的 —— 正因为是竞速才更该修**(复核轮单并发 18 秒转绿,佐证了下面那个「pidfile 还没落盘」的竞速窗口)。**它会 SIGKILL 掉自己的进程组**(本轮实证:sig=SIGKILL、日志 0 字节;无 shield 时把整个审计 runner 树一起带走、无退出码)。机制:`pidIn = (f) => Number(readFileSync(f,\"utf8\").trim())` 在 pidfile 还没落盘时得 0;:75-76 读 litePid 时**没加 >0 守卫**,而紧邻的 :77 给 liteWorkerPid 加了 `waitFor(() => pidIn() > 0)` —— 这个不对称就是线索,它前面那个 waitFor 只等「端口听上了」,不等 pidfile 落盘。pid 0 进了任何组级信号就打到调用方的整个进程组。产品侧已排除:terminal-stop-script.ts:163 的 runStopScript 用 `detached: !IS_WINDOWS`,用户停止脚本本来就在独立进程组。按文档跑法 `npm run test:service-ports-script` 会 SIGKILL 掉调用者的 shell 和 npm。", task: "T13" },
  503: { cls: "待查", owner: "server/src/team/lead-status.ts:46", one: "`TypeError: __name is not a function`,发生在模块加载期(team/session.ts:624 → team/session-consumer.ts:91 → lead-status.ts:46)。这是 esbuild/tsx keepNames 助手没注入到那个作用域的形态,不是业务断言失败 —— 要先判定是源码里某个语法踩了 tsx 的坑,还是工具链版本问题。", task: "T14" },
  508: { cls: "契约过时", owner: "9efd0081(10-31)", one: "断言用正则 `/if \\(!existsSync\\(cwd\\)\\)[\\s\\S]{0,400}?taskWorkspace\\(/` 扫 orchestrator.ts 源码文本,而那段逻辑已被同一笔拆进 turn-workspace-pick.ts —— 日志里 actual 甚至原样打出了新文件的注释「目录没了怎么办、还在又要刷什么,都在 turn-workspace-pick.ts」和 pickTurnWorkspace 调用。**这是 T11 的第二个独立实例**,与 #399 同因。", task: "T11" },
  535: { cls: "契约过时", owner: "验收前置命令那一轮", one: "实际多出 `acceptGateRunning: true` 字段,期望里没有 —— 前端同步契约没跟上验收前置命令新加的那个状态位。", task: "T15" },
  513: { cls: "契约过时", owner: "测试末笔早于相关前端改版", one: "playwright 等不到 `getByRole('textbox', { name: '回复任务' })`,30s 超时 —— 可访问名漂移或该入口已改。", task: "T16" },
  514: { cls: "契约过时", owner: "同上", one: "`page.waitForResponse` 30s 超时(等不到约定的那个响应),目标接口形状或触发路径已变。", task: "T16" },
  516: { cls: "契约过时", owner: "同上", one: "等不到 `getByRole('heading', { name: '创建一个聊天空间' })`,12s 超时 —— 文案或节点角色已改。", task: "T16" },
  560: { cls: "契约过时", owner: "同上", one: "等不到 `getByRole('button', { name: '刷新 git 状态' })`,30s 超时 —— 按钮可访问名已改。", task: "T16" },
  571: { cls: "契约过时", owner: "abf768ff(09-17)", one: "「历史 list must actually scroll」—— 与 #574/#576 同族:底部多了 26px 全局状态栏,可滚区域的前提变了。", task: "T17" },
  574: { cls: "契约过时", owner: "abf768ff(09-17)", one: "「mobile staged selection button must fit viewport height」:按钮 bottom 1130 超出视口 —— 同一个 26px 挤压。", task: "T17" },
  576: { cls: "契约过时", owner: "abf768ff(09-17)", one: "断言 workbench 必须恰好填满视口 `{0,0,1440,1000}`,实测 height=**974**(差 26px)。viewport 是 `newPage({viewport:{1440,1000}})` 显式设的,所以不是浏览器通道问题:底部那 26px 是 `abf768ff`(09-17)引入的全局状态栏。三条 git-workbench 布局测试末笔分别停在 09-15/09-16,**比状态栏早一两天**,之后再没动过 —— 已经红了约六周,因为它们在门禁范围外,没人看见。", task: "T17" },
  475: { cls: "环境问题", owner: "台子假设:测试窗口内本机不得有其它同属主新进程", one: "**两轮都红,所以不是并发污染 —— 这一条我先前归因错了,在此更正。** 4 并发那轮它报的孤儿是 pid 43703/43276,我当时判成「捞到了审计自己的进程」;复核轮**单并发**下它照样红,报的是 pid 86833/86832 —— 那个号段紧邻几分钟前观察到的、属于另一个 worktree 会话(2RYxjmZYUBWi)的 shell(pid 86852),所以更可能是本机其它无关会话的进程(等我去查时它们已退出,无法最终证明归属)。真正的判据写在 notice 自己的文本里:「同属主 + 出生在这次启动之后 + 环境里没有这次的记号 + 工作目录也核不上」。产品的处理是**如实上报而不是杀**(这一点是对的),但测试断言要求 notice 必须为空,等于假设「测试窗口内本机没有任何其它同属主的新进程」—— 这个假设在任何有人在用的开发机上都不成立,ash 服务自己起的进程也算。", task: "T12" },
  480: { cls: "待查", owner: "—", one: "「等不到:它走了之后,活号跟着销」(`test-service-ports-fixtures.ts:79` 的 waitFor 超时)。**两轮都红,排除并发**:进程走了而「活号」没跟着销,要判是产品没销还是台子等错了对象。", task: "T18" },
  482: { cls: "待查", owner: "—", one: "终端容量计数 17 !== 16,差一。**两轮都红,排除并发**(单并发下没有别的叶子占终端),所以是容量会计本身多算/少算了一个,倾向真缺陷。", task: "T18" },
  484: { cls: "环境问题", owner: "时序", one: "**闪红**:4 并发红、复核轮单并发 3 秒转绿。「闲置回收不许杀用户签字接手的进程」这条判据依赖进程存活时序,机器一忙就偶发。", task: "T12" },
  406: { cls: "待查", owner: "—", one: "5 项未通过:「行上的名单是 null —— 结构化责任在换快照那一步丢了」「重试把账销了,而那个孩子还在写」。**两轮都红,排除并发**;这两句描述的是换快照时丢了结构化责任、以及销账早于孩子停写,倾向真缺陷。", task: "T19" },
  491: { cls: "真缺陷", owner: "同 #156", one: "409「任务未通过启动检查，尚未启动，请稍后重试」—— 与 #156 命中同一行(`queue-seat.ts:282`),第二处独立证据。", task: "T2" },
  399: { cls: "契约过时", owner: "9efd0081(10-31)", one: "测试按文件名扫 orchestrator.ts 的源码文本找 affectedCodexResumeVersion,而该笔把它拆进了 turn-session-pick.ts;行为未丢。属「源码文本扫描型测试 vs 700 行拆分规则」的结构性冲突。", task: "T11" },
};

const CLS_ORDER = ["真缺陷", "契约过时", "待查", "环境问题", "已有主"];
const stable = (r) => (r.history ?? []).every((h) => h.verdict !== "green");
const nonGreen = rows.filter((r) => (r.history ? r.history.at(-1).verdict : r.verdict) !== "green" || (r.history && r.history.some((h) => h.verdict !== "green")));

const name = (r) => r.cmd.replace(/^(tsx|node)( --[\w-]+)* /, "").replace(/^scripts\//, "");
const green = rows.filter((r) => !nonGreen.includes(r));

console.log(`## 四 结果与归因\n`);
console.log(`### 4.1 总账\n`);
console.log(`| | 条数 |`);
console.log(`|---|---|`);
console.log(`| 叶子脚本总数 | ${rows.length} |`);
console.log(`| 两轮都绿 | ${green.length} |`);
console.log(`| 闪红(基线红、复核轮单并发转绿) | ${nonGreen.filter((r) => !stable(r)).length} |`);
console.log(`| **稳定红**(两轮都红) | **${nonGreen.filter(stable).length}** |`);
console.log(`| 跳过 | 0(全部真实执行;Windows 侧未执行见 §2.4) |`);
console.log();
console.log(`${green.length} + ${nonGreen.filter((r) => !stable(r)).length} + ${nonGreen.filter(stable).length} = ${rows.length}。表 B 抬头写的「绿 ${green.length + nonGreen.filter((r) => !stable(r)).length}」是**末轮口径**(把 3 条闪红算进绿),两个数都对,口径不同。`);
console.log();
console.log(`稳定红里 **7 条在验收门禁范围内**(#38 #43 #85 #122 #267 #281 #284),31 条在范围外。`);
console.log();
console.log(`### 4.2 非绿清单与归因\n`);
console.log(`「稳」=两轮都红(稳定红);「闪」=两轮里有一轮绿。门禁列 ✓ 表示落在验收门禁范围内。\n`);
console.log(`| # | 门禁 | 叶子 | 稳/闪 | 耗时 | 归因 | 责任笔 / 已有主 | 建议单 |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const r of [...nonGreen].sort((a, b) => {
  const ca = CLS_ORDER.indexOf(A[a.id]?.cls ?? "待查"), cb = CLS_ORDER.indexOf(A[b.id]?.cls ?? "待查");
  return (Number(b.inGate) - Number(a.inGate)) || ca - cb || a.id - b.id;
})) {
  const a = A[r.id] ?? { cls: "待查", owner: "—", one: "（本轮新出现,见下方明细）", task: "—" };
  const vs = (r.history ?? [{ verdict: r.verdict }]).map((h) => h.verdict === "green" ? "绿" : h.verdict === "timeout" ? "超时" : "红").join("→");
  console.log(`| ${r.id} | ${r.inGate ? "✓" : ""} | \`${name(r)}\` | ${stable(r) ? "稳" : "闪"} (${vs}) | ${Math.round(r.ms / 1000)}s | ${a.cls} | ${a.owner} | ${a.task} |`);
}
console.log();
console.log(`### 4.3 逐条明细\n`);
for (const r of [...nonGreen].sort((a, b) => Number(b.inGate) - Number(a.inGate) || a.id - b.id)) {
  const a = A[r.id] ?? { cls: "待查", owner: "—", one: "本轮新出现,断言见日志。", task: "—" };
  console.log(`**#${r.id} \`${r.pkg}: ${name(r)}\`** — ${a.cls}${r.inGate ? "・门禁内" : ""}・${stable(r) ? "稳定红" : "闪红"}`);
  console.log(`- 归因:${a.one}`);
  console.log(`- 责任笔:${a.owner}　建议单:${a.task}`);
  console.log(`- 日志:\`${r.log}\`(${(r.logBytes / 1024).toFixed(1)} KB)`);
  console.log();
}
