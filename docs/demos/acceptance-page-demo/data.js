// 样机用的假数据。场景只描述「这一刻任务处在什么事实上」，画法全在 app.js。
(() => {
  const FILES = [
    { path: "web/package.json", add: 2, del: 1 },
    { path: "web/src/task-detail/footnoteActions.ts", add: 87, del: 0 },
    { path: "web/src/task-detail/turnFootnote.ts", add: 18, del: 9 },
    { path: "web/src/task-detail/ConversationFeed.tsx", add: 25, del: 37 },
    { path: "web/src/free-workflow/freeReviewCopy.ts", add: 8, del: 0 },
    { path: "web/scripts/test-footnote-actions.ts", add: 313, del: 0 },
  ];

  // [旧行号, 新行号, 记号, 正文]
  const DIFFS = [
    [
      [18, 18, " ", '    "build": "node ../scripts/check-conventions.mjs && tsc -b && vite build",'],
      [19, 19, " ", '    "//test": "前端全量回归。改完 web/ 交付前跑一遍。",'],
      [20, null, "-", '    "test": "npm run test:side-chat && npm run test:turn-failure && …",'],
      [null, 20, "+", '    "test": "npm run test:side-chat && npm run test:turn-failure && npm run test:footnote-actions && …",'],
      [21, 21, " ", '    "//test:selection-content": "会话里选中一段 → 添加到备忘 / 添加到对话",'],
      [null, null, "…", ""],
      [71, 71, " ", '    "test:dispute-timeline-cta": "node scripts/test-dispute-timeline-cta.mjs",'],
      [null, 72, "+", '    "test:footnote-actions": "tsx --import ./scripts/ignore-css-hooks.mjs scripts/test-footnote-actions.ts",'],
      [72, 73, " ", '    "test:review-no-verdict-retry": "node scripts/test-review-no-verdict-retry.mjs",'],
    ],
    [
      [null, 1, "+", "// 尾注上「现在轮到你」的那一个动作：按话题留到这件事了结，不被同一回合后来的话挤掉。"],
      [null, 2, "+", "export type FootnoteAction = { topic: string; label: string; settled: boolean };"],
      [null, 3, "+", ""],
      [null, 4, "+", "export function pickFootnoteActions(rows: FootnoteAction[]): FootnoteAction[] {"],
      [null, 5, "+", "  const latest = new Map<string, FootnoteAction>();"],
      [null, 6, "+", "  for (const row of rows) if (!row.settled) latest.set(row.topic, row);"],
      [null, 7, "+", "  return [...latest.values()];"],
      [null, 8, "+", "}"],
    ],
    [
      [41, 41, " ", "export function turnFootnote(turn: PersistedTurn): Footnote | null {"],
      [42, null, "-", "  const last = turn.notes.at(-1);"],
      [43, null, "-", "  if (!last) return null;"],
      [null, 42, "+", "  const actions = pickFootnoteActions(turn.notes.map(toAction));"],
      [null, 43, "+", "  if (!turn.notes.length) return null;"],
      [44, 44, " ", "  return {"],
      [45, null, "-", "    text: phrase(last),"],
      [null, 45, "+", "    text: turn.notes.map(phrase).join(\"，\"),"],
      [null, 46, "+", "    actions,"],
      [46, 47, " ", "  };"],
    ],
  ];

  const COMMITS = [
    { sha: "9c41e7b2", subject: "fix(web): 「去裁定」按话题留到裁完为止", when: "今天 09:12" },
    { sha: "1fa0d3c6", subject: "test(web): 尾注动作的回归夹具", when: "今天 09:31" },
  ];

  const BRANCHES = ["feat/ui-revamp", "main", "feat/issue-center", "worktree-agent-survives-restart"];

  const LOG_RUNNING = [
    "> ash@0.9.4 test:accept",
    "> npm run typecheck && npm run test:server && npm run test:web",
    "",
    "✓ typecheck  41.2s",
    "✓ test:queue  (38 passed)",
    "✓ test:free-review  (112 passed)",
    "✓ test:accept-gate  (64 passed)",
    "… test:web  conversation-notes-dom",
  ];

  const LOG_FAILED = [
    "✓ test:accept-gate  (64 passed)",
    "✓ test:web  conversation-notes-dom",
    "✗ test:web  footnote-actions-dom",
    "    expected 「去裁定」 to stay after a later note in the same turn",
    "    at scripts/test-footnote-actions-dom.mjs:31",
    "",
    "1 failed · 311 passed · 12m 04s · rc=1",
  ];

  const base = () => ({
    source: "ash/e431l1YY",
    target: "feat/ui-revamp",
    base: "4b429e28",
    stat: { files: 14, add: 709, del: 57 },
    gate: { command: "npm run test:accept", prepare: "", baseline: "preview", status: "idle", elapsed: 0, open: false },
    rows: [],
    children: [],
    accepted: null,
    // 这一按的两个开关，只活在确认层里：关掉就回到项目默认。
    commit: true,
    skip: false,
    rerun: false,
  });

  const SCENES = [
    { id: "ready", label: "可以验收", make: base },
    {
      id: "running", label: "前置命令在跑",
      make: () => ({ ...base(), gate: { ...base().gate, status: "running", elapsed: 161 } }),
    },
    {
      id: "failed", label: "前置命令没过",
      make: () => ({ ...base(), gate: { ...base().gate, status: "failed", open: true } }),
    },
    {
      id: "passed", label: "已经跑绿",
      make: () => ({ ...base(), gate: { ...base().gate, status: "passed" } }),
    },
    {
      id: "blocked", label: "被拦住",
      make: () => ({
        ...base(),
        rows: [
          { id: "conflict", tone: "block", text: "与 feat/ui-revamp 冲突", code: "web/package.json", action: "让任务解决" },
          { id: "dirty", tone: "block", text: "3 个文件未提交", code: "", action: "提交" },
          { id: "review", tone: "warn", text: "审查之后又有 1 个提交", code: "", action: "审查新改动" },
        ],
      }),
    },
    {
      id: "family", label: "带派生任务",
      make: () => ({
        ...base(),
        children: [
          { title: "「去裁定」按钮的键盘可达性", branch: "ash/k2LmQ8xT", stat: "3 文件 +41 −6", checked: false },
          { title: "尾注动作在窄屏下不换行", branch: "ash/9xQaR1vN", stat: "2 文件 +17 −4", checked: false },
        ],
      }),
    },
    {
      id: "accepted", label: "已验收",
      make: () => ({ ...base(), accepted: { mode: "passed", pending: false }, gate: { ...base().gate, status: "passed" } }),
    },
    {
      id: "pending", label: "已验收，没提交",
      make: () => ({ ...base(), commit: false, accepted: { mode: "passed", pending: true }, gate: { ...base().gate, status: "passed" } }),
    },
  ];

  window.ACC = { FILES, DIFFS, COMMITS, BRANCHES, LOG_RUNNING, LOG_FAILED, SCENES };
})();
