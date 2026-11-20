// MCP 工具说明的那一段预算（`test-prompt-budget.ts` 的 BUDGETS 原样展开它）。单独一份是因为那份
// 顶到了 700 行；数字的口径、改大要在 diff 里看得见，都跟那张表一样。
export const MCP_TOOL_BUDGETS: Record<string, number> = {
  // 字段说明按 **SDK 真正发出去的那份 JSON Schema** 量（见采样器 `toolTexts`）。
  "mcp/accept_task": 1750,
  "mcp/answer_question": 600,
  "mcp/ask_question": 1750,
  // 2026-11-20 +60（2300 → 2342 实测）、create_task_chain +500（2550 → 3035 实测）：开工起点上就超了（前置那几句
  // 落进 taskShape 与工具说明时没跟着改这张表），本轮没动这两个工具，按实测补上，不算本轮的增长。
  "mcp/batch_create_tasks": 2360,
  "mcp/complete_task": 1450,
  "mcp/create_group": 400,
  "mcp/create_queue": 220,
  "mcp/create_task_chain": 3060,
  "mcp/debate_reply": 1400,
  // mcp/dispatch（团队调度者派活）不在表里：团队停用后它只在 NAVI_LEGACY_TEAM_AND_DUET=1 时注册（shared/src/legacy-modes.ts），
  // 缺省口径下发不出去，也就量不到。
  // 三块判据全文的唯一落脚处（见 PLACEMENT），所以它理应是工具里偏大的一条。
  "mcp/dispute_review": 3400,
  "mcp/get_queue": 160,
  "mcp/get_task": 130,
  "mcp/list_groups": 360,
  "mcp/list_monitors": 430,
  // 2026-11-15 +100（500 → 590 实测）：返回字段里多了 prerequisites（前置到哪一步 / 在不在等），派活的
  // 智能体靠它看一串任务卡在哪，不再在任务说明里让执行者「没合入就提问等着」。
  "mcp/list_tasks": 600,
  "mcp/patch_task": 1100,
  "mcp/pause_task": 950,
  "mcp/queue_insert": 220,
  "mcp/queue_remove": 190,
  "mcp/queue_reorder": 270,
  "mcp/read_task_transcript": 1150,
  // 2026-11-03 +100（1952 → 2119 实测）：`recurs` 字段说明（`RECURS_FIELD_GUIDE`，≤ 200B），
  // 审查者声明同类问题承接的唯一入口。用户给的预算是「字段说明 ≤ 200 + 清单旁一句 ≤ 120」。
  // 2026-11-13 -330（2119 → 1791 实测）：旧口径的 `verificationBasis` 参数随那道闸一起删掉。
  "mcp/report_stage": 1820,
  "mcp/requeue_task": 560,
  "mcp/resolve_group": 530,
  "mcp/resolve_project": 250,
  "mcp/run_group": 320,
  // 2026-11-15 +10：有前置没站稳时回 waiting 的那半句。
  "mcp/run_task": 350,
  // 「怎么登记回归」的机制住在这里而不在每轮前言（见 mcp/src/tools/monitor.ts 文件头）：
  // 一份工具说明换掉每一轮都重发一遍，所以它大得有理由，但仍然要有个顶。
  "mcp/start_monitor": 5100,
  "mcp/stop_monitor": 850,
  "mcp/stop_task": 480,
  // 2026-11-18 新增（654 实测）：挂出「该做但不属于本任务」的活，不停任务。
  // 2026-11-18 +160（654 → 849 实测）：挂上的不再按回合收掉，多一样 `withdraw`（哪一件、为什么）和一句
  // 「挂上的一直留着、不成立了就收回」——智能体不知道这条就会每回合重挂，或者让过时的一直挂着。
  // 2026-11-20 +1490（849 → 2307 实测）：派活单（propose_dispatch，2150）并进来，那个工具删掉——两样合计从约
  // 3000 降到这一份。多出来的是三档 wait 各一句（不等 / 等完结成完成 / 等完续上会话）和每件可带的谁来审、标签、
  // 同批前置（照建任务那几个参数的原有说明）。
  "mcp/suggest_dispatch": 2350,
};
