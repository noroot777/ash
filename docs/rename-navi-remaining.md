# 改名剩余清单

由 `node scripts/rename-navi.mjs --report` 生成，是生成那一刻的快照：行号会随后续改动漂移，要最新的就重新生成。
第一部分是整词 ash（产品的上一代名字），第二部分单列更早一代 harness。

# 一、ash（1181 处）

## db-file（317 处）

库文件现在仍叫 ash.db（LEGACY_DB_FILE：老安装继续用，新安装暂时也建它，mac 应用只认这个名字）

- .gitignore:25  # 而残留会弄脏工作区、挡住验收合并(2026-10-10 一个 0 字节的根目录 ash.db 挡过一次)。
- README.md:249  | `NAVI_DB` | `./data/ash.db` | SQLite 数据库路径 |
- desktop/macos/README.md:78  # 1. 退出 app，停掉服务（数据根里 ash.db.ash.lock 记着 pid）
- desktop/macos/README.md:79  kill "$(node -p 'require(process.env.HOME + "/Library/Application Support/dev.navi.mac/ash.db.ash.lock").pid')"
- desktop/macos/README.md:84  mkdir -p rolled-back && mv ash.db ash.db-wal ash.db-shm rolled-back/ 2>/dev/null
- desktop/macos/README.md:84  mkdir -p rolled-back && mv ash.db ash.db-wal ash.db-shm rolled-back/ 2>/dev/null
- desktop/macos/README.md:84  mkdir -p rolled-back && mv ash.db ash.db-wal ash.db-shm rolled-back/ 2>/dev/null
- desktop/macos/README.md:85  cp backups/<那一份>.db ash.db
- desktop/macos/README.md:162  数据根里还没有 `ash.db` 时，窗口开成一扇 980×660 的小窗（不是 1440 的大窗正中摆几行字），先问数据从哪来（`FirstRunView`：左边一栏是 Navi 和首次配置要走的几站，右边是两个选项；选了之后原地转圈直到页面接上，不换屏、不闪白）。原生那一屏只交给表了态的页面（报了窗口大小 = 画出
- desktop/macos/Sources/DataImport.swift:9  /// `ash.db` 加上对不上的 `-wal` 就是一份坏库。库走 SQLite 的在线备份（一个读事务里整份拷出，
- desktop/macos/Sources/DataImport.swift:19  /// 「全新开始」。发布时库最后落，它就是提交点：之前的任何一步失败，数据根里都还没有 `ash.db`，
- desktop/macos/Sources/DataImport.swift:47  let db = url.appendingPathComponent("ash.db")
- desktop/macos/Sources/DataImport.swift:49  throw Failure("\(url.path) 里没有 ash.db。要选的是 Navi 的数据目录（仓库里是 data/）。")
- desktop/macos/Sources/DataImport.swift:61  return Source(url: url, livePID: livePID(lock: url.appendingPathComponent("ash.db.ash.lock")))
- desktop/macos/Sources/DataImport.swift:77  let db = staging.appendingPathComponent("ash.db")
- desktop/macos/Sources/DataImport.swift:78  try SQLiteFile.snapshot(from: source.url.appendingPathComponent("ash.db"), to: db)
- desktop/macos/Sources/DataImport.swift:96  let exact: Set<String> = ["ash.db", "ash.db-wal", "ash.db-shm", "ash.db-journal", "deps", "tmp", journalName]
- desktop/macos/Sources/DataImport.swift:96  let exact: Set<String> = ["ash.db", "ash.db-wal", "ash.db-shm", "ash.db-journal", "deps", "tmp", journalName]
- desktop/macos/Sources/DataImport.swift:96  let exact: Set<String> = ["ash.db", "ash.db-wal", "ash.db-shm", "ash.db-journal", "deps", "tmp", journalName]
- desktop/macos/Sources/DataImport.swift:96  let exact: Set<String> = ["ash.db", "ash.db-wal", "ash.db-shm", "ash.db-journal", "deps", "tmp", journalName]
- desktop/macos/Sources/DataImport.swift:132  let entries = try fm.contentsOfDirectory(atPath: staging.path).filter { !["ash.db", "ash.db-shm", "ash.db-journal"].contains($0) }
- desktop/macos/Sources/DataImport.swift:132  let entries = try fm.contentsOfDirectory(atPath: staging.path).filter { !["ash.db", "ash.db-shm", "ash.db-journal"].contains($0) }
- desktop/macos/Sources/DataImport.swift:132  let entries = try fm.contentsOfDirectory(atPath: staging.path).filter { !["ash.db", "ash.db-shm", "ash.db-journal"].contains($0) }
- desktop/macos/Sources/DataImport.swift:133  guard !entries.contains("ash.db-wal") else { throw Failure("导出来的库还没收成单个文件，没有导入。") }
- desktop/macos/Sources/DataImport.swift:139  try fm.moveItem(at: staging.appendingPathComponent("ash.db"), to: dest.appendingPathComponent("ash.db"))
- desktop/macos/Sources/DataImport.swift:139  try fm.moveItem(at: staging.appendingPathComponent("ash.db"), to: dest.appendingPathComponent("ash.db"))
- desktop/macos/Sources/DataImport.swift:170  guard !FileManager.default.fileExists(atPath: dest.appendingPathComponent("ash.db").path) else {
- desktop/macos/Sources/DatabaseBackup.swift:5  /// `ash.db` 加上对不上的 `-wal` 就是一份坏库。在线备份在一个读事务里整份拷出，是某一时刻的
- desktop/macos/Sources/DatabaseBackup.swift:128  let db = NaviConfig.dataURL.appendingPathComponent("ash.db")
- desktop/macos/Sources/LaunchFlow.swift:122  panel.message = "选一份 Navi 的数据目录（里面有 ash.db，比如仓库里的 data/）"
- desktop/macos/Sources/NaviConfig.swift:97  FileManager.default.fileExists(atPath: dataURL.appendingPathComponent("ash.db").path)
- desktop/macos/Sources/RestartImpact.swift:109  let lock = NaviConfig.dataURL.appendingPathComponent("ash.db.ash.lock")
- desktop/macos/Sources/ServerLauncher.swift:108  let db = NaviConfig.dataURL.appendingPathComponent("ash.db")
- docs/install.md:237  **数据与备份**:全在仓库里的 `data/`——`ash.db`(SQLite)+ `runs/`(每轮的正文、trace、验证证据)+ `uploads/`。备份就备份这个目录;换机器把它整个拷过去即可。`data/` 不入库,所以你发出去的包永远不含对方不该看的东西,反过来对方的数据也不会被你的包覆盖。
- docs/install.md:244  | `NAVI_DB` | `<仓库>/data/ash.db` | 库文件位置 |
- docs/win-remote.md:89  (`data\ash.db`、`dist\`、`*.tsbuildinfo`)原样活到下一次快照里。SHA 和 junction 全绿也照不出
- docs/windows-testing.md:34  | `path-boundary` | 红 → 绿 | 收尾 `EBUSY: unlink ash.db`(A 类) |
- docs/windows-testing.md:87  - `path-boundary` 断言全过,却在 `finally` 里 `EBUSY: unlink …ash.db` —— Windows 删不掉还开着的
- scripts/server-control.mjs:15  * 不然 `navi.db` 在就是它,否则 `ash.db`。
- scripts/server-control.mjs:22  // 新安装暂时也是 `ash.db`(理由见 server/src/db/path.ts)。
- scripts/test-macos-client.mjs:103  fs.writeFileSync(path.join(dataDir,'ash.db'),'');
- scripts/test-macos-client.mjs:425  writeFileSync(join(source, "ash.db.exits.jsonl"), "{}\n");
- scripts/test-macos-client.mjs:426  writeFileSync(join(source, "ash.db.ash-online.123.json"), "{}");
- scripts/test-macos-client.mjs:429  const live = new DatabaseSync(join(source, "ash.db"));
- scripts/test-macos-client.mjs:434  writeFileSync(join(source, "ash.db.ash.lock"), JSON.stringify({ pid: process.pid, port: 4317, token: "x" }));
- scripts/test-macos-client.mjs:477  assert.equal(existsSync(join(data, "ash.db")), false);
- scripts/test-macos-client.mjs:484  writeFileSync(join(data, "ash.db"), "fresh");
- scripts/test-macos-client.mjs:493  assert.equal(readFileSync(join(data, "ash.db"), "utf8"), "fresh", "the data a fresh start created is kept");
- scripts/test-macos-client.mjs:497  rmSync(join(data, "ash.db"));
- scripts/test-macos-client.mjs:519  for (const skipped of ["deps", "tmp", "downloads", "ash.db.ash.lock", "ash.db.ash-online.123.json", ".mac-maintenance.json", "ash.db-wal", "ash.db-shm",
- scripts/test-macos-client.mjs:519  for (const skipped of ["deps", "tmp", "downloads", "ash.db.ash.lock", "ash.db.ash-online.123.json", ".mac-maintenance.json", "ash.db-wal", "ash.db-shm",
- scripts/test-macos-client.mjs:519  for (const skipped of ["deps", "tmp", "downloads", "ash.db.ash.lock", "ash.db.ash-online.123.json", ".mac-maintenance.json", "ash.db-wal", "ash.db-shm",
- scripts/test-macos-client.mjs:519  for (const skipped of ["deps", "tmp", "downloads", "ash.db.ash.lock", "ash.db.ash-online.123.json", ".mac-maintenance.json", "ash.db-wal", "ash.db-shm",
- scripts/test-macos-client.mjs:525  assert.match(tool.db, /\/\.import-staging-\d+-[^/]+\/ash\.db$/, "the copy is washed in staging, before it is published");
- scripts/test-macos-client.mjs:528  const copied = new DatabaseSync(join(data, "ash.db"), { readOnly: true });
- scripts/test-macos-client.mjs:537  assert.equal(existsSync(join(source, "ash.db-shm")), false, "fixture: the source navi stopped cleanly");
- scripts/test-macos-client.mjs:545  const fromStopped = new DatabaseSync(join(stoppedTarget, "ash.db"), { readOnly: true });
- scripts/test-macos-client.mjs:555  assert.match(result.output, /没有 ash\.db/);
- scripts/test-macos-client.mjs:558  copyFileSync(join(data, "ash.db"), join(inner, "ash.db"));
- scripts/test-macos-client.mjs:558  copyFileSync(join(data, "ash.db"), join(inner, "ash.db"));
- scripts/test-macos-client.mjs:563  assert.match(result.output, /没有 ash\.db/);
- scripts/test-macos-client.mjs:566  const multiDb = new DatabaseSync(join(multi, "ash.db"));
- scripts/test-macos-update.mjs:119  const db = new DatabaseSync(join(data, "ash.db"));
- scripts/test-restart-lock-owner.mjs:70  if (lock) writeFileSync(join(dir, "ash.db.ash.lock"), JSON.stringify({ version: 1, port, cwd: TMP, token: "t", ...lock }));
- scripts/test-restart-lock-owner.mjs:90  NAVI_DB: join(dir, "ash.db"),
- scripts/test-restart.mjs:159  NAVI_DB: join(TMP, "ash.db"),
- scripts/test-stop.mjs:54  NAVI_DB: join(TMP, "ash.db"),
- scripts/win-remote/sync.mjs:250  # 上一次跑测试/构建留下的未跟踪与 ignored 产物(data\ash.db、dist\、*.tsbuildinfo)
- server/drizzle.config.ts:8  url: process.env.NAVI_DB ?? process.env.ASH_DB ?? process.env.HARNESS_DB ?? "./data/ash.db",
- server/scripts/accept-gate-baseline-fixture.ts:15  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/fixtures/git-workbench-server.ts:15  process.env.NAVI_DB = join(directory, "ash.db");
- server/scripts/free-review-dispatch-harness.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/isolated-data.ts:5  // 开的就是这份检出自己的 data/ash.db，写的就是它的 data/。
- server/scripts/isolated-data.ts:15  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/monitors-fixture.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/prerequisite-fixture.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/team-lead-resilience-fixture.ts:25  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-auto-commit.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-cleanup.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-commit-setting.ts:17  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate-borrow.ts:19  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-confine.ts:24  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-identity.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate-links.ts:15  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-pending.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate-plan.ts:9  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-prepare.ts:28  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate-process.ts:31  ? { ...process.env, NAVI_DB: join(directory, "ash.db"), NAVI_RUNS_DIR: join(directory, "runs") } : process.env,
- server/scripts/test-accept-gate-readonly.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate-reclaim.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate-relocate.ts:16  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-runs-inside.ts:15  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-source.ts:11  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-status.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate-supply.ts:27  // 产品模块一加载就开库：不指到临时目录，开的就是这份检出自己的 data/ash.db（在主仓里那是线上的库）。
- server/scripts/test-accept-gate-watch.ts:29  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-gate.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-memory.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-merge.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-accept-pending-merge.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-adopt-replay.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-agent-spawn-late.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-answer-follow-up.ts:20  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-auto-title-run.ts:25  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-base-update-followups.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-base-update-recovery.ts:12  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-branch-acceptance.ts:14  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-branch-plan-creation.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-branch-plan-scale.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-branch-worktree-state.ts:12  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-carved-out-home.ts:24  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-chat-large-workspace.ts:108  process.env.NAVI_DB = join(repoPath, "data", "ash.db");
- server/scripts/test-chat-navi-data.ts:15  process.env.NAVI_DB = join(data, "ash.db");
- server/scripts/test-chat-navi-data.ts:53  join(data, "server.log"), join(data, "ash.db.ash.lock"), join(data, "skill-calibrations.json"),
- server/scripts/test-claude-goal-live.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-claude-monitor-legacy-lifetime.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-claude-monitor-origin.ts:25  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-claude-monitor-wiring.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-claude-reattach-background.ts:22  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-claude-usage-accounting.ts:22  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cleanup-debt.ts:32  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cleanup-ownership.ts:32  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cleanup-pending.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cleanup-write-handoff.ts:34  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-active-goal.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-command-startup.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-command-task.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-commands.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-goal-lifecycle.ts:14  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-goal-queue.ts:14  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-goal-recovery.ts:14  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-models.ts:29  // 于是测试连的是仓库默认的 `data/ash.db`,而 `requireTmpDb` 那道闸只看环境变量,
- server/scripts/test-cli-plan-scheduling.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-cli-state-scopes.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-codex-goal-bridge.ts:14  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-conversation-redact.ts:23  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-data-root.ts:54  assert.equal(whole.db, join(data, "ash.db"));
- server/scripts/test-delivery-receipt.ts:24  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-diagnostic-session-reply.ts:15  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-discussion-delete.ts:19  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-discussion-dispatch.ts:22  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-discussion.ts:26  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-dispatch-hold.ts:36  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-dispatch-plan.ts:33  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-dispatch-suggestion-guards.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-dispatch-suggestion.ts:30  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-dispatched-attention.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-dispute-open-sync.ts:17  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-duet-attachments.ts:58  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-duet-gate-version.ts:27  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-duet-native-trace.ts:12  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-file-browser.ts:20  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-free-preview-review-turn.ts:24  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-anchor.ts:15  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-defer.ts:20  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-dispute-gate.ts:26  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-dispute-target.ts:28  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-dispute.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-reservation.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-rounds.ts:17  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-review-settlement.ts:12  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-workflow-hardening.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-workflow-lifecycle.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-workflow-preview.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-free-workflow.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-git-workbench-maintenance.ts:22  process.env.NAVI_DB = join(directory, "ash.db");
- server/scripts/test-git-workbench-outcomes.ts:22  process.env.NAVI_DB = join(directory, "ash.db");
- server/scripts/test-git-workbench-safety.ts:19  process.env.NAVI_DB = join(directory, "ash.db");
- server/scripts/test-git-workbench.ts:18  process.env.NAVI_DB = join(directory, "ash.db");
- server/scripts/test-goal-native-live.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-handoff-accept-gate.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-handoff-accepted-return.ts:27  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-handoff-free-workflow-rows.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-handoff-notice.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-holder-scan.ts:40  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-host-navi-mcp.ts:45  HOME: home, PATH: `${bin}:/usr/bin:/bin`, NAVI_DATA_DIR: join(home, "data"), NAVI_DB: join(home, "data", "ash.db"),
- server/scripts/test-human-approval.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-im-actor.ts:23  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-cards.ts:22  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-exits.ts:20  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-gates.ts:30  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-inbound.ts:32  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-outcomes.ts:31  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-pairing.ts:22  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-recall.ts:20  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-recovery.ts:22  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-replies.ts:21  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-requests.ts:22  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-review.ts:28  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-settling.ts:20  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-im-wire.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-import-snapshot.ts:73  const file = join(target, "ash.db");
- server/scripts/test-instance-binding.ts:46  HOME: home, PATH: "/usr/bin:/bin", PORT: String(port), NAVI_LOCAL_ONLY: "1", NAVI_DATA_DIR: data, NAVI_DB: join(data, "ash.db"),
- server/scripts/test-kernel-confine.ts:427  process.env.NAVI_DB = join(home, "ash.db");
- server/scripts/test-kill-lineage.ts:40  process.env.NAVI_DB = join(home, "ash.db");
- server/scripts/test-local-open.ts:11  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-mcp-handoff.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-native-command-turn.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-native-upload-visibility.ts:12  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-navi-mcp-inject.ts:32  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-note-task-history.ts:11  const dbFile = join(root, "ash.db");
- server/scripts/test-path-boundary.ts:31  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-pending-after-handoff.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-pending-after.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-pending-wait-normal.ts:12  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-post-merge-review.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-preview-process.ts:17  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-preview-revocation.ts:24  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-preview-stop-notice.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-process-identity.ts:28  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-process-subtrees.ts:25  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-progress-boundary.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-project-clone.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-project-dir.ts:12  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-project-git-config.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-project-git.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-prompt-budget.ts:43  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-protocol-evidence.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-question-history.ts:12  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-question-supersede.ts:17  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-queue-ownership-race.ts:37  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-queue-rank.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-record-identity.ts:25  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-rename-compat.ts:38  const dbFile = join(dataDir, "ash.db");
- server/scripts/test-reopen-acceptance.ts:9  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-repo-lock.ts:11  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-request-timing.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-resume-prompt-broadcast.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-retry-turn-queue.ts:30  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-review-flow.ts:22  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-review-flow.ts:30  // 那时 better-sqlite3 已经把 ash.db 打开了,而 exit 钩子是同步的、`await` 不了
- server/scripts/test-review-image-retention.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-review-recurrence.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-review-recurs-boundary.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-review-resume.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-review-sweep.ts:14  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-run-notices.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-run-trace-retention.ts:12  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-scheduled-messages.ts:31  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-scm-guard.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-scm-nested.ts:26  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-search-experience.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-search-query.ts:7  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-search-scan.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-search-stream.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-seat-ownership.ts:33  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-session-notice.ts:26  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-silence-tier.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-singleton.ts:83  const current = join(root, "ash.db");
- server/scripts/test-singleton.ts:205  const db = join(dir, "ash.db");
- server/scripts/test-startup-receipt.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-steer-refused-reply.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-stop-turn-observation.ts:7  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-system-resume.ts:17  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-actions.ts:29  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-activity.ts:22  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-artifact-scope.ts:22  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-task-artifacts-concurrent.ts:27  process.env.NAVI_DB = join(tmp, "ash.db");
- server/scripts/test-task-artifacts-evidence.ts:21  process.env.NAVI_DB = join(tmp, "ash.db");
- server/scripts/test-task-artifacts.ts:20  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-task-change-scope.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-creation-origin.ts:12  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-delete-atomic.ts:20  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-delete-disk.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-derivation-policy.ts:8  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-direction-epoch-entries.ts:25  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-dispatched-by.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-event-timestamps.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-file-raw.ts:20  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-task-list-body.ts:22  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-memos.ts:14  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-page.ts:24  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-task-reads.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-reply-fork.ts:13  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-steer-hardening.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-steer-rollback.ts:20  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-task-workspace.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-team-accept-crew.ts:21  process.env.NAVI_DB = join(stage, "ash.db");
- server/scripts/test-team-inbound-durability.ts:84  process.env.NAVI_DB = join(dir, "ash.db");
- server/scripts/test-team-native-command.ts:20  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-team-session-notice.ts:22  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-team-silence-tier.ts:27  process.env.NAVI_DB = join(rawStage, "ash.db");
- server/scripts/test-turn-baseline.ts:36  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-end-wake.ts:37  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-freeze.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-output.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-ownership.ts:18  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-reclaim.ts:32  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-release-ownership.ts:29  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-release-restart.ts:30  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-visibility.ts:26  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-turn-wind-down.ts:20  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-undriven-turn.ts:34  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-usage-accounting.ts:25  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-user-cli-write-identity.ts:24  // 要是在这里 `releaseTmpDb()` 反而会把真的 data/ash.db 连上。
- server/scripts/test-verify-override.ts:21  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-workflow-gate.ts:23  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-workflow-library.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-workflow-mode-default.ts:19  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-workflow-run.ts:10  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-workspace-cleanup.ts:16  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-worktree-default.ts:22  const dbFile = join(root, "ash.db");
- server/scripts/test-worktree-leftover.ts:24  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/test-worktree-porcelain.ts:13  process.env.NAVI_DB = join(directory, "ash.db");
- server/scripts/test-worktree-recovery.ts:20  process.env.NAVI_DB = join(root, "ash.db");
- server/scripts/tmp-db.ts:63  if (!named.length) process.env.NAVI_DB = join(root, "ash.db");
- server/src/chat/boundary.ts:82  // 请求都动，还有 ash.db 的 -wal/-shm/.ash.lock、scratch/、task-artifacts/、uploads/、runs/。
- server/src/db/path.ts:26  * 没显式指定库文件时用哪一份：`navi.db` 在就用它，不然是 `ash.db`。**运行时不改库的名字**：
- server/src/db/path.ts:30  *  · 旧版服务只认 `ash.db`。新版一旦改了名，回退到旧版就会对着一份空库起来。
- server/src/db/path.ts:32  * **新安装暂时也建 `ash.db`**：mac 应用（`desktop/macos`）判断数据目录用没用过、升级前给库留底、
- server/src/db/path.ts:33  * 导入数据，都按 `ash.db` 这个名字找 —— 建成 `navi.db` 的话，它每次启动都当这是第一次用，导入的
- server/src/db/path.ts:36  * 更早的 `harness.db` 照旧就地改名成 `ash.db`（那一代没有并存的旧版服务）。
- web/scripts/test-cli-commands-ui.mjs:16  process.env.NAVI_DB = join(root, "ash.db");
- web/scripts/test-cli-goal-lifecycle-ui.mjs:17  process.env.NAVI_DB = join(root, "ash.db");
- web/scripts/test-cli-goal-lifecycle-ui.mjs:119  const connection = new DatabaseSync(join(root, "ash.db"), { readOnly: true });
- web/scripts/test-conversation-identity.ts:34  process.env.NAVI_DB = join(stage, "ash.db");
- web/scripts/test-conversation-mid-turn-notes.ts:24  process.env.NAVI_DB = join(stage, "ash.db");

## compat-file（253 处）

整份讲改名兼容的文件（迁移表、兼容回归）：字面量和注释里的旧名是故意的

- desktop/macos/Sources/LegacyIdentity.swift:4  /// 改名（ash → navi）的接班。Navi.app 的包标识是 dev.navi.mac，macOS 把它当成另一个应用：设置（defaults）、
- desktop/macos/Sources/LegacyIdentity.swift:31  "AshURL": "NaviURL",
- desktop/macos/Sources/LegacyIdentity.swift:32  "AshDataDir": "NaviDataDir",
- desktop/macos/Sources/LegacyIdentity.swift:33  "NSWindow Frame AshMainWindow": "NSWindow Frame NaviMainWindow",
- desktop/macos/Sources/LegacyIdentity.swift:36  static let pinnedSupportKey = "DataRootFromAsh"
- desktop/macos/Sources/LegacyIdentity.swift:37  private static let adoptedDefaultsKey = "AdoptedAshDefaults"
- desktop/macos/Sources/LegacyIdentity.swift:38  private static let adoptedWebDataKey = "AdoptedAshWebData"
- desktop/macos/Sources/LegacyIdentity.swift:45  /// 环境变量的旧前缀：改名前的启动配置（`ASH_URL`、`ASH_DATA_DIR` 这类，构建测试用的那几个口子也一样）照样认。
- desktop/macos/Sources/LegacyIdentity.swift:45  /// 环境变量的旧前缀：改名前的启动配置（`ASH_URL`、`ASH_DATA_DIR` 这类，构建测试用的那几个口子也一样）照样认。
- desktop/macos/Sources/LegacyIdentity.swift:47  static let envPrefix = "ASH_"
- desktop/macos/Sources/LegacyIdentity.swift:189  throw AdoptionError(errorDescription: "另一份 Navi 正在接 Ash 的网页数据，等了 \(Int(timeout)) 秒还没接完。等它接完再点「重试」，或者先把那一份退出。")
- desktop/macos/Sources/LegacyIdentity.swift:242  return "Ash 还开着（可能在等你确认装更新，或者在等手上的任务停下来）。先把 Ash 退出，再点「重试」。"
- desktop/macos/Sources/LegacyIdentity.swift:242  return "Ash 还开着（可能在等你确认装更新，或者在等手上的任务停下来）。先把 Ash 退出，再点「重试」。"
- desktop/macos/Sources/LegacyIdentity.swift:283  /// 旧的登录项（指着 Ash.app 里的 `Contents/MacOS/Ash`）。
- desktop/macos/Sources/LegacyIdentity.swift:290  private static let loginChoiceKey = "LoginItemChoiceAfterAsh"
- desktop/macos/Sources/LegacyIdentity.swift:313  /// 旧登录项还在（= 用户在 Ash 里开着）就换成自己的：**先把自己的装好、确认生效，再卸旧的**。反过来的话，新的那条
- desktop/macos/Sources/LegacyIdentity.swift:315  /// 都原样留着，旧的 plist 在就是「还没换」：旧包也就不让位（`retire` 认它），旧登录项指着的 Ash 可执行文件一直在，
- desktop/macos/Sources/LegacyIdentity.swift:388  /// 「没人在用」还得包括**登记在外面、以后才会跑的**：旧登录项写死的是 `Ash.app/Contents/MacOS/Ash`，留下的
- desktop/macos/Sources/LegacyIdentity.swift:403  return .busy("旧的登录项 \(loginItem.path) 还没换成 Navi 的，它跑的是旧包里的 Ash 可执行文件")
- desktop/macos/Tests/Identity/main.swift:29  "AshURL": "http://192.168.1.187:4317",
- desktop/macos/Tests/Identity/main.swift:30  "AshDataDir": "/Volumes/data/navi",
- desktop/macos/Tests/Identity/main.swift:31  "NSWindow Frame AshMainWindow": "0 0 1455 949 0 0 1512 949 ",
- desktop/macos/Tests/Identity/main.swift:40  require(defaults.string(forKey: "NaviURL") == "http://192.168.1.187:4317", "AshURL → NaviURL")
- desktop/macos/Tests/Identity/main.swift:41  require(defaults.string(forKey: "NaviDataDir") == "/Volumes/data/navi", "AshDataDir → NaviDataDir")
- desktop/macos/Tests/Identity/main.swift:43  require(defaults.object(forKey: "AshURL") == nil, "renamed keys are not copied under their old names")
- desktop/macos/Tests/Identity/main.swift:47  require(LegacyIdentity.adoptDefaults(["AshURL": "http://elsewhere:4317", "Late": 1], into: defaults).isEmpty, "adopted only once")
- desktop/macos/Tests/Identity/main.swift:67  require(pick() == legacy, "upgraded machine → keep using the Ash data root in place")
- desktop/macos/Tests/Identity/main.swift:124  require(busy?.contains("Ash 还开着") == true, "old app still running → blocked: \(busy ?? "nil")")
- desktop/macos/release.json:2  "//": "发版配置，见 desktop/macos/README.md「发版」。安装包（dmg，人下载和 Sparkle 更新都用它）是 releaseRepo 里 tag 为 <tagPrefix><版本>-<构建号> 的 Release 附件；appcast 在 feedRepo 的 feedBranch 上的
- desktop/macos/release.json:8  "legacyAppcastPath": "ash/mac/appcast.xml",
- desktop/macos/scripts/appcast.mjs:86  // xmlns:ash 是兼容声明：改名前发的条目原样带过来时里面是 <ash:commit>，前缀没声明整份 XML 就解析不了。
- desktop/macos/scripts/appcast.mjs:86  // xmlns:ash 是兼容声明：改名前发的条目原样带过来时里面是 <ash:commit>，前缀没声明整份 XML 就解析不了。
- desktop/macos/scripts/appcast.mjs:87  `<rss version="2.0" xmlns:sparkle="${SPARKLE_NS}" xmlns:navi="https://github.com/noroot777/navi" xmlns:ash="https://github.com/noroot777/ash">`,
- desktop/macos/scripts/appcast.mjs:98  /** 上一版是从哪个提交出的（写在 <navi:commit> 里；改名前的条目写的是 <ash:commit>），给这一版的更新说明划范围。 */
- desktop/macos/scripts/appcast.mjs:100  return items[0]?.xml.match(/<(navi|ash):commit>\s*([0-9a-f]{7,40})\s*<\/\1:commit>/)?.[2] ?? null;
- mobile/scripts/test-stored-keys.mjs:1  // 手机端本机存储改名：服务器地址、key 从 ash.* / harness.* 挪到 navi.*。跑：cd mobile && npm run test:stored-keys
- mobile/scripts/test-stored-keys.mjs:3  // 两代旧名（harness → ash）按顺序都认；挪或删失败时读到的值照样返回、不拖住启动，旧键留着下次再挪；
- mobile/scripts/test-stored-keys.mjs:23  const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" });
- mobile/scripts/test-stored-keys.mjs:23  const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" });
- mobile/scripts/test-stored-keys.mjs:23  const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" });
- mobile/scripts/test-stored-keys.mjs:25  assert.equal(await readStoredKey(store, STORED_KEYS.apiKey), "ash_secret");
- mobile/scripts/test-stored-keys.mjs:26  assert.deepEqual(Object.fromEntries(store.map), { "navi.baseURL": "http://192.168.1.5:4317", "navi.apiKey": "ash_secret" });
- mobile/scripts/test-stored-keys.mjs:36  const store = memory({ "navi.baseURL": "http://new:4317", "ash.baseURL": "http://stale:4317", "harness.baseURL": "http://older:4317" });
- mobile/scripts/test-stored-keys.mjs:42  const store = memory({ "ash.baseURL": "http://ash:4317", "harness.baseURL": "http://harness:4317" });
- mobile/scripts/test-stored-keys.mjs:42  const store = memory({ "ash.baseURL": "http://ash:4317", "harness.baseURL": "http://harness:4317" });
- mobile/scripts/test-stored-keys.mjs:43  assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://ash:4317", "两代都在时取较新的 ash 那一份");
- mobile/scripts/test-stored-keys.mjs:43  assert.equal(await readStoredKey(store, STORED_KEYS.baseURL), "http://ash:4317", "两代都在时取较新的 ash 那一份");
- mobile/scripts/test-stored-keys.mjs:44  assert.deepEqual(Object.fromEntries(store.map), { "navi.baseURL": "http://ash:4317" });
- mobile/scripts/test-stored-keys.mjs:58  const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, { set: true, remove: false });
- mobile/scripts/test-stored-keys.mjs:58  const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, { set: true, remove: false });
- mobile/scripts/test-stored-keys.mjs:58  const store = memory({ "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, { set: true, remove: false });
- mobile/scripts/test-stored-keys.mjs:60  assert.equal(await readStoredKey(store, STORED_KEYS.apiKey), "ash_secret");
- mobile/scripts/test-stored-keys.mjs:61  assert.deepEqual(Object.fromEntries(store.map), { "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, "没挪成就不删旧键");
- mobile/scripts/test-stored-keys.mjs:61  assert.deepEqual(Object.fromEntries(store.map), { "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, "没挪成就不删旧键");
- mobile/scripts/test-stored-keys.mjs:61  assert.deepEqual(Object.fromEntries(store.map), { "ash.baseURL": "http://192.168.1.5:4317", "ash.apiKey": "ash_secret" }, "没挪成就不删旧键");
- mobile/scripts/test-stored-keys.mjs:64  assert.deepEqual(Object.fromEntries(store.map), { "ash.apiKey": "ash_secret", "navi.baseURL": "http://192.168.1.5:4317" }, "下次启动挪完");
- mobile/scripts/test-stored-keys.mjs:64  assert.deepEqual(Object.fromEntries(store.map), { "ash.apiKey": "ash_secret", "navi.baseURL": "http://192.168.1.5:4317" }, "下次启动挪完");
- mobile/scripts/test-stored-keys.mjs:66  const stuck = memory({ "navi.apiKey": "navi_key", "ash.apiKey": "stale" }, { set: false, remove: true });
- mobile/scripts/test-stored-keys.mjs:68  assert.equal(stuck.map.get("ash.apiKey"), "stale", "留着下次再删");
- mobile/scripts/test-stored-keys.mjs:78  assert.doesNotMatch(config, /"(ash|harness)\.(baseURL|apiKey)"/, "旧键名只留在 storedKeys.ts");
- mobile/scripts/test-stored-keys.mjs:82  console.log("PASS stored keys: server address and key move from ash.* / harness.* to navi.*, and a failed move never blocks startup");
- mobile/src/lib/storedKeys.ts:1  // 手机端本机存储（AsyncStorage）里的键。项目改过两次名（harness → ash → navi），老版本存下的
- mobile/src/lib/storedKeys.ts:5  // 注意它管不到的那一种：Expo Go 按 app.json 的 slug 给每个应用分一块存储，slug 从 ash 换成 navi
- mobile/src/lib/storedKeys.ts:8  baseURL: { current: "navi.baseURL", legacy: ["ash.baseURL", "harness.baseURL"] },
- mobile/src/lib/storedKeys.ts:9  apiKey: { current: "navi.apiKey", legacy: ["ash.apiKey"] },
- scripts/check-brand-text.mjs:1  // 界面上看得见的产品名残留：改名 Navi 之后，旧名 ash 不论大小写（ash / Ash / ASH）都不该再出现在
- scripts/check-brand-text.mjs:1  // 界面上看得见的产品名残留：改名 Navi 之后，旧名 ash 不论大小写（ash / Ash / ASH）都不该再出现在
- scripts/check-brand-text.mjs:1  // 界面上看得见的产品名残留：改名 Navi 之后，旧名 ash 不论大小写（ash / Ash / ASH）都不该再出现在
- scripts/check-brand-text.mjs:1  // 界面上看得见的产品名残留：改名 Navi 之后，旧名 ash 不论大小写（ash / Ash / ASH）都不该再出现在
- scripts/check-brand-text.mjs:6  // 仍然叫 ash 的标识符照常放行，判据是它贴着标识符记号：`ash-accepted`、`ash/<id8>`、`[ash]` 日志前缀、
- scripts/check-brand-text.mjs:6  // 仍然叫 ash 的标识符照常放行，判据是它贴着标识符记号：`ash-accepted`、`ash/<id8>`、`[ash]` 日志前缀、
- scripts/check-brand-text.mjs:6  // 仍然叫 ash 的标识符照常放行，判据是它贴着标识符记号：`ash-accepted`、`ash/<id8>`、`[ash]` 日志前缀、
- scripts/check-brand-text.mjs:6  // 仍然叫 ash 的标识符照常放行，判据是它贴着标识符记号：`ash-accepted`、`ash/<id8>`、`[ash]` 日志前缀、
- scripts/check-brand-text.mjs:7  // `~/ash-workspaces`、`mcp__ash__`、`"ash"` 这类，以及整串就是一个标识符的字面量（`kind === "ash"`）。
- scripts/check-brand-text.mjs:7  // `~/ash-workspaces`、`mcp__ash__`、`"ash"` 这类，以及整串就是一个标识符的字面量（`kind === "ash"`）。
- scripts/check-brand-text.mjs:7  // `~/ash-workspaces`、`mcp__ash__`、`"ash"` 这类，以及整串就是一个标识符的字面量（`kind === "ash"`）。
- scripts/check-brand-text.mjs:13  const BRAND = /(?<![\w\-./@[$\\~#%'"`])(?:ash|Ash|ASH)(?![\w\-/@\]=%'"`]|[.:][\w/])/;
- scripts/check-brand-text.mjs:13  const BRAND = /(?<![\w\-./@[$\\~#%'"`])(?:ash|Ash|ASH)(?![\w\-/@\]=%'"`]|[.:][\w/])/;
- scripts/check-brand-text.mjs:13  const BRAND = /(?<![\w\-./@[$\\~#%'"`])(?:ash|Ash|ASH)(?![\w\-/@\]=%'"`]|[.:][\w/])/;
- scripts/test-macos-identity.mjs:4  // 覆盖：设置——旧域每一项抄进新域、改了名的键（AshURL / AshDataDir / 窗口位置）换成新名、新域已有的不盖、只接一次；
- scripts/test-macos-identity.mjs:4  // 覆盖：设置——旧域每一项抄进新域、改了名的键（AshURL / AshDataDir / 窗口位置）换成新名、新域已有的不盖、只接一次；
- scripts/test-macos-identity.mjs:61  <key>CFBundleExecutable</key><string>Ash</string>
- scripts/test-macos-identity.mjs:91  console.log("PASS: data root — new place on a fresh machine, the Ash one in place (and pinned) on an upgraded machine, rehearsal ids never adopt it");
- scripts/test-macos-identity.mjs:182  const other = fakeBundle(join(temporary, "elsewhere", "Ash.app"), "com.example.ash");
- scripts/test-macos-identity.mjs:209  // 旧登录项还没换成 Navi 的：它写死的是旧包里的 MacOS/Ash，留下的软链那头只有 MacOS/Navi —— 不让位。
- scripts/test-macos-identity.mjs:237  assert.match(outcome, /^BUSY .*Ash\.app/, outcome);
- scripts/test-macos-identity.mjs:261  const ids = { old: `dev.ash.identity-probe.${process.pid}`, next: `dev.navi.identity-probe.${process.pid}`, stranger: `dev.navi.identity-stranger.${process.pid}
- scripts/test-macos-release.mjs:35  const temporary = mkdtempSync(join(tmpdir(), "ash-macos-release-"));
- scripts/test-macos-release.mjs:203  assert.match(legacy(), /xmlns:ash="https:\/\/github\.com\/noroot777\/ash"/, "pre-rename <ash:commit> items carried along still parse");
- scripts/test-macos-release.mjs:203  assert.match(legacy(), /xmlns:ash="https:\/\/github\.com\/noroot777\/ash"/, "pre-rename <ash:commit> items carried along still parse");
- scripts/test-macos-release.mjs:203  assert.match(legacy(), /xmlns:ash="https:\/\/github\.com\/noroot777\/ash"/, "pre-rename <ash:commit> items carried along still parse");
- scripts/test-macos-release.mjs:380  legacyAppcastPath: "ash/mac/appcast.xml", tagPrefix: "navi-mac-v", keychainAccount: "unused", publicKey: key.publicKey };
- scripts/test-macos-release.mjs:444  assert.deepEqual(writes(github), ["PUT /repos/o/feed/contents/navi/mac/appcast.xml", "PUT /repos/o/feed/contents/ash/mac/appcast.xml"],
- scripts/test-macos-release.mjs:468  "PUT /repos/o/feed/contents/navi/mac/appcast.xml", "PUT /repos/o/feed/contents/ash/mac/appcast.xml"],
- scripts/test-macos-release.mjs:489  const notice = github.state.files.get("o/feed:ash/mac/appcast.xml");
- scripts/test-macos-release.mjs:518  assert.match(github.state.files.get("o/feed:ash/mac/appcast.xml").text, /<sparkle:version>20000102\.0003<\/sparkle:version>/, "the notice moves on to the newer 
- scripts/test-macos-sparkle-dmg.mjs:9  // 改名（Ash.app / dev.ash.* → Navi.app / dev.navi.*）：改名前的 Ash.app 拿到 Navi 的包也装不上（Sparkle 只认同名或
- scripts/test-macos-sparkle-dmg.mjs:25  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ash-sparkle-dmg-")));
- scripts/test-macos-sparkle-dmg.mjs:27  const legacyId = `dev.ash.sparkle-dmg-probe.${process.pid}`;
- scripts/test-macos-sparkle-dmg.mjs:176  const ash = makeApp(join(temporary, "Applications-ash"), "20000101.0001", { check: true, name: "Ash", id: legacyId });
- scripts/test-macos-sparkle-dmg.mjs:176  const ash = makeApp(join(temporary, "Applications-ash"), "20000101.0001", { check: true, name: "Ash", id: legacyId });
- scripts/test-macos-sparkle-dmg.mjs:176  const ash = makeApp(join(temporary, "Applications-ash"), "20000101.0001", { check: true, name: "Ash", id: legacyId });
- scripts/test-macos-sparkle-dmg.mjs:177  result = await runOnce(ash, good, { until: /^ERROR / });
- scripts/test-macos-sparkle-dmg.mjs:180  assert.equal(versionOf(ash), "20000101.0001", "Ash.app is left exactly as it was");
- scripts/test-macos-sparkle-dmg.mjs:181  assert.ok(!existsSync(join(temporary, "Applications-ash", "Navi.app")), "and no Navi.app appears next to it");
- scripts/test-macos-sparkle-dmg.mjs:185  const notified = makeApp(join(temporary, "Applications-ash-2"), "20000101.0001", {
- scripts/test-macos-sparkle-dmg.mjs:186  check: true, name: "Ash", id: legacyId, feed: feedURL.replace(/appcast\.xml$/, "legacy-appcast.xml"),
- server/scripts/test-rename-compat.ts:5  //   ③ MCP 登记名 / 工具名:navi、ash、harness 三代都认;
- server/scripts/test-rename-compat.ts:6  //   ④ 任务分支:新建写 navi/,已有的 ash/、harness/ 分支照旧找得到;
- server/scripts/test-rename-compat.ts:71  assert.deepEqual(envNameGenerations("NAVI_DB"), ["NAVI_DB", "ASH_DB", "HARNESS_DB"]);
- server/scripts/test-rename-compat.ts:73  assert.equal(read({ ASH_URL: "a" }, "NAVI_URL"), "a", "改名之前的启动命令写的是 ASH_*");
- server/scripts/test-rename-compat.ts:73  assert.equal(read({ ASH_URL: "a" }, "NAVI_URL"), "a", "改名之前的启动命令写的是 ASH_*");
- server/scripts/test-rename-compat.ts:75  assert.equal(read({ NAVI_URL: "n", ASH_URL: "a", HARNESS_URL: "h" }, "NAVI_URL"), "n", "新名优先");
- server/scripts/test-rename-compat.ts:76  assert.equal(read({ NAVI_URL: "", ASH_URL: "a" }, "NAVI_URL"), "", "显式设成空串也算设了");
- server/scripts/test-rename-compat.ts:79  const env: Record<string, string | undefined> = { NAVI_TASK_ID: "n", ash_task_id: "a", Harness_Task_Id: "h", OTHER: "x" };
- server/scripts/test-rename-compat.ts:83  const child: Record<string, string | undefined> = { ASH_DB: "/old", HARNESS_DB: "/older" };
- server/scripts/test-rename-compat.ts:87  { NAVI_PREVIEW_BASE: "/p/", ASH_PREVIEW_BASE: "/p/", PORT: "1" }, "给用户命令的那几个带一份上一代旧名");
- server/scripts/test-rename-compat.ts:89  assert.equal(read({ ASH_DB: "/tmp/x.db" }, "NAVI_DB"), "/tmp/x.db");
- server/scripts/test-rename-compat.ts:90  assert.equal(read({ NAVI_DB: "/tmp/x.db", ASH_DB: " /tmp/x.db " }, "NAVI_DB"), "/tmp/x.db", "几代指向同一处不算冲突");
- server/scripts/test-rename-compat.ts:91  assert.equal(read({ NAVI_DB: "  ", ASH_DB: "/tmp/x.db" }, "NAVI_DB"), "/tmp/x.db", "空串当没设,不顶掉旧名");
- server/scripts/test-rename-compat.ts:93  assert.throws(() => read({ NAVI_DB: "/data/preview.db", ASH_DB: "/tmp/x.db" }, "NAVI_DB"),
- server/scripts/test-rename-compat.ts:94  /NAVI_DB=\/data\/preview\.db 和 ASH_DB=\/tmp\/x\.db 同时设了/);
- server/scripts/test-rename-compat.ts:102  for (const name of ["navi", "ash", "harness"]) {
- server/scripts/test-rename-compat.ts:109  console.log("✓ MCP:登记名与工具名 navi / ash / harness 三代都认");
- server/scripts/test-rename-compat.ts:116  assert.deepEqual(taskBranchNames(id), ["navi/Ab3dEf9h", "ash/Ab3dEf9h", "harness/Ab3dEf9h"]);
- server/scripts/test-rename-compat.ts:117  for (const prefix of ["navi/", "ash/", "harness/"]) {
- server/scripts/test-rename-compat.ts:128  for (const old of ["harness/Ab3dEf9h", "ash/Ab3dEf9h"]) {
- server/scripts/test-rename-compat.ts:134  console.log("✓ 任务分支:新建写 navi/,已有的 ash/、harness/ 分支照旧找得到");
- server/scripts/test-rename-compat.ts:144  git(repo, "checkout", "-q", "-b", "ash/Tg7hJk2m");
- server/scripts/test-rename-compat.ts:154  assert.match(seen.result.ok ? "" : seen.result.message ?? "", /ash-accepted\/Tg7hJk2m/, "说清是哪个标签");
- server/scripts/test-rename-compat.ts:159  git(repo, "tag", "navi-accepted/Tg7hJk2m", "ash/Tg7hJk2m");
- server/scripts/test-rename-compat.ts:163  seen = await accept((repo) => git(repo, "tag", "ash-accepted/Tg7hJk2m", "ash/Tg7hJk2m"));
- server/scripts/test-rename-compat.ts:177  const inherited = () => ({ PATH: "/bin", ASH_MONITOR_UNIT: "old-unit", HARNESS_MONITOR_UNIT: "older-unit" });
- server/scripts/test-rename-compat.ts:198  assert.equal(env[`ASH_${name}`], value, `ASH_${name}:旧名同值一份`);
- server/scripts/test-rename-compat.ts:198  assert.equal(env[`ASH_${name}`], value, `ASH_${name}:旧名同值一份`);
- server/scripts/test-rename-compat.ts:202  for (const key of ["NAVI_TASK_ID", "ASH_TASK_ID", "HARNESS_TASK_ID"]) assert.equal(cleared[key], undefined, `${key}:非任务回合三代都清`);
- server/scripts/test-rename-compat.ts:211  block: '[mcp_servers.ash]\ncommand = "node"\nargs = ["/old/mcp/dist/index.js"]\n' } as Parameters<typeof relocateHostFact>[0], to);
- server/scripts/test-rename-compat.ts:213  console.log("✓ 搬登记:旧表头 [mcp_servers.ash] 照样按它自己的表换入口");
- server/scripts/test-rename-compat.ts:248  assert.ok(canStopMonitor("ash"));
- server/scripts/test-rename-compat.ts:279  assert.equal(SYNTHETIC_COMMIT_IDENTITY_ENV.GIT_AUTHOR_NAME, "ash");
- server/scripts/test-rename-compat.ts:333  assert.ok(!/[^A-Za-z]ash_|\.ash[_.-]/.test(wrapper), "包装壳里不该再有旧名");
- server/scripts/test-rename-compat.ts:333  assert.ok(!/[^A-Za-z]ash_|\.ash[_.-]/.test(wrapper), "包装壳里不该再有旧名");
- server/scripts/test-rename-compat.ts:356  assert.ok(!listed.some((name) => /^\.ash/.test(name)), `不再建旧名临时文件:${listed}`);
- server/scripts/test-rename-compat.ts:419  assert.ok(isHandoffService("ash") && isHandoffService("navi") && !isHandoffService("other"), "ping 应答新旧两代都认");
- server/scripts/test-rename-compat.ts:420  assert.ok(hasHandoffTrustedMark({ ash: true }) && hasHandoffTrustedMark({ navi: true }) && !hasHandoffTrustedMark({}));
- server/scripts/test-rename-compat.ts:421  assert.deepEqual({ ...HANDOFF_TRUSTED_MARK }, { navi: true, ash: true }, "发出去的错误标记两代各一份,旧版只认 ash");
- server/scripts/test-rename-compat.ts:421  assert.deepEqual({ ...HANDOFF_TRUSTED_MARK }, { navi: true, ash: true }, "发出去的错误标记两代各一份,旧版只认 ash");
- server/scripts/test-rename-compat.ts:422  assert.deepEqual(withLegacyHeaderNames({ "x-navi-peer-key": "k" }), { "x-navi-peer-key": "k", "x-ash-peer-key": "k" });
- server/scripts/test-rename-compat.ts:423  assert.equal(readHeader((name) => ({ "x-ash-peer-key": "old" } as Record<string, string>)[name], "x-navi-peer-key"), "old",
- server/scripts/test-rename-compat.ts:425  assert.ok(isNaviHeaderName("X-Ash-Turn-Token") && isNaviHeaderName("x-navi-turn-token") && !isNaviHeaderName("x-other"));
- server/scripts/test-rename-compat.ts:435  git(repo, "branch", "ash/HandOff1");
- server/scripts/test-rename-compat.ts:436  assert.equal(await legacyPeerBranchRefusal({}, task, repo), null, "升级之前的 ash/ 分支旧版认得,照常放行");
- server/scripts/test-rename-compat.ts:447  writeFileSync(file, `[mcp_servers.ash]\ncommand = "node"\n[other]\nk = 1\n`);
- server/scripts/test-rename-compat.ts:449  { ok: true, servers: [{ name: "ash", enabled: true }] },
- server/scripts/test-rename-compat.ts:459  assert.equal(result.action, "migrated", "用户配置里旧版 setup 登记的 ash ⇒ 迁成 navi");
- server/scripts/test-rename-compat.ts:462  assert.doesNotMatch(migrated, /\[mcp_servers\.ash\]/, "旧名那条不留:注入用的是新名,留着就是两份同样的工具");
- server/scripts/test-rename-compat.ts:470  console.log("✓ setup 把 codex 里旧名 ash 的登记迁成 navi;真执行器开关三代名字都拦");
- server/scripts/test-user-cli-mcp.ts:1  // 个人 CLI 配置目录里的 ash MCP 登记(`auth/user-cli-mcp.ts`)的回归测试。
- server/scripts/test-user-cli-mcp.ts:4  // 提交了的任务,最后一步 `mcp__ash__complete_task` 撞回 "No such tool available",
- server/scripts/test-user-cli-mcp.ts:5  // 按完成协议记 failed —— 因为 `CLAUDE_CONFIG_DIR` 整个取代了 `~/.claude`,而装 ash 时
- server/scripts/test-user-cli-mcp.ts:25  // 改名之前的登记名：宿主机上旧版 setup 写的是 `ash`（再早是 `harness`）。已有这条就不再补；搬进个人目录、
- server/scripts/test-user-cli-mcp.ts:27  const [ASH, HARNESS] = LEGACY_MCP_SERVER_NAMES;
- server/scripts/test-user-cli-mcp.ts:32  // 按这份 ash 现拼,那一条钉在 test-data-root.ts。这里钉的是「用户的写法原样搬」。
- server/scripts/test-user-cli-mcp.ts:35  ash: { type: "stdio", command: "node", args: ["/opt/ash/custom/ash-mcp.js"], env: { ASH_URL: "http://localhost:4317" } },
- server/scripts/test-user-cli-mcp.ts:35  ash: { type: "stdio", command: "node", args: ["/opt/ash/custom/ash-mcp.js"], env: { ASH_URL: "http://localhost:4317" } },
- server/scripts/test-user-cli-mcp.ts:35  ash: { type: "stdio", command: "node", args: ["/opt/ash/custom/ash-mcp.js"], env: { ASH_URL: "http://localhost:4317" } },
- server/scripts/test-user-cli-mcp.ts:35  ash: { type: "stdio", command: "node", args: ["/opt/ash/custom/ash-mcp.js"], env: { ASH_URL: "http://localhost:4317" } },
- server/scripts/test-user-cli-mcp.ts:49  assert.deepEqual(doc.mcpServers[NAME].args, ["/opt/ash/custom/ash-mcp.js"], "定义要照搬宿主那条，名字落成当前名");
- server/scripts/test-user-cli-mcp.ts:49  assert.deepEqual(doc.mcpServers[NAME].args, ["/opt/ash/custom/ash-mcp.js"], "定义要照搬宿主那条，名字落成当前名");
- server/scripts/test-user-cli-mcp.ts:50  assert.ok(!doc.mcpServers.kb, "只搬 ash 这一条,宿主的第三方 server 不许跟着过来");
- server/scripts/test-user-cli-mcp.ts:112  // ⑧ codex:整段 [mcp_servers.ash] 连子表一起搬,后面无关的表不许跟着过来。
- server/scripts/test-user-cli-mcp.ts:115  `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/ash/custom/ash-mcp.js"]\n\n` +
- server/scripts/test-user-cli-mcp.ts:115  `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/ash/custom/ash-mcp.js"]\n\n` +
- server/scripts/test-user-cli-mcp.ts:115  `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/ash/custom/ash-mcp.js"]\n\n` +
- server/scripts/test-user-cli-mcp.ts:116  `[mcp_servers.ash.env]\nASH_URL = "http://localhost:4317"\n\n` +
- server/scripts/test-user-cli-mcp.ts:116  `[mcp_servers.ash.env]\nASH_URL = "http://localhost:4317"\n\n` +
- server/scripts/test-user-cli-mcp.ts:117  `[projects."/opt/ash"]\ntrust_level = "trusted"\n`;
- server/scripts/test-user-cli-mcp.ts:138  const { host, dir } = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
- server/scripts/test-user-cli-mcp.ts:148  const config = `[mcp_servers.ash]\ncommand = "node"\n\n[[hooks]]\nrun = "x"\n`;
- server/scripts/test-user-cli-mcp.ts:149  const block = extractTomlTables(config, ASH);
- server/scripts/test-user-cli-mcp.ts:156  const quoted = `[mcp_servers."ash"]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers."ash".env]\nASH_URL = "u"\n`;
- server/scripts/test-user-cli-mcp.ts:156  const quoted = `[mcp_servers."ash"]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers."ash".env]\nASH_URL = "u"\n`;
- server/scripts/test-user-cli-mcp.ts:156  const quoted = `[mcp_servers."ash"]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers."ash".env]\nASH_URL = "u"\n`;
- server/scripts/test-user-cli-mcp.ts:158  extractTomlTables(quoted, ASH),
- server/scripts/test-user-cli-mcp.ts:159  `[mcp_servers.ash]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers.ash.env]\nASH_URL = "u"`,
- server/scripts/test-user-cli-mcp.ts:159  `[mcp_servers.ash]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers.ash.env]\nASH_URL = "u"`,
- server/scripts/test-user-cli-mcp.ts:159  `[mcp_servers.ash]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers.ash.env]\nASH_URL = "u"`,
- server/scripts/test-user-cli-mcp.ts:162  const commented = `[mcp_servers.ash]\ncommand = "node"\n[mcp_servers.secret] # 别人的\ncommand = "s"\ntoken = "t"\n`;
- server/scripts/test-user-cli-mcp.ts:163  const block = extractTomlTables(commented, ASH);
- server/scripts/test-user-cli-mcp.ts:171  extractTomlTables(`[mcp_servers]\nash.command = "node"\n[mcp_servers.ash.env]\nASH_URL = "u"\n`, ASH),
- server/scripts/test-user-cli-mcp.ts:171  extractTomlTables(`[mcp_servers]\nash.command = "node"\n[mcp_servers.ash.env]\nASH_URL = "u"\n`, ASH),
- server/scripts/test-user-cli-mcp.ts:171  extractTomlTables(`[mcp_servers]\nash.command = "node"\n[mcp_servers.ash.env]\nASH_URL = "u"\n`, ASH),
- server/scripts/test-user-cli-mcp.ts:171  extractTomlTables(`[mcp_servers]\nash.command = "node"\n[mcp_servers.ash.env]\nASH_URL = "u"\n`, ASH),
- server/scripts/test-user-cli-mcp.ts:175  extractTomlTables(`note = """\n[mcp_servers.ash]\ncommand = "x"\n"""\n`, ASH),
- server/scripts/test-user-cli-mcp.ts:175  extractTomlTables(`note = """\n[mcp_servers.ash]\ncommand = "x"\n"""\n`, ASH),
- server/scripts/test-user-cli-mcp.ts:182  assert.ok(written.includes(`args = ["/h.js"]`) && written.includes(`ASH_URL = "u"`), "照搬宿主那份");
- server/scripts/test-user-cli-mcp.ts:191  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { ash: {} } }), "utf8");
- server/scripts/test-user-cli-mcp.ts:192  assert.equal(readNaviMcp(dir, "claude").serverName, ASH, "旧名登记也认得出");
- server/scripts/test-user-cli-mcp.ts:197  const { host } = bench({ claude: HOST_CLAUDE, codex: `[mcp_servers.ash]\ncommand = "node"\n` });
- server/scripts/test-user-cli-mcp.ts:209  // 个人目录里**不再补** ash MCP 登记:有个人目录的 claude / codex 起跑时由 ash 注入自己的 MCP
- server/scripts/test-user-cli-mcp.ts:209  // 个人目录里**不再补** ash MCP 登记:有个人目录的 claude / codex 起跑时由 ash 注入自己的 MCP
- server/scripts/test-user-cli-mcp.ts:236  assert.equal(readNaviMcp(claudeDir, "claude").configured, false, "切档不往个人目录里写 ash MCP 登记");
- server/scripts/test-user-cli-mcp.ts:248  const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
- server/scripts/test-user-cli-mcp.ts:250  `[mcp_servers."ash"]\ncommand = "node"\n`,
- server/scripts/test-user-cli-mcp.ts:251  `  [mcp_servers.ash]\ncommand = "node"\n`,
- server/scripts/test-user-cli-mcp.ts:252  `[mcp_servers]\nash = { command = "node" }\n`,
- server/scripts/test-user-cli-mcp.ts:262  const off = `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n`;
- server/scripts/test-user-cli-mcp.ts:272  const odd = `notes = """\n[mcp_servers.ash]\n"""\n`;
- server/scripts/test-user-cli-mcp.ts:285  const { host, dir } = bench({ claude: HOST_CLAUDE, codex: `[mcp_servers.ash]\ncommand = "node"\n` });
- web/scripts/test-storage-rename.mjs:1  // 改名之后的本机存储：老版本页面挂在 ash: / ash. / harness-next: 下的键，一启动就整批挪到 navi 前缀，
- web/scripts/test-storage-rename.mjs:1  // 改名之后的本机存储：老版本页面挂在 ash: / ash. / harness-next: 下的键，一启动就整批挪到 navi 前缀，
- web/scripts/test-storage-rename.mjs:2  // 之后各处只认新键。钉住：三种旧前缀都挪、值原样带过去；同一个新键有好几代旧值时按代数定胜负（新键 > ash >
- web/scripts/test-storage-rename.mjs:37  "ash:sidebar-width": "312",
- web/scripts/test-storage-rename.mjs:38  "ash:inspector:task:abc": JSON.stringify({ openTabs: ["files"] }),
- web/scripts/test-storage-rename.mjs:39  "ash.colorTheme": "dark",
- web/scripts/test-storage-rename.mjs:40  "ash.annotation-batch.t1": "[1,2]",
- web/scripts/test-storage-rename.mjs:61  const storage = new MemoryStorage({ "ash:diff-layout": "unified", "navi:diff-layout": "split", "harness-next:diff-layout": "unified" });
- web/scripts/test-storage-rename.mjs:66  // 两代旧值同在：浏览器先枚举到更早的 harness-next 那份也不算数，ash 那份更新。
- web/scripts/test-storage-rename.mjs:68  const entries = { "harness-next:sidebar-width": "240", "ash:sidebar-width": "420", "harness-next:sidebar-collapsed": "1", "ash:sidebar-collapsed": "0" };
- web/scripts/test-storage-rename.mjs:68  const entries = { "harness-next:sidebar-width": "240", "ash:sidebar-width": "420", "harness-next:sidebar-collapsed": "1", "ash:sidebar-collapsed": "0" };
- web/scripts/test-storage-rename.mjs:78  const roomy = new MemoryStorage({ "ash:assistant-draft:r1": draft });
- web/scripts/test-storage-rename.mjs:83  const tight = new MemoryStorage({ "ash:assistant-draft:r1": draft });
- web/scripts/test-storage-rename.mjs:85  assert.deepEqual(renameLegacyStorageKeys(tight).stuck, [{ key: "navi:assistant-draft:r1", legacyKey: "ash:assistant-draft:r1" }]);
- web/scripts/test-storage-rename.mjs:86  assert.deepEqual(tight.snapshot(), { "ash:assistant-draft:r1": draft }, "放不下两份：旧键原样留着，不先删");
- web/scripts/test-storage-rename.mjs:103  const first = new StorageLike({ "ash:assistant-draft:r1": draft, "harness-next:small": "1", filler: "y".repeat(40) });
- web/scripts/test-storage-rename.mjs:106  assert.deepEqual(stuck, [{ key: "navi:assistant-draft:r1", legacyKey: "ash:assistant-draft:r1" }]);
- web/scripts/test-storage-rename.mjs:109  const other = new StorageLike({ "ash:assistant-draft:r1": "别的存储" });
- web/scripts/test-storage-rename.mjs:115  assert.equal(page.getItem("ash:assistant-draft:r1"), draft, "刷新之后旧值还在存储里");
- web/scripts/test-storage-rename.mjs:127  assert.deepEqual([page.getItem("navi:assistant-draft:r1"), page.map.has("ash:assistant-draft:r1")], ["放得下了", false], "写进新键之后旧键作废");
- web/scripts/test-storage-rename.mjs:131  const removing = reload(new StorageLike({ "ash:note": "x".repeat(50) }, { capacity: 60 }));
- web/scripts/test-storage-rename.mjs:134  assert.equal(removing.map.has("ash:note"), false);
- web/scripts/test-storage-rename.mjs:142  const storage = new Panels({ "ash:inspector:task:t1": state, "navi:other": "1" });
- web/scripts/test-storage-rename.mjs:145  assert.deepEqual(stuck, [{ key: "navi:inspector:task:t1", legacyKey: "ash:inspector:task:t1" }]);
- web/scripts/test-storage-rename.mjs:161  const storage = new Broken({ "ash:note": "要留下的字" });
- web/scripts/test-storage-rename.mjs:164  assert.equal(storage.getItem("ash:note"), "要留下的字", "迁移失败不删旧键");
- web/scripts/test-storage-rename.mjs:188  const session = new Storage({ "ash:chat-draft:r1": "半句话", "ash:chat-draft:r2": "放不下的草稿" });
- web/scripts/test-storage-rename.mjs:188  const session = new Storage({ "ash:chat-draft:r1": "半句话", "ash:chat-draft:r2": "放不下的草稿" });
- web/scripts/test-storage-rename.mjs:190  globalThis.window = { localStorage: new Storage({ "ash:task-scope": "mine" }), sessionStorage: session };
- web/scripts/test-storage-rename.mjs:206  assert.match(html, /localStorage\.getItem\("navi\.colorTheme"\) \|\| localStorage\.getItem\("ash\.colorTheme"\)/);
- web/scripts/test-storage-rename.mjs:214  assert.match(tabs, /const CHANNEL = "ash:preview-assist-claims";/);
- web/scripts/test-storage-rename.mjs:215  assert.match(tabs, /const LOCK = \(projectId: string, claim: string\) => `ash:preview-assist:\$\{projectId\}:\$\{claim\}`;/);
- web/scripts/test-storage-rename.mjs:221  const grep = spawnSync("git", ["grep", "-nE", "[\"`](ash|harness-next)[:.][a-zA-Z$]", "--", "src"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
- web/scripts/test-storage-rename.mjs:228  console.log("PASS storage rename: legacy ash:/ash./harness-next: keys move to navi before anything reads storage, newest generation wins, and what does not fit 
- web/scripts/test-storage-rename.mjs:228  console.log("PASS storage rename: legacy ash:/ash./harness-next: keys move to navi before anything reads storage, newest generation wins, and what does not fit 
- web/src/lib/storageRename.ts:2  // （harness → ash → navi），老版本页面存下的偏好、草稿、布局还挂在旧前缀上：页面一启动、任何模块读存储
- web/src/lib/storageRename.ts:6  // 同一个新键可能同时有好几代旧值（`ash:x` 和更早的 `harness-next:x` 都在）：按代数定胜负，新键 > ash >
- web/src/lib/storageRename.ts:6  // 同一个新键可能同时有好几代旧值（`ash:x` 和更早的 `harness-next:x` 都在）：按代数定胜负，新键 > ash >
- web/src/lib/storageRename.ts:20  ["ash:", "navi:"],
- web/src/lib/storageRename.ts:21  ["ash.", "navi."],
- web/src/settings/previewAssistTabs.ts:20  // 降级路:`navigator.locks` 要安全上下文,裸 http 的局域网地址(ash 常这么开)根本没有它。那一档
- web/src/settings/previewAssistTabs.ts:50  // 锁名和频道名**沿用改名前的 `ash:`**,是兼容值,批量改名时别换:它们是同一时刻活着的几份文档之间
- web/src/settings/previewAssistTabs.ts:55  const CHANNEL = "ash:preview-assist-claims";
- web/src/settings/previewAssistTabs.ts:56  const LOCK = (projectId: string, claim: string) => `ash:preview-assist:${projectId}:${claim}`;

## legacy-registry（113 处）

旧名登记处：兼容要认的旧名只在这两份里登记（各自的文件头写着），整份不进改名

- shared/src/legacy-names.ts:1  // 改名兼容：上几代产品名（ash ← harness）在**跨进程、落盘、落库、用户配置**里留下的字样。
- shared/src/legacy-names.ts:5  //  · 批量机械改名（把仓库里剩下的 ash 换成 navi）要能整份跳过这个文件，旧名才不会被一起换掉；
- shared/src/legacy-names.ts:14  /** 环境变量的旧前缀，新的在前（`NAVI_X` 读不到时依次认 `ASH_X`、`HARNESS_X`）。拆：用户启动命令、
- shared/src/legacy-names.ts:16  export const LEGACY_ENV_PREFIXES = ["ASH_", "HARNESS_"] as const;
- shared/src/legacy-names.ts:18  /** MCP 服务的旧登记名（工具名 `mcp__ash__…`、codex `[mcp_servers.ash]`）。拆：用户各家 CLI 配置里的
- shared/src/legacy-names.ts:20  export const LEGACY_MCP_SERVER_NAMES = ["ash", "harness"] as const;
- shared/src/legacy-names.ts:22  /** 仓库目录的旧名（用户机器上那份检出的文件夹名，如 Windows 真机 `D:\ai_workspace\ash`）：改名不挪目录，
- shared/src/legacy-names.ts:24  export const LEGACY_REPO_DIR_NAMES = ["ash", "harness"] as const;
- shared/src/legacy-names.ts:26  /** 任务分支的旧前缀（`ash/<id8>`）。拆：升级前建的任务都已验收或清理、仓库里不再有这种分支之后。 */
- shared/src/legacy-names.ts:27  export const LEGACY_TASK_BRANCH_PREFIXES = ["ash/", "harness/"] as const;
- shared/src/legacy-names.ts:30  export const LEGACY_ACCEPT_TAG_PREFIX = "ash-accepted/";
- shared/src/legacy-names.ts:36  export const LEGACY_DB_FILE = "ash.db";
- shared/src/legacy-names.ts:45  export const LEGACY_SINGLETON_LOCK_SUFFIX = ".ash.lock";
- shared/src/legacy-names.ts:46  export const LEGACY_RESOURCE_CLAIM_SUFFIX = ".ash-claim.lock";
- shared/src/legacy-names.ts:47  export const LEGACY_PRESENCE_PREFIX = ".ash-online.";
- shared/src/legacy-names.ts:50  export const LEGACY_PREVIEW_DEPS_READY_MARK = ".ash-deps-ready";
- shared/src/legacy-names.ts:53  /** 我方 HTTP 头的旧前缀（`x-ash-turn-token` 等）。升级前起的 MCP 子进程、钩子、旧版对端还在发。拆：同上 + 局域网对端都升级之后。 */
- shared/src/legacy-names.ts:54  export const LEGACY_HTTP_HEADER_PREFIX = "x-ash-";
- shared/src/legacy-names.ts:57  * 用户 key（`ash_…`）与远程设备令牌（`ashd_…`）的旧前缀。存的是哈希，用户手里拿着的是明文，
- shared/src/legacy-names.ts:60  export const LEGACY_USER_KEY_PREFIX = "ash_";
- shared/src/legacy-names.ts:64  export const LEGACY_SESSION_COOKIE = "ash_session";
- shared/src/legacy-names.ts:65  export const LEGACY_INSTANCE_COOKIE = "ash_instance";
- shared/src/legacy-names.ts:68  * 接力握手里的服务标识（ping 应答的 `service`，以及错误应答上的 `ash: true` 可信标记）。
- shared/src/legacy-names.ts:72  export const LEGACY_HANDOFF_SERVICE = "ash";
- shared/src/legacy-names.ts:76  export const LEGACY_PREVIEW_ANNOTATION_PROTOCOL = "ash-preview-annotation-v1";
- shared/src/legacy-names.ts:79  export const LEGACY_GIT_WORKBENCH_DIR = "ash-workbench";
- shared/src/legacy-names.ts:80  export const LEGACY_GIT_WORKTREE_BACKUPS_DIR = "ash-worktree-backups";
- shared/src/legacy-names.ts:88  export const LEGACY_LOG_TAG = "[ash]";
- shared/src/legacy-names.ts:91  export const LEGACY_TURN_PROGRESS_WATCH_HEAD = "ash-turn-progress-watch/v2";
- shared/src/legacy-names.ts:97  export const LEGACY_SEALED_SNAPSHOT_MARK = "ash.sealedsnapshot";
- shared/src/legacy-names.ts:104  export const LEGACY_CLAUDE_RUNTIME_SETTINGS_PREFIX = "ash-claude-settings-";
- shared/src/legacy-names.ts:107  export const LEGACY_TRACK_FILE_PREFIX = "ash-track-";
- shared/src/legacy-names.ts:113  export const LEGACY_HOST_MCP_SETUP_PATH = "/ash-mcp/host-setup";
- shared/src/legacy-names.ts:116  export const LEGACY_INJECTED_MCP_DIR = "ash-mcp";
- shared/src/legacy-names.ts:123  export const LEGACY_CLAUDE_GOAL_FILE_PREFIX = "ash-claude-goal-";
- shared/src/legacy-names.ts:124  export const LEGACY_CLAUDE_GOAL_CONTEXT_TAG = "ash-goal-context";
- shared/src/legacy-names.ts:130  export const LEGACY_WINDOWS_GATE_JOB_PREFIX = "Local\\ash-accept-gate-";
- shared/src/legacy-names.ts:137  export const LEGACY_STASH_OWNER_TAG = "ash";
- shared/src/legacy-names.ts:144  export const LEGACY_CLAUDE_INTERRUPT_ID_PREFIX = "ash_int_";
- shared/src/legacy-names.ts:147  * 飞书绑定码的旧前缀（`ASH-XXXX-XXXX`）。用户从网页抄下来发给机器人，机器人从消息里认出它；升级前
- shared/src/legacy-names.ts:150  export const LEGACY_IM_BIND_CODE_PREFIX = "ASH";
- shared/src/legacy-names.ts:155  export const FROZEN_HANDOFF_SIGNATURE_DOMAIN = "ash-handoff-v1";
- shared/src/legacy-names.ts:156  export const FROZEN_HANDOFF_ENCRYPTION_DOMAIN = "ash-handoff-enc-v1";
- shared/src/legacy-names.ts:157  export const FROZEN_HANDOFF_ENCRYPTION_MAGIC = "ash-enc1";
- shared/src/legacy-names.ts:160  export const FROZEN_IM_BIND_SALT = "ash-im-bind:";
- shared/src/legacy-names.ts:163  * 用户仓库里的隐藏 ref 命名空间：任务开工点 / 验收头 / 基线更新备份（`refs/ash/…`）、Git 工作台的
- shared/src/legacy-names.ts:164  * 操作备份（`refs/ash-backup/…`）。它们落在**用户的每一个仓库里**，读写点很多而且多是比较交换
- shared/src/legacy-names.ts:168  export const FROZEN_GIT_REF_NAMESPACE = "refs/ash/";
- shared/src/legacy-names.ts:169  export const FROZEN_GIT_BACKUP_REF_NAMESPACE = "refs/ash-backup/";
- shared/src/legacy-names.ts:175  export const FROZEN_HUMAN_APPROVAL_PURPOSE = "ash-human-approval-v1";
- shared/src/legacy-names.ts:184  export const FROZEN_AGENT_UNIT_PREFIX = "ash-agent-";
- shared/src/legacy-names.ts:185  export const FROZEN_CONFINE_TMP_DIR = "ash-confine";
- shared/src/legacy-names.ts:186  export const FROZEN_WINDOWS_AGENT_WRAP_SUFFIX = ".ash-agent-wrap.cjs";
- shared/src/legacy-names.ts:192  export const FROZEN_WINDOWS_STDIN_PIPE_PREFIX = "ash-stdin-";
- shared/src/legacy-names.ts:201  export const FROZEN_MONITOR_KIND_OWN = "ash";
- shared/src/legacy-names.ts:204  export const FROZEN_CODEX_RELAY_PROVIDER_ID = "ash_relay";
- shared/src/legacy-names.ts:213  export const FROZEN_GATE_ISOLATED_DIR_PREFIX = "ash-accept-gate-";
- shared/src/legacy-names.ts:216  * 多人模式下没填 git 邮箱的用户，替他署名用的默认域名（`<目录名>@ash.local`）。这些用户此前的每一个
- shared/src/legacy-names.ts:220  export const FROZEN_DEFAULT_GIT_EMAIL_DOMAIN = "ash.local";
- shared/src/legacy-names.ts:227  export const FROZEN_SYNTHETIC_COMMIT_NAME = "ash";
- shared/src/legacy-names.ts:228  export const FROZEN_SYNTHETIC_COMMIT_EMAIL = "ash@localhost";
- shared/src/legacy-names.ts:229  export const FROZEN_SYNTHETIC_COMMIT_MESSAGE = "ash: 任务改动的对比基准";
- shared/src/legacy-names.ts:234  //  · CLI 配置发布的备份 `.bak-navi-setup`（升级前留下的 `.bak-ash-setup` 原样留在用户手里，没人删它）
- shared/src/legacy-names.ts:253  // 不算约定、所以没动的：只活在本进程一个数据库连接里的 TEMP 触发器与自定义函数名（`ash_actions_*`），
- scripts/legacy-names.mjs:7  export const LEGACY_ENV_PREFIXES = ["ASH_", "HARNESS_"];
- scripts/legacy-names.mjs:8  export const LEGACY_MCP_SERVER_NAMES = ["ash", "harness"];
- scripts/legacy-names.mjs:9  export const LEGACY_REPO_DIR_NAMES = ["ash", "harness"];
- scripts/legacy-names.mjs:10  export const LEGACY_TASK_BRANCH_PREFIXES = ["ash/", "harness/"];
- scripts/legacy-names.mjs:11  export const LEGACY_ACCEPT_TAG_PREFIX = "ash-accepted/";
- scripts/legacy-names.mjs:12  export const LEGACY_DB_FILE = "ash.db";
- scripts/legacy-names.mjs:14  export const LEGACY_SINGLETON_LOCK_SUFFIX = ".ash.lock";
- scripts/legacy-names.mjs:15  export const LEGACY_RESOURCE_CLAIM_SUFFIX = ".ash-claim.lock";
- scripts/legacy-names.mjs:16  export const LEGACY_PRESENCE_PREFIX = ".ash-online.";
- scripts/legacy-names.mjs:17  export const LEGACY_PREVIEW_DEPS_READY_MARK = ".ash-deps-ready";
- scripts/legacy-names.mjs:18  export const LEGACY_HTTP_HEADER_PREFIX = "x-ash-";
- scripts/legacy-names.mjs:19  export const LEGACY_USER_KEY_PREFIX = "ash_";
- scripts/legacy-names.mjs:21  export const LEGACY_SESSION_COOKIE = "ash_session";
- scripts/legacy-names.mjs:22  export const LEGACY_INSTANCE_COOKIE = "ash_instance";
- scripts/legacy-names.mjs:23  export const LEGACY_HANDOFF_SERVICE = "ash";
- scripts/legacy-names.mjs:24  export const LEGACY_PREVIEW_ANNOTATION_PROTOCOL = "ash-preview-annotation-v1";
- scripts/legacy-names.mjs:25  export const LEGACY_GIT_WORKBENCH_DIR = "ash-workbench";
- scripts/legacy-names.mjs:26  export const LEGACY_GIT_WORKTREE_BACKUPS_DIR = "ash-worktree-backups";
- scripts/legacy-names.mjs:27  export const LEGACY_LOG_TAG = "[ash]";
- scripts/legacy-names.mjs:28  export const LEGACY_TURN_PROGRESS_WATCH_HEAD = "ash-turn-progress-watch/v2";
- scripts/legacy-names.mjs:29  export const LEGACY_SEALED_SNAPSHOT_MARK = "ash.sealedsnapshot";
- scripts/legacy-names.mjs:30  export const LEGACY_CLAUDE_RUNTIME_SETTINGS_PREFIX = "ash-claude-settings-";
- scripts/legacy-names.mjs:31  export const LEGACY_TRACK_FILE_PREFIX = "ash-track-";
- scripts/legacy-names.mjs:32  export const LEGACY_HOST_MCP_SETUP_PATH = "/ash-mcp/host-setup";
- scripts/legacy-names.mjs:33  export const LEGACY_INJECTED_MCP_DIR = "ash-mcp";
- scripts/legacy-names.mjs:34  export const LEGACY_CLAUDE_GOAL_FILE_PREFIX = "ash-claude-goal-";
- scripts/legacy-names.mjs:35  export const LEGACY_CLAUDE_GOAL_CONTEXT_TAG = "ash-goal-context";
- scripts/legacy-names.mjs:36  export const LEGACY_WINDOWS_GATE_JOB_PREFIX = "Local\\ash-accept-gate-";
- scripts/legacy-names.mjs:37  export const LEGACY_STASH_OWNER_TAG = "ash";
- scripts/legacy-names.mjs:38  export const LEGACY_CLAUDE_INTERRUPT_ID_PREFIX = "ash_int_";
- scripts/legacy-names.mjs:39  export const LEGACY_IM_BIND_CODE_PREFIX = "ASH";
- scripts/legacy-names.mjs:40  export const FROZEN_HANDOFF_SIGNATURE_DOMAIN = "ash-handoff-v1";
- scripts/legacy-names.mjs:41  export const FROZEN_HANDOFF_ENCRYPTION_DOMAIN = "ash-handoff-enc-v1";
- scripts/legacy-names.mjs:42  export const FROZEN_HANDOFF_ENCRYPTION_MAGIC = "ash-enc1";
- scripts/legacy-names.mjs:43  export const FROZEN_IM_BIND_SALT = "ash-im-bind:";
- scripts/legacy-names.mjs:44  export const FROZEN_GIT_REF_NAMESPACE = "refs/ash/";
- scripts/legacy-names.mjs:45  export const FROZEN_GIT_BACKUP_REF_NAMESPACE = "refs/ash-backup/";
- scripts/legacy-names.mjs:46  export const FROZEN_HUMAN_APPROVAL_PURPOSE = "ash-human-approval-v1";
- scripts/legacy-names.mjs:47  export const FROZEN_AGENT_UNIT_PREFIX = "ash-agent-";
- scripts/legacy-names.mjs:48  export const FROZEN_CONFINE_TMP_DIR = "ash-confine";
- scripts/legacy-names.mjs:49  export const FROZEN_WINDOWS_AGENT_WRAP_SUFFIX = ".ash-agent-wrap.cjs";
- scripts/legacy-names.mjs:50  export const FROZEN_WINDOWS_STDIN_PIPE_PREFIX = "ash-stdin-";
- scripts/legacy-names.mjs:51  export const FROZEN_MONITOR_KIND_OWN = "ash";
- scripts/legacy-names.mjs:52  export const FROZEN_CODEX_RELAY_PROVIDER_ID = "ash_relay";
- scripts/legacy-names.mjs:53  export const FROZEN_GATE_ISOLATED_DIR_PREFIX = "ash-accept-gate-";
- scripts/legacy-names.mjs:54  export const FROZEN_DEFAULT_GIT_EMAIL_DOMAIN = "ash.local";
- scripts/legacy-names.mjs:55  export const FROZEN_SYNTHETIC_COMMIT_NAME = "ash";
- scripts/legacy-names.mjs:56  export const FROZEN_SYNTHETIC_COMMIT_EMAIL = "ash@localhost";
- scripts/legacy-names.mjs:57  export const FROZEN_SYNTHETIC_COMMIT_MESSAGE = "ash: 任务改动的对比基准";

## mac-legacy-app（106 处）

改名前的 mac 应用（Ash.app / dev.ash.mac / 登录项 dev.ash.server）：新版首次打开时按这些名字接班

- README.md:57  装过改名前的 **Ash.app**：它没法自己更新成 Navi（换了应用标识），按上面装一次 Navi 再打开就好 —— Navi 第一次打开时会退出 Ash、接过它的设置、数据和登录项（Ash 不肯退或者复制失败时先弹窗问你，不会悄悄丢掉），等 Ash 的服务和别的进程都不再用它后把 `Ash.app` 移到废纸篓
- README.md:57  装过改名前的 **Ash.app**：它没法自己更新成 Navi（换了应用标识），按上面装一次 Navi 再打开就好 —— Navi 第一次打开时会退出 Ash、接过它的设置、数据和登录项（Ash 不肯退或者复制失败时先弹窗问你，不会悄悄丢掉），等 Ash 的服务和别的进程都不再用它后把 `Ash.app` 移到废纸篓
- desktop/macos/README.md:3  装在「应用程序」里的一整份 Navi：自带 node 和 server/web/mcp，数据放在 `~/Library/Application Support/dev.navi.mac/`（从 Ash.app 升级上来的机器上还是原来的 `dev.ash.mac/`，见「从 Ash.app 升级」），打开就能用。不依赖
- desktop/macos/README.md:3  装在「应用程序」里的一整份 Navi：自带 node 和 server/web/mcp，数据放在 `~/Library/Application Support/dev.navi.mac/`（从 Ash.app 升级上来的机器上还是原来的 `dev.ash.mac/`，见「从 Ash.app 升级」），打开就能用。不依赖
- desktop/macos/README.md:3  装在「应用程序」里的一整份 Navi：自带 node 和 server/web/mcp，数据放在 `~/Library/Application Support/dev.navi.mac/`（从 Ash.app 升级上来的机器上还是原来的 `dev.ash.mac/`，见「从 Ash.app 升级」），打开就能用。不依赖
- desktop/macos/README.md:23  版本：`CFBundleShortVersionString` 是给人看的（`build.sh` 里的 `VERSION`）；`CFBundleVersion` 严格递增：样子是 UTC `日期.时分秒`，但每次构建都要比账本里上一个号大，不比它大（同一秒、从旧提交重打、时钟回拨）就在它上面加一，并发构建按锁排队（`s
- desktop/macos/README.md:23  版本：`CFBundleShortVersionString` 是给人看的（`build.sh` 里的 `VERSION`）；`CFBundleVersion` 严格递增：样子是 UTC `日期.时分秒`，但每次构建都要比账本里上一个号大，不比它大（同一秒、从旧提交重打、时钟回拨）就在它上面加一，并发构建按锁排队（`s
- desktop/macos/README.md:43  - **appcast** 在素材库 [noroot777/materials](https://github.com/noroot777/materials)（`feedRepo`）的 `navi/mac/appcast.xml`，app 的 `SUFeedURL` 是它在 raw.githubusercontent
- desktop/macos/README.md:43  - **appcast** 在素材库 [noroot777/materials](https://github.com/noroot777/materials)（`feedRepo`）的 `navi/mac/appcast.xml`，app 的 `SUFeedURL` 是它在 raw.githubusercontent
- desktop/macos/README.md:77  # （数据根按自己机器上的写：从 Ash.app 升级上来的还是 dev.ash.mac，见「从 Ash.app 升级」）
- desktop/macos/README.md:77  # （数据根按自己机器上的写：从 Ash.app 升级上来的还是 dev.ash.mac，见「从 Ash.app 升级」）
- desktop/macos/README.md:77  # （数据根按自己机器上的写：从 Ash.app 升级上来的还是 dev.ash.mac，见「从 Ash.app 升级」）
- desktop/macos/README.md:89  旧版 app 会在下一次定时检查时又提示装新版：点「跳过这个版本」（勾过自动安装的，先 `defaults write dev.navi.mac SUAutomaticallyUpdate -bool NO` 再打开旧版）。回退到改名前的 Ash.app 不在这条路上：那是另一个 app，见「从 Ash.app 升级」
- desktop/macos/README.md:89  旧版 app 会在下一次定时检查时又提示装新版：点「跳过这个版本」（勾过自动安装的，先 `defaults write dev.navi.mac SUAutomaticallyUpdate -bool NO` 再打开旧版）。回退到改名前的 Ash.app 不在这条路上：那是另一个 app，见「从 Ash.app 升级」
- desktop/macos/README.md:93  **签名密钥**（2026-11-14 已生成，公钥已在 `release.json`）：私钥存在这台 Mac 的**登录钥匙串**里，条目名 `dev.navi.mac`（`keychainAccount`；改名前生成的那条叫 `dev.ash.mac`，新名下没有时发版脚本用旧的那条签、并打出挪过去的命令），不进任
- desktop/macos/README.md:134  ## 从 Ash.app 升级
- desktop/macos/README.md:136  改名之前装的是 `Ash.app`（包标识 `dev.ash.mac`）。Navi 换了包标识（`dev.navi.mac`），macOS 把它当成另一个 app，而 Sparkle 只肯装包标识相同的更新包（实测：包名、包标识都换了的 dmg，旧版下载、验签之后报「No suitable install is fou
- desktop/macos/README.md:136  改名之前装的是 `Ash.app`（包标识 `dev.ash.mac`）。Navi 换了包标识（`dev.navi.mac`），macOS 把它当成另一个 app，而 Sparkle 只肯装包标识相同的更新包（实测：包名、包标识都换了的 dmg，旧版下载、验签之后报「No suitable install is fou
- desktop/macos/README.md:144  | defaults 域 `dev.ash.mac` | `dev.navi.mac` | 每一项抄过来（新域已有的不盖）；`AshURL` / `AshDataDir` / 窗口位置 `NSWindow Frame AshMainWindow` 换成 `NaviURL` / `NaviDataDir` / `…Nav
- desktop/macos/README.md:145  | 数据根 `~/Library/Application Support/dev.ash.mac/` | 原地继续用 | 新的那块地还不存在、旧的在，就一直用旧的（记在 defaults 里，之后哪个组件建出了新目录也不会换成空数据根）。不搬：数据根的路径决定窗口专用端口，端口一变页面的源就变，页面存在本机的设置全丢 
- desktop/macos/README.md:145  | 数据根 `~/Library/Application Support/dev.ash.mac/` | 原地继续用 | 新的那块地还不存在、旧的在，就一直用旧的（记在 defaults 里，之后哪个组件建出了新目录也不会换成空数据根）。不搬：数据根的路径决定窗口专用端口，端口一变页面的源就变，页面存在本机的设置全丢 
- desktop/macos/README.md:146  | WebKit 网站数据 `~/Library/WebKit/dev.ash.mac`、cookie `~/Library/HTTPStorages/dev.ash.mac{,.binarycookies}` | `…/dev.navi.mac` | 等旧窗口退了，在第一个窗口建出来之前整份复制（复制不挪，旧的留着）
- desktop/macos/README.md:146  | WebKit 网站数据 `~/Library/WebKit/dev.ash.mac`、cookie `~/Library/HTTPStorages/dev.ash.mac{,.binarycookies}` | `…/dev.navi.mac` | 等旧窗口退了，在第一个窗口建出来之前整份复制（复制不挪，旧的留着）
- desktop/macos/README.md:147  | 登录项 `~/Library/LaunchAgents/dev.ash.server.plist`（跑 `Ash.app/…/Ash --start-server`） | `dev.navi.server.plist`（跑 `Navi.app/…/Navi --start-server`） | 原来开着就先装好新的
- desktop/macos/README.md:147  | 登录项 `~/Library/LaunchAgents/dev.ash.server.plist`（跑 `Ash.app/…/Ash --start-server`） | `dev.navi.server.plist`（跑 `Navi.app/…/Navi --start-server`） | 原来开着就先装好新的
- desktop/macos/README.md:150  | `/Applications/Ash.app`（或 `~/Applications/`、别处 LaunchServices 认得的） | 废纸篓里；原位置是一个指向 `Navi.app` 的软链 | 等旧登录项换成了 Navi 的、旧服务、旧版拉起的 MCP 和别的进程都不在用它的代码了才挪，判据与 `instal
- desktop/macos/README.md:150  | `/Applications/Ash.app`（或 `~/Applications/`、别处 LaunchServices 认得的） | 废纸篓里；原位置是一个指向 `Navi.app` 的软链 | 等旧登录项换成了 Navi 的、旧服务、旧版拉起的 MCP 和别的进程都不在用它的代码了才挪，判据与 `instal
- desktop/macos/README.md:188  内容铺到窗口顶，红绿灯浮在页面左上角，不单占一行标题栏（首次配置时窗口开多大见「第一次打开」）。页面要给它让位，所以是页面先表态：`web/index.html` 里有 `<meta name="navi-window-chrome" content="overlay">`（改名前的页面写的是 `ash-window-
- desktop/macos/README.md:190  导出下载先写目标目录内的独立临时文件，完成后再原子替换目标文件。下载失败或在完成前退出不会删除已有文件。每笔下载在 app 那块地（`~/Library/Application Support/dev.navi.mac`，升级上来的是 `dev.ash.mac`）的 `downloads` 下留一张带锁的登记；app 
- desktop/macos/README.md:201  | `Sources/LegacyIdentity.swift` | 改名前的 Ash.app 怎么交班：设置、网页数据、登录项接过来，旧包让位 |
- desktop/macos/README.md:230  卸载：菜单里先取消「登录时启动 Navi 服务」，停掉服务，再删 /Applications/Navi.app（升级上来的机器上还有一个指向它的 `Ash.app` 替身，一起删）；数据在 `~/Library/Application Support/dev.navi.mac/`（升级上来的是 `dev.ash.mac
- desktop/macos/README.md:230  卸载：菜单里先取消「登录时启动 Navi 服务」，停掉服务，再删 /Applications/Navi.app（升级上来的机器上还有一个指向它的 `Ash.app` 替身，一起删）；数据在 `~/Library/Application Support/dev.navi.mac/`（升级上来的是 `dev.ash.mac
- desktop/macos/Sources/LegacyIdentity.swift:6  /// 已经装着 Ash.app（dev.ash.mac）的机器第一次打开 Navi 时，在这里把这几样接过来，再让旧 app 让位：
- desktop/macos/Sources/LegacyIdentity.swift:6  /// 已经装着 Ash.app（dev.ash.mac）的机器第一次打开 Navi 时，在这里把这几样接过来，再让旧 app 让位：
- desktop/macos/Sources/LegacyIdentity.swift:12  ///  · 登录项：旧的那条 LaunchAgent（dev.ash.server，指着 Ash.app 里的可执行文件）开着就先装好自己的，再卸旧的；
- desktop/macos/Sources/LegacyIdentity.swift:12  ///  · 登录项：旧的那条 LaunchAgent（dev.ash.server，指着 Ash.app 里的可执行文件）开着就先装好自己的，再卸旧的；
- desktop/macos/Sources/LegacyIdentity.swift:14  ///    把它移到废纸篓、原地留一个指向 Navi.app 的软链 —— CLI 的 MCP 登记、脚本里写死的 Ash.app 路径照样走得通，
- desktop/macos/Sources/LegacyIdentity.swift:24  static let bundleID = "dev.ash.mac"
- desktop/macos/Sources/LegacyIdentity.swift:25  static let loginLabel = "dev.ash.server"
- desktop/macos/Sources/LegacyIdentity.swift:26  static let appName = "Ash.app"
- desktop/macos/Sources/LegacyIdentity.swift:142  library.appendingPathComponent("WebKit/.\(current).adopted-from-ash")
- desktop/macos/Sources/LegacyIdentity.swift:283  /// 旧的登录项（指着 Ash.app 里的 `Contents/MacOS/Ash`）。
- desktop/macos/Sources/LegacyIdentity.swift:388  /// 「没人在用」还得包括**登记在外面、以后才会跑的**：旧登录项写死的是 `Ash.app/Contents/MacOS/Ash`，留下的
- desktop/macos/Sources/LoginService.swift:10  /// （dev.ash.server）由 LegacyIdentity 卸掉、换成这一条。
- desktop/macos/Sources/LoginService.swift:68  // 改名前的那条（dev.ash.server）也得关掉，不然下次登录它照样起服务；同时记下「用户关了」，接班的后台重试不再打开。
- desktop/macos/Sources/NaviConfig.swift:71  /// 正式那份是 dev.navi.mac（改名前是 dev.ash.mac，接班见 LegacyIdentity）。演练用的 app 换一个
- desktop/macos/Sources/NaviConfig.swift:81  /// app 自己的那块地。从 Ash.app 升级上来的机器上还是改名前那块（dev.ash.mac），见 LegacyIdentity。
- desktop/macos/Sources/NaviConfig.swift:81  /// app 自己的那块地。从 Ash.app 升级上来的机器上还是改名前那块（dev.ash.mac），见 LegacyIdentity。
- desktop/macos/Sources/WindowChrome.swift:8  ///    `ash-window-chrome`，连旧版服务时两个都认）才铺上去。没有这一行的
- desktop/macos/Sources/WindowChrome.swift:156  const declare = () => post(document.querySelector("meta[name='navi-window-chrome'][content='overlay'], meta[name='ash-window-chrome'][content='overlay']") ? "ov
- desktop/macos/Sources/main.swift:7  // 改名前（Ash.app）的设置先接过来：下面不管哪一档，读到的都是同一份设置（见 LegacyIdentity）。
- desktop/macos/Tests/Identity/main.swift:3  // scripts/test-macos-identity.mjs 的驱动：编进来的是真的 LegacyIdentity（Ash.app → Navi.app 的接班）。
- desktop/macos/Tests/Identity/main.swift:59  let legacy = root.appendingPathComponent("dev.ash.mac").path
- desktop/macos/Tests/Identity/main.swift:102  require(fm.fileExists(atPath: path("WebKit/.new.id.adopted-from-ash")), "the marker other processes trust is on disk")
- desktop/macos/Tests/Identity/main.swift:121  try! fm.removeItem(atPath: path("WebKit/.gate.id.adopted-from-ash"))
- desktop/macos/Tests/Identity/main.swift:217  // 登录项路径一定由测试给：默认那一份是这台机器上真的 ~/Library/LaunchAgents/dev.ash.server.plist。
- desktop/macos/Tests/SparkleDmg/main.swift:4  // scripts/test-macos-sparkle-dmg.mjs 的宿主 app：一个只带 Sparkle 的空壳 app（Navi.app，或改名前的 Ash.app），Info.plist 里的更新配置与
- desktop/macos/Tests/SparkleDmg/main.swift:41  // 「仅通知」的条目（改名前的 Ash.app 收到的那种）：没有可装的东西，记下它指向哪就退。
- desktop/macos/Tests/WindowChromeProbe.swift:191  // 改名前的页面（连旧版服务时载到的）表态用的是 ash-window-chrome，照样认。
- desktop/macos/Tests/WindowChromeProbe.swift:192  webView.loadHTMLString("<meta name='ash-window-chrome' content='overlay'><title>opted</title>", baseURL: nil)
- desktop/macos/build.sh:30  LEGACY_BOOK="$COMMON/ash-mac-build-number"
- desktop/macos/build.sh:38  # NAVI_MAC_BUILD_NUMBER 指定时不碰账本（演练造一新一旧两版用）。改名前的账本（ash-mac-build-number）在锁里当底读，见 build-number.mjs。
- desktop/macos/build.sh:41  # 包标识改名前是 dev.ash.mac：已装的旧版怎么接到这一版，见 Sources/LegacyIdentity.swift 和 README「从 Ash.app 升级」。
- desktop/macos/build.sh:41  # 包标识改名前是 dev.ash.mac：已装的旧版怎么接到这一版，见 Sources/LegacyIdentity.swift 和 README「从 Ash.app 升级」。
- desktop/macos/build.sh:85  # 改名前的 Ash.app 让位时判「还有没有人在用」，用的是安装器同一份判据（LegacyIdentity.retire）。
- desktop/macos/release.json:2  "//": "发版配置，见 desktop/macos/README.md「发版」。安装包（dmg，人下载和 Sparkle 更新都用它）是 releaseRepo 里 tag 为 <tagPrefix><版本>-<构建号> 的 Release 附件；appcast 在 feedRepo 的 feedBranch 上的
- desktop/macos/release.json:2  "//": "发版配置，见 desktop/macos/README.md「发版」。安装包（dmg，人下载和 Sparkle 更新都用它）是 releaseRepo 里 tag 为 <tagPrefix><版本>-<构建号> 的 Release 附件；appcast 在 feedRepo 的 feedBranch 上的
- desktop/macos/release.json:11  "legacyKeychainAccount": "dev.ash.mac",
- desktop/macos/scripts/appcast.mjs:65  * 打开 link。给改名前的 Ash.app 用 —— 它装不了包标识不同的 Navi。
- desktop/macos/scripts/build-number.mjs:4  // 改名前的账本（ash-mac-build-number）只读不写，每次都拿它当底：号只能往上走，换一本空账本就丢了「上一个号」。
- desktop/macos/scripts/bundle-runtime.mjs:2  // 把「跑起一份 navi 要的一切」装进 Ash.app 的 Contents/Resources/app：固定版本的 node、shared/web/
- desktop/macos/scripts/bundle-runtime.mjs:44  console.error("usage: bundle-runtime.mjs <Ash.app/Contents/Resources>");
- desktop/macos/scripts/install-app.sh:15  # 改名前装的 Ash.app 不在这里换：它的包标识不同，是另一个 app，由 Navi 第一次打开时接班（LegacyIdentity.swift）。
- desktop/macos/scripts/release.mjs:6  // 都有写权限。改名前装的 Ash.app 看的是另一份 appcast（legacyAppcastPath），也装不了包标识不同的 Navi：
- desktop/macos/scripts/release.mjs:166  // 改名前的构建记在 AshSourceCommit 里（重发一份旧构建时用得上）。
- desktop/macos/scripts/release.mjs:167  const recorded = info.NaviSourceCommit ?? info.AshSourceCommit;
- desktop/macos/scripts/release.mjs:243  + `\n\n装着改名前的 Ash.app：装法一样，装好打开一次 Navi，它会接过 Ash 的设置、数据和登录项，把 Ash.app 移到废纸篓。`,
- desktop/macos/scripts/release.mjs:243  + `\n\n装着改名前的 Ash.app：装法一样，装好打开一次 Navi，它会接过 Ash 的设置、数据和登录项，把 Ash.app 移到废纸篓。`,
- desktop/macos/scripts/release.mjs:337  * 改名前的更新源：已装的 Ash.app（dev.ash.mac）只看它，Sparkle 也只肯装包标识相同的包 —— Navi 它装不了。
- desktop/macos/scripts/release.mjs:337  * 改名前的更新源：已装的 Ash.app（dev.ash.mac）只看它，Sparkle 也只肯装包标识相同的包 —— Navi 它装不了。
- desktop/macos/scripts/release.mjs:354  + "它会接过 Navi 的设置、数据和登录项，并把旧的 Ash.app 移到废纸篓。</p>" + notes.html,
- desktop/macos/scripts/release.mjs:361  say(`▶ 提交 ${config.feedRepo}/${config.legacyAppcastPath}（给还装着 Ash.app 的机器看的通知）`);
- desktop/macos/scripts/release.mjs:365  message: `navi mac ${shortVersion}（${version}）：通知改名前的 Ash.app`,
- scripts/test-macos-client.mjs:389  const legacyBook = join(temporary, "ash-build-number");
- scripts/test-macos-identity.mjs:1  // mac app 改名接班（Ash.app / dev.ash.mac → Navi.app / dev.navi.mac）的定点回归（仅 macOS）。
- scripts/test-macos-identity.mjs:1  // mac app 改名接班（Ash.app / dev.ash.mac → Navi.app / dev.navi.mac）的定点回归（仅 macOS）。
- scripts/test-macos-identity.mjs:169  const loginPolicyPlist = join(temporary, "LoginPolicy", "dev.ash.server.plist");
- scripts/test-macos-identity.mjs:181  const legacy = fakeBundle(join(apps, "Ash.app"), "dev.ash.mac");
- scripts/test-macos-identity.mjs:181  const legacy = fakeBundle(join(apps, "Ash.app"), "dev.ash.mac");
- scripts/test-macos-identity.mjs:182  const other = fakeBundle(join(temporary, "elsewhere", "Ash.app"), "com.example.ash");
- scripts/test-macos-identity.mjs:183  const loginPlist = join(temporary, "LaunchAgents", "dev.ash.server.plist"); // 默认那份是这台机器上真的，测试一律给临时路径
- scripts/test-macos-identity.mjs:227  assert.equal(readlinkSync(legacy), successor, "… to the new app, so absolute paths into Ash.app keep working");
- scripts/test-macos-identity.mjs:233  const lockless = fakeBundle(join(temporary, "Applications-2", "Ash.app"), "dev.ash.mac", { lock: false });
- scripts/test-macos-identity.mjs:233  const lockless = fakeBundle(join(temporary, "Applications-2", "Ash.app"), "dev.ash.mac", { lock: false });
- scripts/test-macos-release.mjs:19  // 改名：改名前的 Ash.app 看的那份 appcast 里换成一条签过名、不带安装包的「仅通知」条目，指向这一版的下载页；
- scripts/test-macos-release.mjs:20  // 已经指着这一版或更新的就不动（重跑、补旧版收尾都不倒回去）；app 里只记着改名前的 AshSourceCommit 也认；
- scripts/test-macos-release.mjs:201  assert.doesNotMatch(legacy(), /<enclosure/, "nothing to install: Ash.app cannot install a bundle with another identifier");
- scripts/test-macos-release.mjs:516  result = await publish(github, fakeApp("20000102.0003", key.publicKey, { feed, commit: "abc1234", commitKey: "AshSourceCommit" }), { artifacts: "formal-artifact
- scripts/test-macos-sparkle-dmg.mjs:9  // 改名（Ash.app / dev.ash.* → Navi.app / dev.navi.*）：改名前的 Ash.app 拿到 Navi 的包也装不上（Sparkle 只认同名或
- scripts/test-macos-sparkle-dmg.mjs:9  // 改名（Ash.app / dev.ash.* → Navi.app / dev.navi.*）：改名前的 Ash.app 拿到 Navi 的包也装不上（Sparkle 只认同名或
- scripts/test-macos-sparkle-dmg.mjs:69  /** 一份空壳 Navi.app（或改名前的 Ash.app）：版本、要不要一打开就查更新、看哪份 appcast；更新配置同 build.sh。 */
- scripts/test-macos-sparkle-dmg.mjs:175  // 改名前的 Ash.app（另一个包名、另一个包标识）对着同一个 Navi 包：下载、验签都过，但认不出这是自己的新版，拒装。
- scripts/test-macos-sparkle-dmg.mjs:180  assert.equal(versionOf(ash), "20000101.0001", "Ash.app is left exactly as it was");
- scripts/test-macos-sparkle-dmg.mjs:182  console.log(`PASS: a pre-rename Ash.app cannot install the Navi bundle itself (Sparkle: ${result.seen.at(-1).split(" <- ").at(-1)}) — hence the one manual insta
- scripts/test-macos-sparkle-dmg.mjs:193  console.log("PASS: through the pre-rename feed, Ash.app only gets an informational notice pointing at the download, and fetches nothing else");
- web/src/onboarding/FirstRunWizard.tsx:56  /** 在 mac app 里(壳在 UA 里留了 `NaviMac/`,改名前的壳留的是 `AshMac/`):数据那一站已经在原生那一屏走过了,导轨上补一格打勾的。 */

## sibling（96 处）

同一行同时写着新旧两代（或 harness 那一代）：这一行是在列举/比对各代名字

- README.md:57  装过改名前的 **Ash.app**：它没法自己更新成 Navi（换了应用标识），按上面装一次 Navi 再打开就好 —— Navi 第一次打开时会退出 Ash、接过它的设置、数据和登录项（Ash 不肯退或者复制失败时先弹窗问你，不会悄悄丢掉），等 Ash 的服务和别的进程都不再用它后把 `Ash.app` 移到废纸篓
- README.md:57  装过改名前的 **Ash.app**：它没法自己更新成 Navi（换了应用标识），按上面装一次 Navi 再打开就好 —— Navi 第一次打开时会退出 Ash、接过它的设置、数据和登录项（Ash 不肯退或者复制失败时先弹窗问你，不会悄悄丢掉），等 Ash 的服务和别的进程都不再用它后把 `Ash.app` 移到废纸篓
- README.md:57  装过改名前的 **Ash.app**：它没法自己更新成 Navi（换了应用标识），按上面装一次 Navi 再打开就好 —— Navi 第一次打开时会退出 Ash、接过它的设置、数据和登录项（Ash 不肯退或者复制失败时先弹窗问你，不会悄悄丢掉），等 Ash 的服务和别的进程都不再用它后把 `Ash.app` 移到废纸篓
- desktop/macos/README.md:43  - **appcast** 在素材库 [noroot777/materials](https://github.com/noroot777/materials)（`feedRepo`）的 `navi/mac/appcast.xml`，app 的 `SUFeedURL` 是它在 raw.githubusercontent
- desktop/macos/README.md:140  3. 不用先退出 Ash，也不用停服务：Navi 第一次打开时自己做下面这些（`Sources/LegacyIdentity.swift`）。Ash 要是不肯退（正弹着「等任务跑完再装更新」之类的对话框），Navi 不开窗口、先弹窗说明，让你选「重试」「不接了，直接打开」或「退出」。
- desktop/macos/README.md:140  3. 不用先退出 Ash，也不用停服务：Navi 第一次打开时自己做下面这些（`Sources/LegacyIdentity.swift`）。Ash 要是不肯退（正弹着「等任务跑完再装更新」之类的对话框），Navi 不开窗口、先弹窗说明，让你选「重试」「不接了，直接打开」或「退出」。
- desktop/macos/README.md:144  | defaults 域 `dev.ash.mac` | `dev.navi.mac` | 每一项抄过来（新域已有的不盖）；`AshURL` / `AshDataDir` / 窗口位置 `NSWindow Frame AshMainWindow` 换成 `NaviURL` / `NaviDataDir` / `…Nav
- desktop/macos/README.md:144  | defaults 域 `dev.ash.mac` | `dev.navi.mac` | 每一项抄过来（新域已有的不盖）；`AshURL` / `AshDataDir` / 窗口位置 `NSWindow Frame AshMainWindow` 换成 `NaviURL` / `NaviDataDir` / `…Nav
- desktop/macos/README.md:144  | defaults 域 `dev.ash.mac` | `dev.navi.mac` | 每一项抄过来（新域已有的不盖）；`AshURL` / `AshDataDir` / 窗口位置 `NSWindow Frame AshMainWindow` 换成 `NaviURL` / `NaviDataDir` / `…Nav
- desktop/macos/README.md:146  | WebKit 网站数据 `~/Library/WebKit/dev.ash.mac`、cookie `~/Library/HTTPStorages/dev.ash.mac{,.binarycookies}` | `…/dev.navi.mac` | 等旧窗口退了，在第一个窗口建出来之前整份复制（复制不挪，旧的留着）
- desktop/macos/README.md:147  | 登录项 `~/Library/LaunchAgents/dev.ash.server.plist`（跑 `Ash.app/…/Ash --start-server`） | `dev.navi.server.plist`（跑 `Navi.app/…/Navi --start-server`） | 原来开着就先装好新的
- desktop/macos/README.md:147  | 登录项 `~/Library/LaunchAgents/dev.ash.server.plist`（跑 `Ash.app/…/Ash --start-server`） | `dev.navi.server.plist`（跑 `Navi.app/…/Navi --start-server`） | 原来开着就先装好新的
- desktop/macos/README.md:154  - **隐私权限要重新给**：macOS 按包标识记权限（辅助功能、完全磁盘访问、自动化、文件夹访问……）。给过 Ash 的，Navi 第一次用到时会重新问；「系统设置 → 隐私与安全性」里 Ash 那几条要自己删。
- desktop/macos/README.md:154  - **隐私权限要重新给**：macOS 按包标识记权限（辅助功能、完全磁盘访问、自动化、文件夹访问……）。给过 Ash 的，Navi 第一次用到时会重新问；「系统设置 → 隐私与安全性」里 Ash 那几条要自己删。
- desktop/macos/README.md:157  - Dock 里固定的 Ash 图标会跟着旧包进废纸篓（或者失效）：从 Dock 移掉、重新把 Navi 拖上去。**别从废纸篓或那个旧图标打开 Ash**：旧版会把 Navi 的服务当成「旧版 app 起的」换成它自己的、用旧代码跑在已经被新版迁移过的库上；真要退回旧版按「更新前的库备份、回到旧版」那一节走。
- desktop/macos/README.md:157  - Dock 里固定的 Ash 图标会跟着旧包进废纸篓（或者失效）：从 Dock 移掉、重新把 Navi 拖上去。**别从废纸篓或那个旧图标打开 Ash**：旧版会把 Navi 的服务当成「旧版 app 起的」换成它自己的、用旧代码跑在已经被新版迁移过的库上；真要退回旧版按「更新前的库备份、回到旧版」那一节走。
- desktop/macos/README.md:190  导出下载先写目标目录内的独立临时文件，完成后再原子替换目标文件。下载失败或在完成前退出不会删除已有文件。每笔下载在 app 那块地（`~/Library/Application Support/dev.navi.mac`，升级上来的是 `dev.ash.mac`）的 `downloads` 下留一张带锁的登记；app 
- desktop/macos/scripts/release.mjs:243  + `\n\n装着改名前的 Ash.app：装法一样，装好打开一次 Navi，它会接过 Ash 的设置、数据和登录项，把 Ash.app 移到废纸篓。`,
- desktop/macos/scripts/release.mjs:353  notes: `<p>Ash 改名为 Navi。新版换了应用标识，没法从 Ash 里直接更新：点「了解更多」下载 Navi，拖进「应用程序」后打开一次，`
- desktop/macos/scripts/release.mjs:353  notes: `<p>Ash 改名为 Navi。新版换了应用标识，没法从 Ash 里直接更新：点「了解更多」下载 Navi，拖进「应用程序」后打开一次，`
- docs/install.md:72  npm run restart      # 构建 + 后台常驻,日志 /tmp/navi-4317.log(Windows 是 %TEMP%\navi-4317.log;改名之前是 ash-4317.log)
- docs/install.md:127  - 改写已有文件前生成 `.bak-navi-setup` 备份(改名之前的版本留下的是 `.bak-ash-setup`,升级后原样留着,
- mcp/src/turn-identity.ts:53  * 一个身份变量的各代名字（`NAVI_TASK_ID`、`ASH_TASK_ID`…）在这份环境里的值，新名在前。升级前起的
- scripts/accept-test.mjs:7  // 各代名字一起擦(`NAVI_DB`、改名之前的 `ASH_DB`……):擦漏一代,测试就会打到那份库上。
- scripts/env.mjs:2  // 上几代的 `ASH_X`、`HARNESS_X`；写给子进程只写新名并擦掉旧名；擦就各代一起擦。
- scripts/env.mjs:50  /** 交给用户自己写的命令读的变量：`NAVI_` 开头的再带一份上一代旧名（`ASH_`）。 */
- scripts/mcp-host-sources.mjs:119  /** 规范登记名;改名之前的登记名(`ash`、更早的 `harness`)见 legacy-names.mjs,照样认作已登记。 */
- scripts/mcp-host-sources.mjs:351  * 刻意**不折叠**,跟 TS 那份 `shapes.ts` 的 `scan` 一一对应:`ash` 和 `harness` 是两条独立
- scripts/mcp-host-sources.mjs:455  * 赢家,于是「高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着」被判成关着,而真 CLI
- scripts/server-control.mjs:14  * server 用的库文件,口径跟 server/src/db/path.ts 一致:`NAVI_DB`(旧名 `ASH_DB` 同样认)覆盖;
- scripts/setup.mjs:31  // 改名之前的登记（`ash`、更早的 `harness`）在这里迁成规范名：Navi 起 claude/codex 时注入的是规范名，
- scripts/test-kimi-mcp.mjs:27  for (const name of [NAVI, "ash", "harness"]) {
- scripts/test-runner.mjs:154  // 从外面继承来的 ASH_DATA_DIR 和新写的 NAVI_DATA_DIR 同时出现、值又不同，读的那头（readStorageEnv）拒绝启动。
- server/scripts/mcp-sources-cases.ts:146  // ── ⑱ 逐名跨来源解析:`ash` 和 `harness` 是两条独立登记(本轮审查 F3)──────────
- server/scripts/mcp-sources-cases.ts:151  // ⒜ 审查那条复现:高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着 ⇒ 真 CLI
- server/scripts/mcp-sources-cases.ts:152  //    那边工具**连得上**(两个名字各是一条登记,ash 的工具由 harness 那条提供)。
- server/scripts/mcp-sources-cases.ts:171  // ⒝ 同一个选中结果要**喂给搬运**:宿主那份里 `ash` 关着(指向 /off.js)、`harness` 开着
- server/scripts/mcp-sources-cases.ts:192  // ⒞ 诊断提示跟判定取**同一条**登记:`ash` 关着(/old.js)、`harness` 开着(/live.js)
- server/scripts/test-branch-acceptance.ts:408  const legacyBranch = s.parentWs.branch!.replace(/^ash\//, "harness/");
- server/scripts/test-branch-plan-scale.ts:92  assert.equal(await branchOwner(root, "project", "harness/parent-o"), undefined, "ash branch wins when both namespaces exist");
- server/scripts/test-codex-mcp-turn-token.ts:165  assert.ok(!/mcp_servers\.(ash|harness)[.=]/.test(handle.commandLine), "规范安装不能被历史名盖回去");
- server/scripts/test-data-root.ts:121  claudeEntry: existsSync(join(dir, ".claude.json")) ? JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers?.navi : null, // 宿主那条是旧名 ash,搬进来落成当前
- server/scripts/test-navi-mcp-inject.ts:103  // 只认注入的那个名字:历史名(ash、harness)连着也不替它作证
- server/scripts/test-navi-mcp-inject.ts:104  for (const legacy of ["ash", "harness"]) {
- server/scripts/test-navi-mcp-installer.ts:171  for (const head of ['[mcp_servers."ash"]', "[mcp_servers.'harness']", "[ mcp_servers . ash ]"]) {
- server/scripts/test-navi-mcp-installer.ts:171  for (const head of ['[mcp_servers."ash"]', "[mcp_servers.'harness']", "[ mcp_servers . ash ]"]) {
- server/scripts/test-navi-mcp-installer.ts:240  '[mcp_servers.other]\ncommand = "x"\n\n[plugins.demo]\ndisabled_mcp_servers = ["ash", "harness"]\n',
- server/scripts/test-navi-mcp-installer.ts:273  // 已有 ash/harness:一个字节都不动。
- server/scripts/test-navi-mcp-installer.ts:274  for (const name of [NAME, "ash", "harness"]) {
- server/scripts/test-navi-mcp-registry.ts:219  for (const name of [NAME, "ash", "harness"]) {
- server/scripts/test-navi-mcp-registry.ts:476  assert.match(offState.detail, /ash 这条登记是关着的、harness 这条登记是关着的/,
- server/scripts/test-preview-host-api.ts:15  //   ① 宿主进程继承的、以及登录 shell 从 profile 里读回来的 `ASH_PROXY`/`HARNESS_PROXY`
- server/scripts/test-preview-host-api.ts:53  writeFileSync(join(home, ".profile"), "export ASH_PROXY=http://127.0.0.1:5\nexport HARNESS_PROXY=http://127.0.0.1:6\n");
- server/scripts/test-preview-host-api.ts:85  assert(!/127\.0\.0\.1:[1256]\b/.test(log), `父进程带下来的 ASH_PROXY/HARNESS_PROXY 一个字都不该起作用\n${log.slice(0, 600)}`);
- server/scripts/test-preview-settings-proxy.ts:228  const echo = await request(content + "echo", "POST", { message: "你好" }, { cookie: "ash_session=SECRET", authorization: "Basic YXNoOnNlY3JldA==", "x-ash-turn-tok
- server/scripts/test-search-query.ts:41  for (const prefix of ["navi/", "ash/", "harness/"]) assert.deepEqual(candidates(`${prefix}Zx8Kq2mN`), ["zx8kq2mn"]);
- server/scripts/test-turn-fingerprint.ts:38  const toNavi = (vars: Record<string, string>) => Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.replace(/^ASH_/, "NAVI_"), v]));
- server/scripts/tmp-db.ts:51  // 各代名字都要查：服务端新名优先，只查自己设的旧名 `ASH_DB` 的话，继承来的一个 `NAVI_DB` 就能
- server/src/auth/store.ts:28  /** `navi_` + 43 字符 base64url(256 bit 熵)。前缀让它在聊天记录里一眼可辨(改名之前发的是 `ash_`,照样认)。 */
- server/src/codex-toml.ts:55  * **兜底**：扫描器没认出任何登记、可文本里明明有 `mcp_servers.ash` / `mcp_servers.harness`
- server/src/codex-toml.ts:132  // 第二段是兼容名。上一版拿「行首是 `[` 且行内有 ash/harness」当信号，codex 自己记项目
- server/src/git.ts:298  /** 这条任务的分支在仓库里实际叫什么：改名之前建的还是 `ash/<id8>`（再早 `harness/`），沿用它；都没有才用当前名。 */
- server/src/handoff-wire.ts:28  * 改名之前的对端认不出 `navi/` 开头的任务分支：它按 `ash/<id8>` 去找这条任务的分支，找不到就在
- server/src/log-signals.ts:18  /** `[navi] preview-api-host <主机>:<端口>`（旧前缀 `[ash]` 同样认），见 preview-log.ts。 */
- server/src/mcp-registry/host-setup.ts:71  * 命令是同一个 node、NAVI_URL(旧登记里是 ASH_URL、HARNESS_URL)规范化之后是同一个地址。
- server/src/mcp-registry/shapes.ts:20  /** 认的服务名(当前名 `navi`、历史名 `ash` / `harness`)—— **各自独立的登记**,顺序就是优先。 */
- server/src/mcp-registry/shapes.ts:57  * 两个兼容名是两条独立登记,所以**先找开着的那条**:`ash` 关着、`harness` 开着时 CLI 那边
- server/src/mcp-registry/sources.ts:265  * **逐个兼容名各算一次**(上一轮审查 F3):`ash` 和 `harness` 是两条独立登记。更早一版先把
- server/src/mcp-registry/sources.ts:267  * 「高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着」被判成 disabled(预检硬拒),
- server/src/mcp-registry/types.ts:46  * 一个兼容名(`ash` / 历史名 `harness`)在**一份**配置里的事实 —— 刻意**不折叠**。
- server/src/mcp-registry/types.ts:48  * 为什么要有这一层(本轮审查 F3):`ash` 和 `harness` 是**两条独立登记**,一条关着、另一条
- server/src/mcp-registry/types.ts:122  * `hostBlock` 按名字固定先挑 `ash`,`read` 挑**开着**的那条,于是 `ash` 关着、`harness`
- server/src/mcp-registry/types.ts:122  * `hostBlock` 按名字固定先挑 `ash`,`read` 挑**开着**的那条,于是 `ash` 关着、`harness`
- server/src/preview-env.ts:25  * 进程继承下来的这两个**（连同它们的各代旧名 `ASH_*`、`HARNESS_*` —— dev.mjs 各代都认，留着等于
- server/src/request-headers.ts:1  // 收请求头的单点：我方的头一律按各代名字读（`x-navi-…`，退到旧名 `x-ash-…`），见 shared/src/http-headers.ts。
- server/src/review-channel-gap.ts:79  *    位置：上一版拿 `\b(ash|harness)\b` 在整行上找，而本仓目录就叫 harness、`~/.ash/…` 这类
- server/src/review-channel-gap.ts:79  *    位置：上一版拿 `\b(ash|harness)\b` 在整行上找，而本仓目录就叫 harness、`~/.ash/…` 这类
- server/src/review-channel-gap.ts:97  * codex 自己报 MCP server 出错时点名的那个位置：``MCP client for `ash` ``、``MCP server 'harness' ``
- server/src/turn-identity.ts:76  * 回合身份变量交给智能体时**新旧两代名字同值各一份**(`NAVI_TASK_ID` 和 `ASH_TASK_ID`)。
- server/src/window-port.ts:4  // 会落到新来的那一份上：新版 navi 见到别人的实例号会拒收（instance-binding.ts），可旧版 ash 不认
- shared/src/env-names.ts:1  // 环境变量的名字：当前前缀 `NAVI_`，读的时候认上几代（`ASH_`、`HARNESS_`，见 legacy-names.ts）。
- shared/src/env-names.ts:21  /** 同一个变量的各代名字，新名在前：`NAVI_DB` → `["NAVI_DB", "ASH_DB", "HARNESS_DB"]`。 */
- shared/src/env-names.ts:44  * （`NAVI_DB=preview.db`）底下的智能体跑 `ASH_DB=/tmp/x npm test`。新名优先的话测试开的就是预览库，
- shared/src/env-names.ts:80  * 交给用户自己写的命令读的变量：`NAVI_` 开头的那几个再带一份上一代的旧名（`ASH_`），别的原样。
- shared/src/http-headers.ts:1  // 我方 HTTP 头的名字：当前前缀 `x-navi-`，读的时候也认旧前缀 `x-ash-`（见 legacy-names.ts）。
- shared/src/http-headers.ts:31  /** 同一个头的各代名字，新名在前：`x-navi-turn-token` → `["x-navi-turn-token", "x-ash-turn-token"]`。 */
- shared/src/mcp.ts:8  * 认得出的全部登记名，当前名在前。用户 CLI 配置里旧版 setup 登记的那条（`ash`、更早的 `harness`）、
- shared/src/task-branch.ts:2  // `ash/<id8>`、更早是 `harness/<id8>`（前缀见 legacy-names.ts），仓库里还在，**按任务找分支时
- web/index.html:31  try { pref = localStorage.getItem("navi.colorTheme") || localStorage.getItem("ash.colorTheme"); } catch (e) {}
- web/package.json:108  "//test:storage-rename": "改名后的本机存储：ash: / ash. / harness-next: 下的旧键在任何模块读存储之前整批挪到 navi 前缀。",
- web/package.json:108  "//test:storage-rename": "改名后的本机存储：ash: / ash. / harness-next: 下的旧键在任何模块读存储之前整批挪到 navi 前缀。",
- web/scripts/dom-stage.mjs:45  response.end('<!doctype html><meta name="navi-human-action-token" content="ash-test-page-token">');
- web/scripts/fixtures/debate-bubble.data.json:11  "statement": "本段没有实际可回应的技术驳回：“执行者的驳回”为 null；执行者自己的完整记录也逐项接受了首轮五条发现（见 /Users/fjh/code/harness/data/runs/g6wp5QSD2N6Y/reSK_yrodFhZ.md:110-150）。\n\n我接受的是“其中四项已经不再是
- web/scripts/fixtures/debate-bubble.data.json:11  "statement": "本段没有实际可回应的技术驳回：“执行者的驳回”为 null；执行者自己的完整记录也逐项接受了首轮五条发现（见 /Users/fjh/code/harness/data/runs/g6wp5QSD2N6Y/reSK_yrodFhZ.md:110-150）。\n\n我接受的是“其中四项已经不再是
- web/src/onboarding/FirstRunWizard.tsx:57  const IN_MAC_APP = typeof navigator !== "undefined" && /\b(?:Navi|Ash)Mac\//.test(navigator.userAgent);
- web/vite/page-token.ts:55  // 改名之前的写法（`ASH_PROXY=… npm run dev`、更早的 `HARNESS_PROXY`）照样认，见 env-names.ts。

## legacy-markers（51 处）

读旧写新的旧名：只在认旧数据的那一侧出现，见 shared/src/legacy-names.ts

- desktop/macos/README.md:29  - 认过人之后，页面发的每个请求（页面本身、fetch、SSE、预览）还都带着那一份服务的实例号（cookie `ash_instance`，原生的补接请求放在请求头里）。实例号每次起服务都换；自家服务原地重起过、或者专用端口上换了一份新版 Navi，见到别人的实例号一律 409、什么都不执行（`server/src/
- desktop/macos/README.md:170  连上自己那份之后，app 替本机装了的 CLI 接 Navi MCP（`POST /api/ash-mcp/host-setup`，同注册执行器那一下：缺了才写、已有登记一律不覆盖），写进去的是 app 自带的 node 和 `mcp/dist`。已有登记**指向别处**的（比如仓库的 `mcp/dist`）不替你改，
- desktop/macos/Sources/BrowserWindowController.swift:33  // 默认数据仓：cookie（多人模式的 ash_session）、localStorage（主题、草稿）跨启动保留。
- desktop/macos/Sources/BrowserWindowController.swift:283  static let instanceCookie = "ash_instance"
- desktop/macos/Sources/HostMcpSetup.swift:3  /// 首次连上自己那份服务时，替本机 CLI 接好 navi MCP（`POST /api/ash-mcp/host-setup`，逐家补接的
- desktop/macos/Sources/HostMcpSetup.swift:62  var request = URLRequest(url: NaviConfig.windowURL.appendingPathComponent("api/ash-mcp/host-setup"), timeoutInterval: 60)
- scripts/macos-client-guard.mjs:38  const cookie = /(?:^|;\s*)ash_instance=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? request.headers["x-ash-instance"] ?? null;
- server/scripts/test-claude-reattach-background.ts:295  // 这一组的打断记录用的是改名之前的请求号 `ash_int_1`:升级前插过话的智能体,接管时照样认得出那个结尾。
- server/scripts/test-claude-reattach-background.ts:297  writeFileSync(`${out}.steer.json`, JSON.stringify({ entries: [{ id: "ash_int_1", result: 1, sent }] }));
- server/scripts/test-claude-reattach-background.ts:300  ["ack-first", [...launch.slice(0, 2), ack("ash_int_1"), interruptedResult], []],
- server/scripts/test-claude-reattach-background.ts:301  ["ack-last", [...launch.slice(0, 2), interruptedResult, ack("ash_int_1")], []],
- server/scripts/test-claude-reattach-background.ts:302  ["ack-in-tail", [...launch.slice(0, 2), interruptedResult], [ack("ash_int_1")]],
- server/scripts/test-claude-reattach-background.ts:303  ["result-in-tail", [...launch.slice(0, 2), ack("ash_int_1")], [interruptedResult]],
- server/scripts/test-claude-reattach-background.ts:304  ["ack-delayed", [...launch.slice(0, 2), interruptedResult], [{ __wait: 1450 }, ack("ash_int_1")]],
- server/scripts/test-claude-reattach-background.ts:305  ["progress-before-ack", [...launch.slice(0, 2), interruptedResult], [progress, { __wait: 60 }, ack("ash_int_1")]],
- server/scripts/test-claude-reattach-background.ts:306  ["no-ack-yet", [...launch.slice(0, 2)], [interruptedResult, { __wait: 1200 }, ack("ash_int_1")]],
- server/scripts/test-claude-relay-settings-live.ts:18  const staleSettings = join(tmpdir(), "ash-claude-settings-2147483647-00000000-0000-0000-0000-000000000000.json");
- server/scripts/test-context-1m-notice.ts:137  const frozenCommand = "claude -p --model claude-fable-5-2 --settings /tmp/ash-claude-settings-1.json <messages via stdin>";
- server/scripts/test-im-gates.ts:296  const tagged = acceptedOutcome({ kind: "isolated_worktree", merge: "tagged", tag: "ash-accepted/abc123" });
- server/scripts/test-im-gates.ts:297  assert.ok(tagged.text!.includes("ash-accepted/abc123") && !tagged.brief!.includes("navi-accepted"), "只推标题：不带标签名");
- server/scripts/test-instance-binding.ts:90  ["cookie", { cookie: `theme=dark; ash_instance=${stale}` }],
- server/scripts/test-instance-binding.ts:92  ["cookie 对、请求头不对", { cookie: `ash_instance=${ours}`, "x-navi-instance": stale }],
- server/scripts/test-instance-binding.ts:100  assert.equal((await create("ours", { cookie: `ash_instance=${ours}` })).status < 300, true, "带自己的实例号照常执行");
- server/scripts/test-instance-binding.ts:104  const staleCookie = { cookie: `ash_instance=${stale}` };
- server/scripts/test-instance-binding.ts:114  "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", `Cookie: ash_instance=${stale}`, "", "",
- server/scripts/test-instance-binding.ts:134  assert.equal((await windowCreate("window-stale", `ash_instance=${stale}`)).status, 409, "窗口端口上带着别人的实例号一样 409");
- server/scripts/test-instance-binding.ts:135  assert.ok((await windowCreate("window-ours", `ash_instance=${ours}`)).status < 300, "窗口端口上带自己的实例号照常执行");
- server/scripts/test-instance-binding.ts:138  const page = (at: string) => fetch(`${at}/`, { headers: { cookie: `ash_instance=${ours}` } }).then((r) => r.status);
- server/scripts/test-local-only-auth.ts:96  assert.equal((await call("/api/canary", { headers: { ...relayed, cookie: `ash_session=${deviceToken}` } })).status, 401, "旧设备 cookie");
- server/scripts/test-preview-settings-proxy.ts:228  const echo = await request(content + "echo", "POST", { message: "你好" }, { cookie: "ash_session=SECRET", authorization: "Basic YXNoOnNlY3JldA==", "x-ash-turn-tok
- server/scripts/test-process-identity.ts:475  const mine = join(tmpdir(), `ash-track-${process.pid}-${stamp}-selfown`);
- server/scripts/test-process-identity.ts:478  const stillHeld = join(tmpdir(), `ash-track-${deadOwner}-${stamp}-held`);
- server/scripts/test-process-identity.ts:488  const orphan = join(tmpdir(), `ash-track-${deadOwner}-${stamp}-orphan`);
- server/scripts/test-process-subtrees.ts:184  const absent = join(tmpdir(), `ash-track-absent-${process.pid}-${Date.now()}`);
- server/scripts/test-process-subtrees.ts:192  const quiet = join(tmpdir(), `ash-track-quiet-${process.pid}-${Date.now()}`);
- server/scripts/test-process-subtrees.ts:198  const heldPath = join(tmpdir(), `ash-track-held-${process.pid}-${Date.now()}`);
- server/scripts/test-rename-compat.ts:152  let seen = await accept((repo, previous) => git(repo, "tag", "ash-accepted/Tg7hJk2m", previous));
- server/scripts/test-rename-compat.ts:155  assert.deepEqual(seen.tags, ["ash-accepted/Tg7hJk2m"], "不许留下两份指着不同提交的验收标签");
- server/scripts/test-rename-compat.ts:158  git(repo, "tag", "ash-accepted/Tg7hJk2m", previous);
- server/scripts/test-rename-compat.ts:163  seen = await accept((repo) => git(repo, "tag", "ash-accepted/Tg7hJk2m", "ash/Tg7hJk2m"));
- server/scripts/test-rename-compat.ts:164  assert.ok(seen.result.ok && seen.result.tag === "ash-accepted/Tg7hJk2m", JSON.stringify(seen.result));
- server/scripts/test-rename-compat.ts:165  assert.deepEqual(seen.tags, ["ash-accepted/Tg7hJk2m"]);
- server/scripts/test-silence-tier.ts:216  writeFileSync(join(dir, nameOf(half)), "ash-turn-progress-watch/v2 " + half + "\n"); // 缺末行
- server/src/git-accept.ts:463  /** 改名之前打的标签（`ash-accepted/<id8>`）：重复验收时它已经指着同一个提交就算打过了，不再打一个新名的。 */
- server/src/git-accept.ts:512  // 新旧两个名字是**同一份验收记录**：改名之前打的 `ash-accepted/<id>` 也算数。任何一个指着
- server/src/git-workbench/journal.ts:12  // 改名之前的操作日志在 `ash-workbench` 里：那个目录在就接着用它，日志不断档。
- server/src/git-worktree-recovery.ts:68  // 改名之前的备份都在 `ash-worktree-backups`：那个目录在就接着往里放，备份不分两处。
- server/src/preview-access.ts:44  * 中间件就能把原始 `ash_session` 记下来外带，之后脱离预览直接登进 navi —— 那就不是「借身份
- web/scripts/test-accept-gate-reads.mjs:101  { stage: "merged", reason: "branch_delete_failed", completedTag: "ash-accepted/gate-task" },
- web/scripts/test-accept-gate-reads.mjs:103  const error = entry.completedMerge ? "成果已合入 main（提交 abcdef12），目录及文件已保留" : "标签 ash-accepted/gate-task 已创建，目录及文件已保留";
- web/scripts/test-git-workbench-review.mjs:370  "ash-workbench",

## prose（38 处）

注释/文档里讲旧名本身的句子（同一行提到改名、旧名、几代）

- desktop/macos/Sources/BrowserWindowController.swift:210  /// 等不到就换上一屏持久的说明，给「重试」和「仍然显示页面」（后者给不报尺寸的旧版 ash 留一条明确的路），
- desktop/macos/Sources/NaviHealth.swift:26  /// 这个服务进程的实例号，每次起服务都换。旧版本的 ash 不报这四项。
- desktop/macos/Sources/WindowChrome.swift:9  ///    文档（旧版本的 ash、同源的 /mobile 之类别的页面）不知道要给红绿灯让位，壳就退回普通标题栏。
- desktop/macos/build.sh:15  # 这几个口子改名前叫 ASH_MAC_*，旧名照样认、新名优先（下面读的时候各退一档）。
- scripts/dev.mjs:95  // 前缀用旧的 `[ash]`：拉起这次预览的可能还是改名之前的服务，它只认这个前缀；新版两种都认
- scripts/macos-client-guard.mjs:6  //   · 4317 换人时换上一份**旧版 ash**：不认实例号，什么请求来了都照办 —— 第 3 轮审查 F1 的那个口子。
- scripts/macos-client-guard.mjs:7  // 换人 = 自己那份停了（窗口端口不再有人听）、旧版 ash 接手 4317。页面每 30ms 发一次写请求：从头到尾
- scripts/macos-client-guard.mjs:8  // 一条都不许落到 4317 上（旧版 ash 收到就会执行）；刷新那一下拦住、什么都不点也会被定时认人撤下；
- scripts/macos-client-guard.mjs:27  // 窗口不该往这里发任何东西：记下来，照旧版 ash 的样子照办。
- scripts/macos-client-guard.mjs:85  // 自己那份停了：窗口端口没人听，旧版 ash 接手 4317。
- scripts/server-control.mjs:59  * (`x-ash-host-token`)。新版服务两代都认、新名优先。
- scripts/test-accept-test.mjs:497  // 直接跑执行器（npm run test:web 这类，不经验收入口）：宿主带进来的改名前旧名（ASH_DATA_DIR 等）同样不漏给
- server/scripts/codex-approve-cases.ts:18  // 补进去的那条登记的表头：落的是当前名。宿主机上的 `[mcp_servers.ash]` 是改名之前 setup 写的旧名。
- server/scripts/test-data-root.ts:267  // 宿主那条是改名之前的 `ash`，搬进隔离档落成当前名。
- server/scripts/test-handoff-capability.ts:60  // 老版本 ash 的 ping 应答里没有 capabilities 字段。这时一律 unknown 放行 —— 与对端
- server/scripts/test-handoff-return.ts:434  // 东西时清理会主动放弃、对端是旧版 ash 时压根不清、用户也随时能把 worktree 建回来。
- server/src/accept-gate-confinement-macos.ts:11  * 改名之前起的验收身上挂的是旧名记号（`ASH_ACCEPT_GATE_UNIT`），重启后接回它时得按旧名扫。哪一代
- server/src/auth/handoff-peer-user.ts:24  /** 入站：改名之前的对端发的是旧名（x-ash-peer-user-key），两代都认。 */
- server/src/executors/navi-mcp-confirm.ts:174  // 调成过任一代登记名的那条都算接上（用户配置里旧版 setup 登记的 `ash` 也是这个 MCP）。
- server/src/handoff-peer-client.ts:307  // 对端没报身份 = 旧版 ash。本机从没记过它的指纹时按「无从核对」放行(否则升级路径
- server/src/handoff-peers.ts:97  // 改名之前的对端发的是旧名头(x-ash-peer-*),两代都认。
- server/src/handoff-types.ts:338  // 对端的机器身份。老版本 ash 没有这个字段 —— 源机据此判定「无从核对」并如实提示。
- server/src/handoff-types.ts:355  // 任务」,详见 server/src/handoff-capability.ts 顶部。老版本 ash 没有这个字段 ——
- server/src/handoff-wire.ts:4  //  · ping 应答的 `service`：旧版发起方严格比对 `=== "ash"`，写成新名它就判「对端不是 Navi」。所以
- server/src/handoff-wire.ts:6  //  · 错误应答上的可信标记（「这是对端业务层明确拒绝的，可证明没落库」）：旧版只认 `ash: true`，
- server/src/handoff-wire.ts:31  * 就拒绝并说清原因**。升级之前建的任务分支还是 `ash/…`，旧版认得，照常放行。返回 null = 不拦。
- server/src/log-signals.ts:4  // `[ash]`（预览的是改名之后的分支，主服务还没升级）。「调度器起来了」是预览的安全兜底 —— 旧版主服务
- server/src/mcp-handoff.ts:89  // claude 的 MCP 工具名形如 `mcp__navi__report_stage`（旧名 `mcp__ash__…` 同样认，见 `naviMcpToolOf`）。
- server/src/mcp-registry/relocate.ts:172  * 这里照样各代都认 —— 改名之前的 `[mcp_servers.ash]` 原样传进来，也按它自己的表改写，而不是扑空后把
- server/src/monitor-unit-scan.ts:64  * 认记号时各代变量名都认：改名之前起的进程（活过了升级重启的智能体、哨兵）身上是 `ASH_MONITOR_UNIT`。
- server/src/monitor-unit-scan.ts:73  * 从改名之前起的那份 ash 进程（或一个旧任务的回合）里继承来的环境带着 `NAVI_MONITOR_UNIT=<旧单元>`，
- server/src/terminal-shell.ts:148  // 「我在 Navi 的终端里」：给用户自己的 shell 配置读的，旧名照旧导一份（他的 profile 里写的可能还是 $ASH_TERMINAL）。
- server/src/window-port.ts:9  // 这个端口不归这份服务独占：有人特意用 PORT 把旧版 ash 起在它上面、又赶在撤页前那一下，请求仍会被
- shared/src/handoff.ts:396  /** ping 应答里对端自报的能力。老版本 ash 不带这个字段 —— 那时一律按「无从核对」处理。 */
- shared/src/mcp.ts:9  * 升级前起的会话里 CLI 报出来的工具名（`mcp__ash__complete_task`），都按这一份认。
- shared/src/mcp.ts:112  * 同上,连旧名(`ASH_TASK_ID`…)一起 —— **清**按这一份:升级前起的智能体、它们留下的子进程环境里
- shared/src/monitor.ts:49  * Navi 自己起的哨兵（停得掉、有日志）。值是冻结的旧名 `"ash"`：它落在每一行哨兵记录上、走在接口里，
- web/src/task-detail/taskDerivation.ts:11  /** 这条任务自己的分支：改名之前建的叫 `ash/<id8>`，在 `branches`（仓库现有分支）里找实际存在的那个，都不在就是当前名。 */

## frozen-monitor-kind（33 处）

冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts（哨兵出身 monitors.kind）

- mobile/scripts/test-monitor-strip.mjs:38  window.mock.lists[taskId] = [{ id: "mon-" + taskId, taskId, kind: "ash", status: "running", description: "任务" + taskId + "的监听", events: 1 }];
- mobile/scripts/test-monitor-strip.mjs:131  { id: "mon-A", taskId: "A", kind: "ash", status: "running", description: "任务A的监听", events: 1 },
- mobile/scripts/test-monitor-strip.mjs:138  { id: "mon-A", taskId: "A", kind: "ash", status: "running", description: "任务A的监听", events: 1 },
- mobile/scripts/test-monitor-strip.mjs:139  { id: "mon-A2", taskId: "A", kind: "ash", status: "running", description: "任务A的第二条", events: 1 },
- scripts/check-brand-text.mjs:7  // `~/ash-workspaces`、`mcp__ash__`、`"ash"` 这类，以及整串就是一个标识符的字面量（`kind === "ash"`）。
- server/scripts/monitors-fixture.ts:163  endedAt: null, endedReason: null, ownerUserId: null, kind: "ash",
- server/scripts/test-claude-monitor-hook.ts:77  assert.equal(row.kind, "ash", "代办出来的必须是 navi 自己起的那种——那才是能唤醒任务的");
- server/scripts/test-claude-monitor-projection.ts:58  const native = listed.find((m) => m.kind === "ash");
- server/scripts/test-claude-monitor-projection.ts:61  check(native?.kind === "ash" && native?.nativeId === null, "navi 那种 kind=navi 且没有原生 id");
- server/scripts/test-monitor-wake-role.ts:333  id, taskId, kind: "ash", command: "sleep 30", description, cwd: root, status,
- server/scripts/test-rename-compat.ts:247  assert.deepEqual([...MONITOR_KINDS], ["ash", "claude"], "落库的值不许跟着改名变");
- server/scripts/test-task-delete-atomic.ts:42  const monitorRow = (taskId: string, kind: "ash" | "claude") => ({
- server/scripts/test-task-delete-atomic.ts:44  cwd: root, status: "exited", pid: null, pidStartedAt: null, logPath: kind === "ash" ? join(root, `${taskId}.log`) : "",
- server/scripts/test-task-delete-atomic.ts:58  await db.insert(monitors).values([monitorRow(taskId, "ash"), monitorRow(taskId, "claude")]);
- server/scripts/test-task-delete-atomic.ts:86  assert.deepEqual(cards.map((r) => r.kind).sort(), ["ash", "claude"], `①两张历史卡一张不少${tag}`);
- server/src/claude-monitors.ts:605  * 注意这跟 `reattachMonitors` 的分工：那边只认 `kind='ash'`（有 pid 可以验），claude 的
- server/src/db/schema-monitors.ts:131  // 出身:'ash' = navi server 自己起的进程(全功能);'claude' = claude CLI 内置 Monitor 的
- server/src/monitor-handoff-retry.ts:62  * `kind='ash'` 之外不看：claude 投影没有自己的收尾路径，也从不写这一列。
- web/scripts/fixtures/monitor-inspector.tsx:42  id: "m-wait", taskId: "task-a", kind: "ash", nativeId: null, lifetime: "bounded",
- web/scripts/fixtures/scheduled-message-tray.tsx:12  id: `live-${index}`, taskId: "task-a", kind: "ash", nativeId: null, lifetime: "bounded", command: `watch ${index}`,
- web/scripts/monitor-dom-harness.mjs:20  kind: "ash",
- web/scripts/test-monitor-inspector.tsx:24  kind: "ash",
- web/scripts/test-monitor-inspector.tsx:443  // 能力判据写的是 `kind === "ash"`，字段缺失时「能停」「有日志」同时为 false。前端先更新、
- web/scripts/test-monitor-inspector.tsx:448  assert.equal(normalizeMonitorDto(legacy).kind, "ash", "缺 kind 的旧 DTO 要归一成 ash");
- web/scripts/test-scheduled-message-tray.tsx:98  id, taskId: "task", kind: "ash", nativeId: null, lifetime: "bounded", command: `watch ${id}`, description, cwd: "/repo",
- web/src/components/MonitorTrayRow.tsx:42  const builtin = monitor.kind !== "ash";
- web/src/components/MonitorTrayRow.tsx:80  if (monitor.kind !== "ash") {
- web/src/components/ScheduledMessageTray.tsx:58  const waking = watching.some((monitor) => monitor.kind === "ash");
- web/src/monitors/MonitorInspector.tsx:23  { kind: "ash", title: "Navi 哨兵", hint: null },
- web/src/monitors/monitorTray.ts:45  if (monitor.kind !== "ash") return "不会叫醒任务";
- web/src/monitors/monitorTray.ts:56  const starts = monitors.flatMap((monitor) => monitor.kind === "ash" ? [monitorStart(monitor)] : [])
- web/src/task-detail/useTaskInspectorStack.ts:80  return [...running.filter((m) => m.kind === "ash"), ...running.filter((m) => m.kind !== "ash")];
- web/src/task-detail/useTaskInspectorStack.ts:80  return [...running.filter((m) => m.kind === "ash"), ...running.filter((m) => m.kind !== "ash")];

## legacy-lock-files（25 处）

读旧写新的旧名：只在认旧数据的那一侧出现，见 shared/src/legacy-names.ts（互斥要横跨新旧两版：旧版只认这几个文件名）

- README.md:239  - **单实例锁** — 粒度是 DB 文件路径，不是端口。锁文件（`*.ash.lock`）由 server 写入，restart 脚本读取以识别进程归属。
- desktop/macos/README.md:78  # 1. 退出 app，停掉服务（数据根里 ash.db.ash.lock 记着 pid）
- desktop/macos/README.md:79  kill "$(node -p 'require(process.env.HOME + "/Library/Application Support/dev.navi.mac/ash.db.ash.lock").pid')"
- desktop/macos/Sources/DataImport.swift:61  return Source(url: url, livePID: livePID(lock: url.appendingPathComponent("ash.db.ash.lock")))
- desktop/macos/Sources/DataImport.swift:98  || name.hasSuffix(".ash.lock") || name.contains(".ash-online.")
- desktop/macos/Sources/DataImport.swift:98  || name.hasSuffix(".ash.lock") || name.contains(".ash-online.")
- desktop/macos/Sources/RestartImpact.swift:109  let lock = NaviConfig.dataURL.appendingPathComponent("ash.db.ash.lock")
- scripts/test-macos-client.mjs:426  writeFileSync(join(source, "ash.db.ash-online.123.json"), "{}");
- scripts/test-macos-client.mjs:434  writeFileSync(join(source, "ash.db.ash.lock"), JSON.stringify({ pid: process.pid, port: 4317, token: "x" }));
- scripts/test-macos-client.mjs:519  for (const skipped of ["deps", "tmp", "downloads", "ash.db.ash.lock", "ash.db.ash-online.123.json", ".mac-maintenance.json", "ash.db-wal", "ash.db-shm",
- scripts/test-macos-client.mjs:519  for (const skipped of ["deps", "tmp", "downloads", "ash.db.ash.lock", "ash.db.ash-online.123.json", ".mac-maintenance.json", "ash.db-wal", "ash.db-shm",
- scripts/test-restart-lock-owner.mjs:70  if (lock) writeFileSync(join(dir, "ash.db.ash.lock"), JSON.stringify({ version: 1, port, cwd: TMP, token: "t", ...lock }));
- server/scripts/test-chat-navi-data.ts:53  join(data, "server.log"), join(data, "ash.db.ash.lock"), join(data, "skill-calibrations.json"),
- server/scripts/test-rename-compat.ts:7  //   ⑤ 互斥:改名之前的服务只写 `.ash.lock` / `.ash-claim.lock` / `.ash-online.` —— 新版必须被它们挡下,
- server/scripts/test-rename-compat.ts:7  //   ⑤ 互斥:改名之前的服务只写 `.ash.lock` / `.ash-claim.lock` / `.ash-online.` —— 新版必须被它们挡下,
- server/scripts/test-rename-compat.ts:7  //   ⑤ 互斥:改名之前的服务只写 `.ash.lock` / `.ash-claim.lock` / `.ash-online.` —— 新版必须被它们挡下,
- server/scripts/test-rename-compat.ts:398  // 起手动作的占有锁:旧版只建 `.ash-claim.lock`。
- server/scripts/test-rename-compat.ts:408  // 在线登记:旧版只写 `.ash-online.<pid>.json`。
- server/scripts/test-rename-compat.ts:413  console.log("✓ 互斥:旧版服务的 .ash.lock / .ash-claim.lock / .ash-online. 都挡得住新版;新版两代都持有、两代都放");
- server/scripts/test-rename-compat.ts:413  console.log("✓ 互斥:旧版服务的 .ash.lock / .ash-claim.lock / .ash-online. 都挡得住新版;新版两代都持有、两代都放");
- server/scripts/test-rename-compat.ts:413  console.log("✓ 互斥:旧版服务的 .ash.lock / .ash-claim.lock / .ash-online. 都挡得住新版;新版两代都持有、两代都放");
- server/src/chat/boundary.ts:82  // 请求都动，还有 ash.db 的 -wal/-shm/.ash.lock、scratch/、task-artifacts/、uploads/、runs/。
- server/src/navi-presence.ts:12  // 文件名前缀改过名（`.ash-online.` → `.navi-online.`）：**两个名字都写、两个名字都扫**。改名之前的
- server/src/resource-claim.ts:19  // ③ **新旧两个名字都取**（`.navi-claim.lock` + 改名之前的 `.ash-claim.lock`）：改名之前的服务和
- server/src/singleton.ts:116  * 这份库的单例锁的全部名字：当前名在前，改名之前的 `.ash.lock` 在后。**两个都持有**：改名之前的

## frozen-os-objects（21 处）

冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts

- scripts/test-windows-restart-preservation.mjs:14  const wrapperFile = join(stage, "fixture.ash-agent-wrap.cjs");
- server/scripts/confine-scene-fixture.ts:186  const file = join(tmpdir(), "ash-confine", `ash-agent-stale-fixture.${suffix}`);
- server/scripts/confine-scene-fixture.ts:186  const file = join(tmpdir(), "ash-confine", `ash-agent-stale-fixture.${suffix}`);
- server/scripts/confine-scene-fixture.ts:187  mkdirSync(join(tmpdir(), "ash-confine"), { recursive: true });
- server/scripts/test-accept-gate-prepare.ts:31  const isolated = mkdtempSync(join(tmpdir(), "ash-accept-gate-isolated-"));
- server/scripts/test-accept-gate-prepare.ts:34  const foreign = join(mkdtempSync(join(tmpdir(), "ash-accept-gate-foreign-")), "other", "node_modules");
- server/scripts/test-accept-gate-process.ts:55  confinementId: "Local\\ash-accept-gate-missing", confinementEnrolled: true });
- server/scripts/test-accept-gate-process.ts:134  const jobId = `Local\\ash-accept-gate-${randomUUID()}`;
- server/scripts/test-cleanup-debt.ts:97  const token = `ash-agent-test-alive-${Date.now().toString(36)}`;
- server/scripts/test-cleanup-debt.ts:143  const token = `ash-agent-test-gone-${Date.now().toString(36)}`;
- server/scripts/test-cleanup-debt.ts:234  const token = `ash-agent-test-outfile-${Date.now().toString(36)}`;
- server/scripts/test-cleanup-debt.ts:296  const token = `ash-agent-test-lost-${Date.now().toString(36)}`;
- server/scripts/test-cleanup-debt.ts:441  const token = `ash-agent-test-throw-${Date.now().toString(36)}`;
- server/scripts/test-cleanup-debt.ts:502  unitToken: `ash-agent-test-authz-${Date.now().toString(36)}`,
- server/scripts/test-cleanup-debt.ts:540  const token = `ash-agent-test-liveroot-${Date.now().toString(36)}`;
- server/scripts/test-cleanup-pending.ts:52  const token = `ash-agent-test-pending-${Date.now().toString(36)}`;
- server/scripts/test-cleanup-pending.ts:94  const token = `ash-agent-test-weaker-${Date.now().toString(36)}`;
- server/scripts/test-kernel-confine.ts:193  const token = `ash-agent-test-${process.pid.toString(36)}-${Date.now().toString(36)}`;
- server/scripts/test-kernel-confine.ts:426  const home = mkdtempSync(join(tmpdir(), "ash-confine-e2e-"));
- server/scripts/test-windows-detached.ts:98  writeFileSync(preload, 'if(process.argv[1]?.endsWith(".ash-agent-wrap.cjs")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,12000);');
- server/src/executors/confine-job.ts:33  //     read_after_cleanup={"kind":"absent","why":"Job Object Local\\ash-agent-… 查不到"}

## mac-launcher-env（18 处）

mac 启动器交给服务端的旧名（假服务读到的、rc 文件里导出的），见 ServerLauncher.swift

- desktop/macos/Sources/ServerLauncher.swift:4  /// `ASH_DATA_DIR`，带 `ASH_LOCAL_ONLY=1`（只听 127.0.0.1、固定自用模式）。
- desktop/macos/Sources/ServerLauncher.swift:4  /// `ASH_DATA_DIR`，带 `ASH_LOCAL_ONLY=1`（只听 127.0.0.1、固定自用模式）。
- desktop/macos/Sources/ServerLauncher.swift:146  // export 过的 ASH_DATA_DIR、PORT、ASH_LOCAL_ONLY 会盖掉事先放进环境的值 —— 所以 app 定下的这几样
- desktop/macos/Sources/ServerLauncher.swift:146  // export 过的 ASH_DATA_DIR、PORT、ASH_LOCAL_ONLY 会盖掉事先放进环境的值 —— 所以 app 定下的这几样
- desktop/macos/Sources/ServerLauncher.swift:148  // ASH_DATA_DIR / ASH_LOCAL_ONLY / ASH_WINDOW_PORT（窗口专用端口）是给 server 的，它读完就从自己的
- desktop/macos/Sources/ServerLauncher.swift:148  // ASH_DATA_DIR / ASH_LOCAL_ONLY / ASH_WINDOW_PORT（窗口专用端口）是给 server 的，它读完就从自己的
- desktop/macos/Sources/ServerLauncher.swift:148  // ASH_DATA_DIR / ASH_LOCAL_ONLY / ASH_WINDOW_PORT（窗口专用端口）是给 server 的，它读完就从自己的
- desktop/macos/Sources/ServerLauncher.swift:155  let script = "builtin cd -- \(data) && exec /usr/bin/env -u PORT ASH_DATA_DIR=\(data) ASH_LOCAL_ONLY=1"
- desktop/macos/Sources/ServerLauncher.swift:155  let script = "builtin cd -- \(data) && exec /usr/bin/env -u PORT ASH_DATA_DIR=\(data) ASH_LOCAL_ONLY=1"
- desktop/macos/Sources/ServerLauncher.swift:156  + " ASH_WINDOW_PORT=\(NaviConfig.windowPort)\(port) "
- scripts/test-macos-client.mjs:99  const dataDir=process.env.ASH_DATA_DIR;
- scripts/test-macos-client.mjs:100  fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({cwd:process.cwd(),dataDir,localOnly:process.env.ASH_LOCAL_ONLY??null,
- scripts/test-macos-client.mjs:101  port:process.env.PORT??null,windowPort:process.env.ASH_WINDOW_PORT??null,leaked:Object.keys(process.env).filter(k=>k.startsWith('NAVI_MAC_'))}));
- scripts/test-macos-client.mjs:106  localOnly:process.env.ASH_LOCAL_ONLY==='1',windowPort:Number(process.env.ASH_WINDOW_PORT)}}));})
- scripts/test-macos-client.mjs:106  localOnly:process.env.ASH_LOCAL_ONLY==='1',windowPort:Number(process.env.ASH_WINDOW_PORT)}}));})
- scripts/test-macos-client.mjs:297  const rc = `export ASH_DATA_DIR=${join(temporary, "dev-data")} PORT=1 ASH_LOCAL_ONLY=0 ASH_WINDOW_PORT=1\nalias cd=false\n`;
- scripts/test-macos-client.mjs:297  const rc = `export ASH_DATA_DIR=${join(temporary, "dev-data")} PORT=1 ASH_LOCAL_ONLY=0 ASH_WINDOW_PORT=1\nalias cd=false\n`;
- scripts/test-macos-client.mjs:297  const rc = `export ASH_DATA_DIR=${join(temporary, "dev-data")} PORT=1 ASH_LOCAL_ONLY=0 ASH_WINDOW_PORT=1\nalias cd=false\n`;

## windows-box-path（18 处）

Windows 真机上仓库的实际路径（D:\ai_workspace\ash），由机器上的目录决定，不归仓库改

- docs/win-remote.md:77  **落到对端的 `.worktrees/win-remote`,绝不动它的主工作区。** 那台机器上的 `D:\ai_workspace\ash`
- scripts/check-built.mjs:8  //   Error: Cannot find module 'D:\ai_workspace\ash\server\dist\index.js'
- scripts/win-remote/sync.mjs:14  //    `D:\ai_workspace\ash` 是**正在跑着的 navi 自己**,而且有用户没提交的本地改动
- scripts/win-remote/sync.mjs:49  * D:\...\navi\. 已就绪」、exec 报 `CWD=D:\ai_workspace\ash`,都 exit 0。
- scripts/workspace-check.mjs:98  * 说「重新解一次包」同样没用。2026-08-20 那台机器上出事的是 D:\ai_workspace\ash,
- server/scripts/test-cleanup-ownership.ts:295  const winRoot = "D:\\ai_workspace\\ash";
- server/scripts/test-handoff-local.ts:105  const winUpPath = `D:\\ai_workspace\\ash\\data\\uploads\\${winUpName}`;
- server/scripts/test-handoff-local.ts:198  const backPath = `D:\\ai_workspace\\ash\\data\\uploads\\${backName}`;
- server/scripts/test-navi-mcp-inject.ts:182  args: ["D:\\ai_workspace\\ash\\mcp\\dist\\index.js"],
- server/scripts/test-navi-mcp-inject.ts:190  + 'args=["D:\\\\ai_workspace\\\\ash\\\\mcp\\\\dist\\\\index.js"],'
- server/scripts/test-review-sweep.ts:346  reportPath: `D:\\ai_workspace\\ash\\data\\runs\\T\\free-review\\run-${index + 1}\\round-1\\report.md`,
- server/scripts/test-review-sweep.ts:351  /另有 \d+ 份没有列出，在 D:\\ai_workspace\\ash\\data\\runs\\T\\free-review 下/,
- web/scripts/test-turn-images.mjs:352  ["D:/ai_workspace/ash/output/shot.png?v=2", "D:/ai_workspace/ash/output/shot.png"],
- web/scripts/test-turn-images.mjs:352  ["D:/ai_workspace/ash/output/shot.png?v=2", "D:/ai_workspace/ash/output/shot.png"],
- web/scripts/test-turn-images.mjs:356  ["D:/ai_workspace/ash/output/shot.png", "D:/ai_workspace/ash/output/shot.png"],
- web/scripts/test-turn-images.mjs:356  ["D:/ai_workspace/ash/output/shot.png", "D:/ai_workspace/ash/output/shot.png"],
- web/scripts/test-turn-images.mjs:357  ["D:\\ai_workspace\\ash\\output\\shot.png", "D:\\ai_workspace\\ash\\output\\shot.png"],
- web/scripts/test-turn-images.mjs:357  ["D:\\ai_workspace\\ash\\output\\shot.png", "D:\\ai_workspace\\ash\\output\\shot.png"],

## legacy-persisted-text（17 处）

认老记录的正则：界面现在说 Navi、改名前落盘的写 ash，两代都认

- server/scripts/test-session-lost.ts:293  const ROTATION_NOTE = "ash 已清掉这条会话的恢复字段：下一次运行会开一条全新会话。";
- shared/src/accept-gate.ts:92  export const ACCEPT_GATE_FAILURE_LEGACY_LABELS: readonly string[] = ["ash 重启,这次没跑完"];
- shared/src/session-notes.ts:86  + "ash 已经把这个失效的 id 清掉：再点一次运行会开一条**全新会话**，"
- shared/src/session-notes.ts:94  + "ash 已清掉这条会话的恢复字段：下一次运行会从任务正文自动开启一条**全新会话**，"
- shared/src/session-notes.ts:101  const preRename = (note: string) => note.split("Navi 已").join("ash 已");
- web/scripts/fixtures/conversation-notes.tsx:41  + "ash 已经把这个失效的 id 清掉：再点一次运行会开一条**全新会话**，"
- web/scripts/test-conversation-notes.mjs:57  assert.equal(legacy("本回合被 ash 主动终止:上游连不上", "notice").tier, "alert", "被 navi 判失败的结算说明要你知道");
- web/scripts/test-conversation-notes.mjs:97  "验收前置命令 `sleep 999` 被打断：ash 重启,这次没跑完。 命令跑了 30 分钟才退出",
- web/scripts/test-conversation-notes.mjs:338  + "ash 已清掉这条会话的恢复字段：下一次运行会从任务正文自动开启一条**全新会话**，"
- web/scripts/test-conversation-notes.mjs:343  + "ash 已经把这个失效的 id 清掉：再点一次运行会开一条**全新会话**，"
- web/scripts/test-conversation-notes.mjs:361  const preRename = current.split("Navi 已").join("ash 已");
- web/src/task-detail/HandoffReturnView.tsx:16  const raw = (message ?? "").replace(/^连不上对端 (?:Navi|ash)（[^）]*）[:：]\s*/, "").trim();
- web/src/task-detail/legacyNoticeTable.ts:36  export const CHANNEL_GAP_GUESS = /^这一轮的审查报告可能已经写完了，只是结论没能上报到 (?:Navi|ash)/;
- web/src/task-detail/legacyNoticeTable.ts:69  /^(?:Navi|ash) 重启后继续核对验收前置命令/, // accept-gate-recover
- web/src/task-detail/legacyNoticeTable.ts:200  /^本回合被 (?:Navi|ash) 主动终止/, // 熔断
- web/src/task-detail/legacyNoticeTable.ts:201  /^本回合是上次 (?:Navi|ash) 中断时留下的/, // 读不出熔断判决
- web/src/task-detail/legacyNoticeTable.ts:203  /^(?:Navi|ash) 重启接管时读不出这个进程之前的输出/,

## frozen-git-identity（12 处）

冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts；没填邮箱的人一直署这个域，合成的对比基准提交落款不变

- server/scripts/e2e-opencode-navi-mcp.ts:85  git("config", "user.email", "e2e@ash.local");
- server/scripts/test-rename-compat.ts:280  assert.equal(SYNTHETIC_COMMIT_IDENTITY_ENV.GIT_COMMITTER_EMAIL, "ash@localhost");
- server/scripts/test-rename-compat.ts:281  assert.equal(SYNTHETIC_COMMIT_MESSAGE, "ash: 任务改动的对比基准");
- server/scripts/test-rename-compat.ts:284  assert.equal(suggestGitEmail("Zhang San"), "zhang-san@ash.local", "没填邮箱的人一直署这个域,不随改名换");
- shared/src/multiuser.ts:217  * 每一个中文名用户都拿到同一个 `user@ash.local`,而这一列存在的全部理由就是让
- web/scripts/fixtures/create-project-scope.tsx:44  gitEmail: "xiaocai@ash.local",
- web/scripts/fixtures/project-member-role.tsx:29  gitEmail: `${u.id}@ash.local`,
- web/scripts/fixtures/ui-polish.html:51  <label class="auth-field"><span>git 邮箱</span><input class="ui-input" placeholder="zhangsan@ash.local" /></label>
- web/scripts/fixtures/users-role.tsx:23  gitEmail: `${over.id}@ash.local`,
- web/src/auth/MultiModeForm.tsx:152  placeholder={adminName ? suggestGitEmail(adminName, dirName) : "zhangsan@ash.local"}
- web/src/settings/AccountSettings.tsx:130  placeholder={`${user.dirName}@ash.local`}
- web/src/settings/UsersSettings.tsx:248  placeholder={name ? suggestGitEmail(name, dirName) : "lisi@ash.local"}

## frozen-git-refs（9 处）

冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts

- server/scripts/base-update-recovery-fixtures.ts:38  if (mode === "legacy-gc") git(pending.repo, "update-ref", "-d", `refs/ash/base-update-backups/${pending.child.id}/prepared-${intent.rebased}`);
- server/scripts/test-base-update-recovery.ts:183  const preparedRef = `refs/ash/base-update-backups/${s.child.task.id}/prepared-${intent.rebased}`;
- server/scripts/test-branch-acceptance.ts:330  assert.ok(git(s.repo, "rev-parse", `refs/ash/task-bases/${s.parent.id}`));
- server/scripts/test-branch-acceptance.ts:489  assert.equal(git(s.repo, "for-each-ref", "--format=%(refname)", `refs/ash/task-bases/${s.parent.id}`, `refs/ash/accepted-heads/${s.parent.id}`), "");
- server/scripts/test-branch-acceptance.ts:489  assert.equal(git(s.repo, "for-each-ref", "--format=%(refname)", `refs/ash/task-bases/${s.parent.id}`, `refs/ash/accepted-heads/${s.parent.id}`), "");
- server/src/prerequisite-standing.ts:60  * 那些也读不到（换过克隆，`refs/ash/*` 和压缩前的源提交都不在了）就取验收合入的那个提交 —— 它在目标分支上，
- web/scripts/base-update-recovery-checks.mjs:131  ensure((await dialog.innerText()).includes(`refs/ash/base-update-backups/${task}/`), "manual dialog must expose real existing backup coordinates");
- web/scripts/test-git-workbench-review.mjs:363  const backupRef = "refs/ash-backup/browser-review";
- web/scripts/test-git-workbench-review.mjs:407  await deleteDialog.getByLabel("输入目标以确认").fill("refs/ash-backup/wrong");

## frozen-handoff（8 处）

冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts

- scripts/human-approval.mjs:8  const PURPOSE = "ash-human-approval-v1";
- server/scripts/test-handoff-auth.ts:295  const canonical = ["ash-handoff-v1", "POST", "/api/handoff/import", staleTs, staleNonce, bodyHash].join("\n");
- server/scripts/test-handoff-auth.ts:318  "ash-handoff-v1", "POST", `/api${path}`, ts, nonce,
- server/scripts/test-handoff-auth.ts:335  "ash-handoff-v1", "POST", "/api/handoff/import", sTs, sNonce,
- server/scripts/test-handoff-auth.ts:367  "ash-handoff-v1", "GET", pingPath, pTs, pNonce,
- server/scripts/test-handoff-auth.ts:410  "ash-handoff-v1", "POST", "/api/handoff/proxy/task/snapshot", foreignSnapshotTs, foreignSnapshotNonce,
- server/scripts/test-handoff-auth.ts:435  "ash-handoff-v1", "POST", "/api/handoff/import", sTs, `${sNonce}b`,
- server/scripts/test-handoff-payload.ts:87  assert.ok(encBody.subarray(0, 8).equals(Buffer.from("ash-enc1")), "线上传的应该是加密信封");

## legacy-mcp-name-test（7 处）

专测历史登记名 ash 的用例（用例名里写着「历史名 ash」）

- server/scripts/mcp-load-switch-cases.ts:209  ["excluded 只列着历史名 ash、压根没登记", { mcp: { excluded: ["ash"] } }, "absent"],
- server/scripts/mcp-load-switch-cases.ts:209  ["excluded 只列着历史名 ash、压根没登记", { mcp: { excluded: ["ash"] } }, "absent"],
- server/scripts/mcp-load-switch-cases.ts:210  ["白名单里只有历史名 ash、压根没登记", { mcp: { allowed: ["ash"] } }, "disabled"],
- server/scripts/mcp-load-switch-cases.ts:210  ["白名单里只有历史名 ash、压根没登记", { mcp: { allowed: ["ash"] } }, "disabled"],
- server/scripts/mcp-multi-source-cases.ts:324  ["allowed 白名单里没有规范名(只有历史名 ash)", { mcp: { allowed: ["ash", "other"] } }],
- server/scripts/mcp-multi-source-cases.ts:324  ["allowed 白名单里没有规范名(只有历史名 ash)", { mcp: { allowed: ["ash", "other"] } }],
- server/scripts/test-navi-mcp-registry.ts:472  mcpServers: { ash: { command: "a", disabled: true }, harness: { command: "b", enabled: false } },

## client-to-older-server（6 处）

独立发版的客户端（mac 应用 / 手机 app）发给服务端的旧名：对面可能还是旧版，新版服务端两代都认

- desktop/macos/Sources/HostMcpSetup.swift:64  request.setValue(instance, forHTTPHeaderField: "x-ash-instance")
- desktop/macos/Sources/RestartImpact.swift:88  if let token = hostToken() { request.setValue(token, forHTTPHeaderField: "x-ash-host-token") }
- desktop/macos/Sources/RestartImpact.swift:89  if let instance { request.setValue(instance, forHTTPHeaderField: "x-ash-instance") }
- mobile/src/lib/api.ts:190  headers: { "x-ash-user-action": "1" },
- scripts/macos-client-guard.mjs:38  const cookie = /(?:^|;\s*)ash_instance=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? request.headers["x-ash-instance"] ?? null;
- scripts/test-macos-update.mjs:77  if (req.headers['x-ash-instance'] !== id) { res.statusCode = 409; return res.end('{"error":"不是这一份"}'); }

## legacy-env-fallback（5 处）

读环境变量时新名优先、退到改名前的旧名（脚本、mac 应用的启动与构建配置）

- desktop/macos/build.sh:34  BOOK_OVERRIDE="${NAVI_MAC_BUILD_NUMBER_FILE:-${ASH_MAC_BUILD_NUMBER_FILE:-}}"
- desktop/macos/build.sh:39  BUILD_NUMBER="${NAVI_MAC_BUILD_NUMBER:-${ASH_MAC_BUILD_NUMBER:-}}"
- desktop/macos/build.sh:42  BUNDLE_ID="${NAVI_MAC_BUNDLE_ID:-${ASH_MAC_BUNDLE_ID:-}}"
- desktop/macos/build.sh:52  FEED_URL="${NAVI_MAC_FEED_URL:-${ASH_MAC_FEED_URL:-}}"
- desktop/macos/build.sh:54  ED_KEY="${NAVI_MAC_ED_PUBLIC_KEY:-${ASH_MAC_ED_PUBLIC_KEY:-}}"

## frozen-codex-relay（4 处）

冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts

- server/scripts/test-codex-provider.ts:15  const actorHeader = 'model_providers.ash_relay.http_headers.x-openai-actor-authorization="codex-imagegen-enabled"';
- server/scripts/test-codex-provider.ts:35  assert.ok(wiring.args!.includes('model_providers.ash_relay.env_key="NAVI_RELAY_KEY"'));
- server/scripts/test-codex-provider.ts:36  assert.ok(wiring.args!.includes('model_providers.ash_relay.wire_api="responses"'));
- server/scripts/test-codex-provider.ts:40  assert.ok(wiring.args!.includes(`model_providers.ash_relay.base_url="${expectedBase}"`));

## frozen-monitor-kind-dto（4 处）

冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts（缺 kind 的旧 DTO 归一成 ash 哨兵）

- web/scripts/test-monitor-inspector.tsx:230  // 也数不到事件数。画成和 ash 哨兵一样的后果是用户去点一个注定失败的停止按钮，再把恒为 0
- web/scripts/test-monitor-inspector.tsx:444  // 后端还没更新的那段混合部署里，旧后端只会发 ash 哨兵，所以补 "ash" 是确定的（第 13 轮
- web/scripts/test-monitor-inspector.tsx:444  // 后端还没更新的那段混合部署里，旧后端只会发 ash 哨兵，所以补 "ash" 是确定的（第 13 轮
- web/scripts/test-monitor-inspector.tsx:448  assert.equal(normalizeMonitorDto(legacy).kind, "ash", "缺 kind 的旧 DTO 要归一成 ash");

## github-legacy-repo（3 处）

GitHub 上改名前的仓库名（release.json 的 legacyReleaseRepo、旧 appcast 的 XML 命名空间）

- desktop/macos/README.md:42  - **安装包**在 [noroot777/navi](https://github.com/noroot777/navi)（`releaseRepo`；GitHub 上要先从 noroot777/ash 改名过来，没改名时发版脚本会拦下、不去新建）：tag 为 `navi-mac-v<版本>-<构建号>` 的 Git
- desktop/macos/release.json:4  "legacyReleaseRepo": "noroot777/ash",
- desktop/macos/scripts/appcast.mjs:87  `<rss version="2.0" xmlns:sparkle="${SPARKLE_NS}" xmlns:navi="https://github.com/noroot777/navi" xmlns:ash="https://github.com/noroot777/ash">`,

## mac-legacy-app-prompt（3 处）

说的是改名前的 Ash.app（没接过它的登录和页面设置时的提示）

- desktop/macos/Sources/AppDelegate.swift:28  alert.messageText = "还没接过 Ash 的登录和页面设置"
- desktop/macos/Sources/AppDelegate.swift:29  alert.informativeText = "\(blocked)\n\n现在不接直接打开的话，Ash 里的登录、草稿和页面设置就不再接过来了（Ash 那份原样留着）。"
- desktop/macos/Sources/AppDelegate.swift:29  alert.informativeText = "\(blocked)\n\n现在不接直接打开的话，Ash 里的登录、草稿和页面设置就不再接过来了（Ash 那份原样留着）。"

## brand-check-message（2 处）

界面文字残留检查的报错：说的是要找的旧产品名

- scripts/check-conventions.mjs:243  console.error(`\n✗ 给人看的文字里还有旧产品名 ash（${brandHits.length} 处）：`);
- scripts/check-conventions.mjs:245  console.error("   界面上的产品名是 Navi（全大写的字标写 NAVI）；仍叫 ash 的标识符照写，判据见 scripts/check-brand-text.mjs。\n");

## legacy-log-tag（2 处）

预览脚本自述那一行故意打旧前缀 [ash]（LEGACY_LOG_TAG：拉起预览的可能还是改名前的服务）

- server/scripts/test-preview-host-api.ts:83  assert.match(log, new RegExp(`\\[ash\\] preview-api-host 127\\.0\\.0\\.1:${address.port}\\b`), `自述必须指向 ${address.port}\n${log.slice(0, 600)}`);
- server/scripts/test-preview-host-api.ts:130  assert.match(stackLog, new RegExp(`\\[ash\\] preview-api-host localhost:${port2}\\b`), "自述报的是它真打过去的那个");

## legacy-branch-prefix（2 处）

改名前的对端只认 ash/ 开头的任务分支（拒绝接力时说给用户的旧事实）

- server/src/handoff-types.ts:361  /** 任务分支的前缀（`navi/`）。改名之前的版本不报这一项，发起方据此知道它只认 `ash/`（见 handoff-wire.ts）。 */
- server/src/handoff-wire.ts:42  return `对端还是改名之前的版本：它只认 ash/ 开头的任务分支，这条任务的分支是 ${branch}，`

## drizzle-env（1 处）

drizzle-kit 的库路径按各代变量名依次认（NAVI_DB → ASH_DB → HARNESS_DB）

- server/drizzle.config.ts:8  url: process.env.NAVI_DB ?? process.env.ASH_DB ?? process.env.HARNESS_DB ?? "./data/ash.db",

## legacy-persisted-text-test（1 处）

老记录里两代产品名都要认：逐个喂进去

- web/scripts/test-conversation-notes.mjs:59  for (const name of ["ash", "Navi"]) {

## qr-test-vector（1 处）

二维码编码的测试向量：期望的摘要按这段输入算出来的，换了输入摘要就对不上

- web/scripts/test-qr.ts:22  ["ash", 0, 21, "a4fa25168f181a5c"],

## rule-file（5 处）

规则文件由人改写（每处多一个字节，脚本不碰，见 scripts/rule-guard.mjs）；这里是改完之后仍留着的

- AGENTS.md:60  跨平台的东西（路径分隔符、PowerShell、原生窗口、`.cmd` 启动）不许只在 macOS 上读代码断言「Windows 应该也对」。那台机器上跑着一套 Navi（`:4317`，仓库 `D:\ai_workspace\ash`），碰了 win32 分支就上去真跑一遍再交付。
- docs/incidents.md:51  单实例守卫只挡「同一个 DB」，**端口撞车是另一条产幽灵的路**：`PORT=4317 ASH_DB=/tmp/x.db` 能顺利拿到 DB 锁，然后在 listen 那步撞死；旧代码里 scheduler 已经先起来了，EADDRINUSE 又被通用兜底接住只打日志不退出，于是留下「没有端口、但调度器在轮询生产 D
- docs/incidents.md:293  用户两次遇到「Navi 服务好像又停了」，手动 `restart` 救回。日志 `/tmp/ash-4317.log` 里对应的痕迹只有两行 `stale singleton lock`（PID 51330、PID 65995），前后都是普通的 llm-relay 记录，中间什么都没有。
- docs/incidents.md:327  `data/ash.db.exits.jsonl` 记着 02:16:50 一次 SIGTERM，6 秒后数据库里 114 行 `updated_at` 被写成 `02:16:56.6～56.8`，**毫秒彼此相差 ~8ms**（逐条写，不是一条 `UPDATE`——同一毫秒才是 bulk SQL，这一条差别就能把「谁
- docs/incidents.md:335  回填口径：**恢复成「这次写之前那一刻的值」**，源按优先级 `data/ash.db.bak-before-updatedat-restore`（2026-10-20；其中 `2026-10-19T13:39:05.339Z` 本身是上一次污染的值，要跳过）→ `data/ash.db.bak-before-dail

## rename-tooling

改名自己的脚本和交付文档：旧名是规则与说明本身，只记数，不逐行列

- scripts/rename-navi.mjs：90 行
- scripts/rename-navi-fixes.mjs：18 行
- scripts/rename-navi-report.mjs：4 行
- scripts/rename-navi-fs.mjs：0 行
- scripts/test-rename-navi.mjs：66 行
- docs/rename-navi.md：24 行

# 二、更早一代 harness（318 处）

## legacy-mcp-name（94 处）

MCP 服务更早一代的登记名 harness：setup 迁成新名、注入检查与多来源解析都认它

- scripts/codex-mcp.mjs:11  // `[mcp_servers.harness.tools.*]` 这类子表留成一条没有 command 的孤儿，codex 整份拒载 —— 新链
- scripts/mcp-host-sources.mjs:119  /** 规范登记名;改名之前的登记名(`ash`、更早的 `harness`)见 legacy-names.mjs,照样认作已登记。 */
- scripts/mcp-host-sources.mjs:351  * 刻意**不折叠**,跟 TS 那份 `shapes.ts` 的 `scan` 一一对应:`ash` 和 `harness` 是两条独立
- scripts/mcp-host-sources.mjs:455  * 赢家,于是「高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着」被判成关着,而真 CLI
- scripts/mcp-hosts.mjs:10  //  · 已有 navi 或历史名 harness 一律不覆盖 —— 用户可能自己改过 URL 或路径;
- scripts/setup.mjs:31  // 改名之前的登记（`ash`、更早的 `harness`）在这里迁成规范名：Navi 起 claude/codex 时注入的是规范名，
- scripts/test-codex-mcp-setup.mjs:17  name: "navi", legacyName: "harness", removeServer: () => assert.fail("不该去删任何登记"),
- scripts/test-codex-mcp-setup.mjs:102  const original = `[mcp_servers.harness]\ncommand = "node"\n[other]\nk = 1\n`;
- scripts/test-codex-mcp-setup.mjs:107  listServers: answers(listed("harness"), listed("navi")),
- scripts/test-codex-mcp-setup.mjs:116  writeFileSync(file, `[mcp_servers.harness]\ncommand = "node"\n`);
- scripts/test-codex-mcp-setup.mjs:123  listServers: answers(listed("harness"), listed("harness", "navi")),
- scripts/test-codex-mcp-setup.mjs:185  const original = `[mcp_servers.harness]\ncommand = "node"\n[other]\nk = 1\n`;
- scripts/test-codex-mcp-setup.mjs:192  listServers: answers(listed("harness"), listed("navi")),
- scripts/test-codex-mcp-setup.mjs:199  assert.ok(!other.includes("harness"), "另一端的旧名也没了");
- scripts/test-codex-mcp-setup.mjs:257  `model = "x"\n\n[mcp_servers.harness]\ncommand = "node"\nargs = ["/x.js"]\n\n[mcp_servers.harness.env]\nNAVI_URL = "u"\n\n`
- scripts/test-codex-mcp-setup.mjs:258  + `[mcp_servers.harness.tools.get_task]\napproval_mode = "approve"\n\n[mcp_servers.kb]\ncommand = "uv"\n`,
- scripts/test-codex-mcp-setup.mjs:259  `  [mcp_servers."harness"]\n  command = "node"\n[mcp_servers."harness".env]\nNAVI_URL = "u"\n[mcp_servers.kb]\ncommand = "uv"\n`,
- scripts/test-codex-mcp-setup.mjs:271  writeFileSync(cfg, `[mcp_servers.harness]\ncommand = "node"\nargs = ["/x.js"]\n\n[mcp_servers.kb]\ncommand = "uv"\n`);
- scripts/test-codex-mcp-setup.mjs:279  assert.ok(!readFileSync(twin, "utf8").includes("harness"), "另一端的旧名也没了");
- scripts/test-kimi-mcp.mjs:27  for (const name of [NAVI, "ash", "harness"]) {
- server/scripts/mcp-sources-cases.ts:146  // ── ⑱ 逐名跨来源解析:`ash` 和 `harness` 是两条独立登记(本轮审查 F3)──────────
- server/scripts/mcp-sources-cases.ts:151  // ⒜ 审查那条复现:高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着 ⇒ 真 CLI
- server/scripts/mcp-sources-cases.ts:152  //    那边工具**连得上**(两个名字各是一条登记,ash 的工具由 harness 那条提供)。
- server/scripts/mcp-sources-cases.ts:162  assert.equal(stA.state, "present", `两个名字各算一次,harness 那条是开着的:${stA.detail}`);
- server/scripts/mcp-sources-cases.ts:163  assert.equal(stA.serverName, "harness", "说清生效的是哪一条(用户要去看的就是它)");
- server/scripts/mcp-sources-cases.ts:167  assert.ok(rA.ok && rA.serverName === "harness", `已经接好了就别再写:${rA.ok ? rA.serverName : rA.why}`);
- server/scripts/mcp-sources-cases.ts:171  // ⒝ 同一个选中结果要**喂给搬运**:宿主那份里 `ash` 关着(指向 /off.js)、`harness` 开着
- server/scripts/mcp-sources-cases.ts:172  //    (指向 /live.js,底下还挂着子表)⇒ 隔离档里补出来的那条必须是 harness 那段的内容。
- server/scripts/mcp-sources-cases.ts:180  + '[mcp_servers.harness]\ncommand = "node"\nargs = ["/live.js"]\n\n'
- server/scripts/mcp-sources-cases.ts:181  + '[mcp_servers.harness.tools.get_task]\napproval_mode = "approve"\n', "utf8");
- server/scripts/mcp-sources-cases.ts:192  // ⒞ 诊断提示跟判定取**同一条**登记:`ash` 关着(/old.js)、`harness` 开着(/live.js)
- server/scripts/mcp-sources-cases.ts:199  harness: { ...OC_ENTRY, command: ["node", "/live.js"] },
- server/scripts/navi-mcp-real-cli-cases.ts:144  const legacy = `[mcp_servers.harness]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(stub)}, "legacy", "get_task"]\n`;
- server/scripts/navi-mcp-real-cli-cases.ts:148  assert.deepEqual(await probe('[mcp_servers.harness]\ncommand = "/nonexistent/legacy-mcp"\n', full), [], "历史名起不来、注入的那条好好的 ⇒ 不出声");
- server/scripts/test-codex-mcp-turn-token.ts:165  assert.ok(!/mcp_servers\.(ash|harness)[.=]/.test(handle.commandLine), "规范安装不能被历史名盖回去");
- server/scripts/test-navi-mcp-inject.ts:103  // 只认注入的那个名字:历史名(ash、harness)连着也不替它作证
- server/scripts/test-navi-mcp-inject.ts:104  for (const legacy of ["ash", "harness"]) {
- server/scripts/test-navi-mcp-inject.ts:107  assert.match(msg(claudeNaviMcpProblem(ok, [{ ...injected, status: "failed" }, { name: "harness", status: "connected" }], ALL)), /状态是 failed/);
- server/scripts/test-navi-mcp-inject.ts:273  legacyFirst.update({ name: "harness", status: "ready" });
- server/scripts/test-navi-mcp-inject.ts:276  assert.equal(legacyFailed.update({ name: "harness", status: "failed", error: "gone" }), null, "历史名坏了不说 navi 的事");
- server/scripts/test-navi-mcp-installer.ts:171  for (const head of ['[mcp_servers."ash"]', "[mcp_servers.'harness']", "[ mcp_servers . ash ]"]) {
- server/scripts/test-navi-mcp-installer.ts:240  '[mcp_servers.other]\ncommand = "x"\n\n[plugins.demo]\ndisabled_mcp_servers = ["ash", "harness"]\n',
- server/scripts/test-navi-mcp-installer.ts:273  // 已有 ash/harness:一个字节都不动。
- server/scripts/test-navi-mcp-installer.ts:274  for (const name of [NAME, "ash", "harness"]) {
- server/scripts/test-navi-mcp-registry.ts:7  //   ① 已有登记一律不覆盖(含历史名 harness),第三方条目一个字节都不动;
- server/scripts/test-navi-mcp-registry.ts:219  for (const name of [NAME, "ash", "harness"]) {
- server/scripts/test-navi-mcp-registry.ts:247  group("不覆盖已有(含 harness)、不碰第三方条目");
- server/scripts/test-navi-mcp-registry.ts:458  harness: { command: "node", args: ["/live.js"] },
- server/scripts/test-navi-mcp-registry.ts:463  assert.equal(state.serverName, "harness", "报的是实际开着的那个名字");
- server/scripts/test-navi-mcp-registry.ts:465  assert.ok(r.ok && r.serverName === "harness", "补接也认它,别去打开那条关着的");
- server/scripts/test-navi-mcp-registry.ts:472  mcpServers: { ash: { command: "a", disabled: true }, harness: { command: "b", enabled: false } },
- server/scripts/test-navi-mcp-registry.ts:476  assert.match(offState.detail, /ash 这条登记是关着的、harness 这条登记是关着的/,
- server/scripts/test-rename-compat.ts:5  //   ③ MCP 登记名 / 工具名:navi、ash、harness 三代都认;
- server/scripts/test-rename-compat.ts:109  console.log("✓ MCP:登记名与工具名 navi / ash / harness 三代都认");
- server/scripts/test-user-cli-mcp.ts:25  // 改名之前的登记名：宿主机上旧版 setup 写的是 `ash`（再早是 `harness`）。已有这条就不再补；搬进个人目录、
- server/scripts/test-user-cli-mcp.ts:27  const [ASH, HARNESS] = LEGACY_MCP_SERVER_NAMES;
- server/scripts/test-user-cli-mcp.ts:70  // ④ 已有登记不覆盖 —— 包括历史名 harness(用户可能自己改过 URL / 路径)。
- server/scripts/test-user-cli-mcp.ts:74  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { harness: mine } }), "utf8");
- server/scripts/test-user-cli-mcp.ts:76  assert.equal(state.serverName, HARNESS, "历史名也算已登记");
- server/scripts/test-user-cli-mcp.ts:78  assert.deepEqual(doc.mcpServers.harness, mine, "用户改过的定义不许动");
- server/scripts/test-user-cli-mcp.ts:129  const { host, dir } = bench({ codex: `[mcp_servers.harness]\ncommand = "node"\nargs = ["/old/index.js"]\n` });
- server/scripts/test-user-cli-mcp.ts:167  extractTomlTables(`[mcp_servers.'harness']\ncommand = "node"\n`, HARNESS, NAME),
- server/src/auth/user-cli-mcp.ts:29  //  · **已有登记一律不覆盖**(含历史名 `harness`)——用户可能自己改过 URL 或路径。
- server/src/codex-toml.ts:55  * **兜底**：扫描器没认出任何登记、可文本里明明有 `mcp_servers.ash` / `mcp_servers.harness`
- server/src/executors/catalog/README.md:281  **压根没登记时也要如实说「被挡住了」**(没登记的名字里只问规范名 —— 历史名 `harness` 不在
- server/src/executors/navi-mcp-confirm.ts:4  //  1. **连上的是注入的那一份**。只认本名 `navi`：历史名 `harness` 是用户自己配置里的登记，指着
- server/src/executors/navi-mcp-inject.ts:20  //    历史名 `harness` 不碰：给不存在的表写 `enabled=false` 会让 codex 拒载整份配置。
- server/src/mcp-registry/register.ts:14  //  · **已有登记一律不覆盖**,含历史名 `harness`(用户可能自己改过 URL 或路径);
- server/src/mcp-registry/register.ts:252  // 宿主那条**原值照搬**(规范名落地:即使它在宿主那边叫历史名 harness,搬过来也按 navi 登记 ——
- server/src/mcp-registry/shapes.ts:8  //  ① **已有登记一律不覆盖**,含历史名 `harness` —— 用户可能自己改过路径或 URL;
- server/src/mcp-registry/shapes.ts:20  /** 认的服务名(当前名 `navi`、历史名 `ash` / `harness`)—— **各自独立的登记**,顺序就是优先。 */
- server/src/mcp-registry/shapes.ts:57  * 两个兼容名是两条独立登记,所以**先找开着的那条**:`ash` 关着、`harness` 开着时 CLI 那边
- server/src/mcp-registry/shapes.ts:193  // 没登记的名字里**只问规范名**:它才是 navi 会去写的那个。历史名 `harness` 没在白名单
- server/src/mcp-registry/shapes.ts:265  * 规范名落地:宿主那份即使叫历史名 harness,搬过来也按 navi 登记(两边都叫 navi 之后,提示词
- server/src/mcp-registry/sources.ts:265  * **逐个兼容名各算一次**(上一轮审查 F3):`ash` 和 `harness` 是两条独立登记。更早一版先把
- server/src/mcp-registry/sources.ts:267  * 「高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着」被判成 disabled(预检硬拒),
- server/src/mcp-registry/types.ts:32  /** present/disabled 时命中的服务名(可能是历史名 harness)。 */
- server/src/mcp-registry/types.ts:46  * 一个兼容名(`ash` / 历史名 `harness`)在**一份**配置里的事实 —— 刻意**不折叠**。
- server/src/mcp-registry/types.ts:48  * 为什么要有这一层(本轮审查 F3):`ash` 和 `harness` 是**两条独立登记**,一条关着、另一条
- server/src/mcp-registry/types.ts:51  * harness 开着」被判成 disabled(预检硬拒),而真 CLI 那边工具明明连得上。
- server/src/mcp-registry/types.ts:122  * `hostBlock` 按名字固定先挑 `ash`,`read` 挑**开着**的那条,于是 `ash` 关着、`harness`
- server/src/review-channel-gap.ts:10  // 那要靠 MCP server 的名字去认，而名字是各台机器自己配的（本仓历史名 `harness` 至今仍在
- server/src/review-channel-gap.ts:79  *    位置：上一版拿 `\b(ash|harness)\b` 在整行上找，而本仓目录就叫 harness、`~/.ash/…` 这类
- server/src/review-channel-gap.ts:84  * （旧名 `harness` 那份可能正连着、complete_task 就在它手里），也不能证明通道还在。拿这种
- server/src/review-channel-gap.ts:97  * codex 自己报 MCP server 出错时点名的那个位置：``MCP client for `ash` ``、``MCP server 'harness' ``
- server/src/review-channel-gap.ts:112  * `harness` 的装机至今还在跑。这里认两个只影响一句提示文案的措辞，跟「补捞该不该兼容
- shared/src/mcp.ts:8  * 认得出的全部登记名，当前名在前。用户 CLI 配置里旧版 setup 登记的那条（`ash`、更早的 `harness`）、
- shared/src/multiuser.ts:348  /** 实际登记名。历史安装可能仍是 `harness`。 */
- web/scripts/fixtures/turn-fold.tsx:26  { id: "s4", markdown: "", events: [{ kind: "tool", label: "mcp__harness__complete_task" }], attachments: [] },
- web/scripts/test-turn-fold.mjs:40  segment("b", { events: [tool("mcp__harness__complete_task")] }),
- web/scripts/test-turn-fold.mjs:46  assert.equal(labels(process), "Bash,mcp__harness__complete_task");
- web/scripts/test-turn-fold.mjs:52  "mcp__harness__complete_task",
- web/scripts/test-turn-fold.mjs:79  segment("b", { events: [tool("mcp__harness__dispatch")], markdown: "已派 3 个执行者。" }),
- web/scripts/test-turn-fold.mjs:97  segment("b", { events: [tool("mcp__harness__complete_task")] }),

## test-harness-word（61 处）

英文词 test harness（测试台子）：文件名、函数名里的这个词不是产品名

- mobile/scripts/test-monitor-strip.mjs:43  function Harness() {
- mobile/scripts/test-monitor-strip.mjs:55  createRoot(document.getElementById("app")).render(<Harness />);
- server/scripts/accept-gate-baseline-fixture.ts:4  // 一切 src 模块都在 `baselineHarness` 里动态载入。
- server/scripts/accept-gate-baseline-fixture.ts:13  export async function baselineHarness(prefix: string) {
- server/scripts/free-review-dispatch-harness.ts:30  export async function startHarness() {
- server/scripts/monitor-complete-checkpoint-groups.ts:6  // （`monitor-complete-gate-harness.ts`），由那份脚本按顺序驱动 —— 合在一个文件里是 706 行，
- server/scripts/monitor-complete-checkpoint-groups.ts:18  } from "./monitor-complete-gate-harness.js";
- server/scripts/monitor-result-handoff-groups.ts:6  // 是「责任在路上的每一刻都有人认」。三份共用同一套台子（`monitor-complete-gate-harness.ts`），
- server/scripts/monitor-result-handoff-groups.ts:14  } from "./monitor-complete-gate-harness.js";
- server/scripts/monitor-settle-landing-groups.ts:15  // 「哪几支落位之前该去问」。两份共用同一套台子（`monitor-complete-gate-harness.ts`），由那份
- server/scripts/monitor-settle-landing-groups.ts:23  } from "./monitor-complete-gate-harness.js";
- server/scripts/test-accept-gate-baseline-landing.ts:10  const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
- server/scripts/test-accept-gate-baseline-landing.ts:12  commitOnMain, fixture, settled, testedPhysical } = await baselineHarness("navi-gate-landing-");
- server/scripts/test-accept-gate-baseline.ts:16  const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
- server/scripts/test-accept-gate-baseline.ts:17  const h = await baselineHarness("navi-gate-baseline-");
- server/scripts/test-accept-gate-conflict-handoff.ts:18  const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
- server/scripts/test-accept-gate-conflict-handoff.ts:19  const h = await baselineHarness("navi-gate-conflict-handoff-");
- server/scripts/test-accept-gate-handoff-verdict.ts:18  import { root, startHarness } from "./free-review-dispatch-harness.js";
- server/scripts/test-accept-gate-handoff-verdict.ts:26  const { db, tasks, freeTask, timeline, until, turnIdentity } = await startHarness();
- server/scripts/test-free-review-dispatch-delivery.ts:3  // 跟隔壁两份的分工(台子是同一个,`free-review-dispatch-harness.ts`):
- server/scripts/test-free-review-dispatch-delivery.ts:22  import { root, startHarness } from "./free-review-dispatch-harness.js";
- server/scripts/test-free-review-dispatch-delivery.ts:26  // 台子(临时库、桩、种子数据、夹具)都在 `free-review-dispatch-harness.ts`。
- server/scripts/test-free-review-dispatch-delivery.ts:33  } = await startHarness();
- server/scripts/test-free-review-dispatch-ownership.ts:4  // 台子是同一个(`free-review-dispatch-harness.ts`)。这一份只管一件事:同一个 round 行会被用户
- server/scripts/test-free-review-dispatch-ownership.ts:36  import { root, startHarness } from "./free-review-dispatch-harness.js";
- server/scripts/test-free-review-dispatch-ownership.ts:40  // 台子(临时库、桩、种子数据、夹具)都在 `free-review-dispatch-harness.ts`。
- server/scripts/test-free-review-dispatch-ownership.ts:52  } = await startHarness();
- server/scripts/test-free-review-dispatch-retry.ts:9  // 十三条用例对着验收标准(台子在 `free-review-dispatch-harness.ts`):
- server/scripts/test-free-review-dispatch-retry.ts:35  import { root, startHarness } from "./free-review-dispatch-harness.js";
- server/scripts/test-free-review-dispatch-retry.ts:39  // 台子(临时库、桩、种子数据、夹具)都在 `free-review-dispatch-harness.ts`。
- server/scripts/test-free-review-dispatch-retry.ts:50  } = await startHarness();
- server/scripts/test-idle-delivery-verdict.ts:37  import { root, startHarness } from "./free-review-dispatch-harness.js";
- server/scripts/test-idle-delivery-verdict.ts:59  } = await startHarness();
- server/scripts/test-late-refusal-identity.ts:24  import { root, startHarness } from "./free-review-dispatch-harness.js";
- server/scripts/test-late-refusal-identity.ts:30  const harness = await startHarness();
- server/scripts/test-late-refusal-identity.ts:31  const { db, tasks, until, runOf, roundOf, timeline, turnIdentity, reviewDispatchArmed, finish } = harness;
- server/scripts/test-late-refusal-identity.ts:70  await harness.armedTask(id);
- server/scripts/test-late-refusal-identity.ts:71  await harness.handleFreeWorkflowSettlement(id, "done", true, true, "single");
- server/scripts/test-late-refusal-identity.ts:72  harness.releaseTurn(id, undefined);
- server/scripts/test-monitor-complete-gate.ts:38  } from "./monitor-complete-gate-harness.js";
- web/scripts/monitor-dom-harness.mjs:46  export async function openHarness() {
- web/scripts/test-catch-up.mjs:18  function harness(overrides = {}) {
- web/scripts/test-catch-up.mjs:66  const h = harness();
- web/scripts/test-catch-up.mjs:83  const h = harness();
- web/scripts/test-catch-up.mjs:97  const h = harness();
- web/scripts/test-catch-up.mjs:110  const h = harness();
- web/scripts/test-catch-up.mjs:130  const h = harness();
- web/scripts/test-catch-up.mjs:151  const h = harness();
- web/scripts/test-catch-up.mjs:166  const h = harness();
- web/scripts/test-catch-up.mjs:183  const h = harness();
- web/scripts/test-catch-up.mjs:193  const h = harness();
- web/scripts/test-catch-up.mjs:207  const h = harness();
- web/scripts/test-catch-up.mjs:228  const h = harness();
- web/scripts/test-catch-up.mjs:240  const h = harness();
- web/scripts/test-catch-up.mjs:255  const h = harness({ retry: () => null });
- web/scripts/test-monitor-composer-dom.mjs:4  // （`monitor-dom-harness.mjs`）。这一格的用例非得真浏览器不可,原因不是布局:**判据在每次渲染
- web/scripts/test-monitor-composer-dom.mjs:11  import { openHarness } from "./monitor-dom-harness.mjs";
- web/scripts/test-monitor-composer-dom.mjs:13  const { open, waitIds, failures, close } = await openHarness();
- web/scripts/test-monitor-inspector-dom.mjs:14  // **台子在隔壁**（`monitor-dom-harness.mjs`,全局约定:单文件不超过 700 行）:真 Vite、真
- web/scripts/test-monitor-inspector-dom.mjs:18  import { monitor, openHarness } from "./monitor-dom-harness.mjs";
- web/scripts/test-monitor-inspector-dom.mjs:21  const { open, idsOf, waitIds, failures, close } = await openHarness();

## legacy-env（49 处）

环境变量的更早一代前缀 HARNESS_：读的时候在 NAVI_、ASH_ 之后兜底认（scripts/env.mjs、shared/src/env-names.ts），测试里照旧名喂进去

- mcp/scripts/test-reconnect.mjs:18  ? { HARNESS_URL: `http://localhost:${PORT}`, HARNESS_RECONNECT_MS: String(reconnectMs) }
- mcp/scripts/test-reconnect.mjs:23  delete env.HARNESS_URL;
- mcp/scripts/test-reconnect.mjs:24  delete env.HARNESS_RECONNECT_MS;
- scripts/dev.mjs:82  // 命令现场写的。宿主 navi 自己环境里带着的那份（连同旧名 `HARNESS_PROXY`）由 navi 在组预览子
- scripts/env.mjs:2  // 上几代的 `ASH_X`、`HARNESS_X`；写给子进程只写新名并擦掉旧名；擦就各代一起擦。
- server/drizzle.config.ts:8  url: process.env.NAVI_DB ?? process.env.ASH_DB ?? process.env.HARNESS_DB ?? "./data/ash.db",
- server/scripts/mcp-sources-cases.ts:36  const HARNESS_ON = ocBody({ harness: OC_ENTRY });
- server/scripts/mcp-sources-cases.ts:156  const aGlobal = seedGlobal(a.host, HARNESS_ON);
- server/scripts/mcp-sources-cases.ts:168  assert.equal(readFileSync(aGlobal, "utf8"), HARNESS_ON, "两份都不许动");
- server/scripts/test-claude-retry-stall.ts:32  process.env.HARNESS_DB = process.env.NAVI_DB;
- server/scripts/test-data-root.ts:125  // 旧检出 + 一个已经不存在的 node,外加用户自己的定制和一个只写在 HARNESS_URL 里的远端目标。
- server/scripts/test-data-root.ts:128  env: { HARNESS_URL: "https://remote.example:8443", NAVI_RECONNECT_MS: "7000" } },
- server/scripts/test-data-root.ts:137  'HARNESS_URL = "https://remote.example:8443"',
- server/scripts/test-data-root.ts:264  env: { HARNESS_URL: "https://remote.example:8443", NAVI_RECONNECT_MS: "7000" },
- server/scripts/test-data-root.ts:265  }, "只换脚本入口和跑不起来的 node;cwd/timeout/env(含 HARNESS_URL 远端)原样留着");
- server/scripts/test-data-root.ts:269  'HARNESS_URL = "https://remote.example:8443"', 'NAVI_RECONNECT_MS = "7000"',
- server/scripts/test-data-root.ts:319  + 'HARNESS_URL = "https://r.example" # 原先在 /old/mcp/dist/index.js\n');
- server/scripts/test-duet-stall-visibility.ts:25  process.env.HARNESS_DB = process.env.NAVI_DB;
- server/scripts/test-preview-host-api.ts:15  //   ① 宿主进程继承的、以及登录 shell 从 profile 里读回来的 `ASH_PROXY`/`HARNESS_PROXY`
- server/scripts/test-preview-host-api.ts:42  // 别处（第 7 轮审查 P1）。旧名 `HARNESS_PROXY` 一并预置：scripts/env.mjs 会把 `HARNESS_*`
- server/scripts/test-preview-host-api.ts:45  process.env.HARNESS_PROXY = "http://127.0.0.1:2";
- server/scripts/test-preview-host-api.ts:53  writeFileSync(join(home, ".profile"), "export ASH_PROXY=http://127.0.0.1:5\nexport HARNESS_PROXY=http://127.0.0.1:6\n");
- server/scripts/test-preview-host-api.ts:85  assert(!/127\.0\.0\.1:[1256]\b/.test(log), `父进程带下来的 ASH_PROXY/HARNESS_PROXY 一个字都不该起作用\n${log.slice(0, 600)}`);
- server/scripts/test-rename-compat.ts:71  assert.deepEqual(envNameGenerations("NAVI_DB"), ["NAVI_DB", "ASH_DB", "HARNESS_DB"]);
- server/scripts/test-rename-compat.ts:74  assert.equal(read({ HARNESS_URL: "h" }, "NAVI_URL"), "h", "更早一代的 HARNESS_* 也照旧认");
- server/scripts/test-rename-compat.ts:75  assert.equal(read({ NAVI_URL: "n", ASH_URL: "a", HARNESS_URL: "h" }, "NAVI_URL"), "n", "新名优先");
- server/scripts/test-rename-compat.ts:83  const child: Record<string, string | undefined> = { ASH_DB: "/old", HARNESS_DB: "/older" };
- server/scripts/test-rename-compat.ts:177  const inherited = () => ({ PATH: "/bin", ASH_MONITOR_UNIT: "old-unit", HARNESS_MONITOR_UNIT: "older-unit" });
- server/scripts/test-rename-compat.ts:200  assert.ok("HARNESS_TASK_ID" in env && env.HARNESS_TASK_ID === undefined, "再上一代的不写,继承来的要清掉");
- server/scripts/test-rename-compat.ts:201  const cleared = withoutTurnIdentity({ ...env, HARNESS_TASK_ID: "x" });
- server/scripts/test-rename-compat.ts:202  for (const key of ["NAVI_TASK_ID", "ASH_TASK_ID", "HARNESS_TASK_ID"]) assert.equal(cleared[key], undefined, `${key}:非任务回合三代都清`);
- server/scripts/test-review-no-verdict.ts:38  process.env.HARNESS_DB = process.env.NAVI_DB;
- server/scripts/test-singleton.ts:73  const server = await startServer(await freePort(), db, /server on/, "HARNESS_DB");
- server/scripts/test-singleton.ts:459  delete env.HARNESS_DB;
- server/scripts/test-singleton.ts:519  delete env.HARNESS_DB;
- server/scripts/test-stall-flag.ts:36  process.env.HARNESS_DB = process.env.NAVI_DB;
- server/scripts/test-stall-restart.ts:248  process.env.HARNESS_DB = process.env.NAVI_DB;
- server/scripts/test-stall-settle.ts:32  process.env.HARNESS_DB = process.env.NAVI_DB;
- server/scripts/test-turn-interruption.ts:33  process.env.HARNESS_DB = process.env.NAVI_DB;
- server/src/db/path.ts:4  import { LEGACY_DB_FILE, LEGACY_HARNESS_DB_FILE } from "@navi/shared/legacy-names";
- server/src/db/path.ts:12  const HARNESS_DEFAULT_DB = join(DATA_DIR, LEGACY_HARNESS_DB_FILE);
- server/src/db/path.ts:40  migrateLegacyDbFiles(LEGACY_DEFAULT_DB, HARNESS_DEFAULT_DB);
- server/src/mcp-registry/host-setup.ts:71  * 命令是同一个 node、NAVI_URL(旧登记里是 ASH_URL、HARNESS_URL)规范化之后是同一个地址。
- server/src/preview-env.ts:25  * 进程继承下来的这两个**（连同它们的各代旧名 `ASH_*`、`HARNESS_*` —— dev.mjs 各代都认，留着等于
- server/src/turn-identity.ts:99  // 再上一代(`HARNESS_`)的这里不再写,不清就原样留在这一回合的环境里。
- shared/src/env-names.ts:1  // 环境变量的名字：当前前缀 `NAVI_`，读的时候认上几代（`ASH_`、`HARNESS_`，见 legacy-names.ts）。
- shared/src/env-names.ts:21  /** 同一个变量的各代名字，新名在前：`NAVI_DB` → `["NAVI_DB", "ASH_DB", "HARNESS_DB"]`。 */
- web/scripts/dom-stage.mjs:33  if (!process.env.NAVI_PROXY && !process.env.HARNESS_PROXY) {
- web/vite/page-token.ts:55  // 改名之前的写法（`ASH_PROXY=… npm run dev`、更早的 `HARNESS_PROXY`）照样认，见 env-names.ts。

## repo-dir（31 处）

仓库检出目录的路径或以目录命名的项目（本机 ~/code/harness）：那是文件夹名，不是产品名；挪目录是本地目录迁移那一步的事

- server/scripts/test-cleanup-ownership.ts:297  const posixRoot = "/Users/fjh/code/harness";
- server/scripts/test-handoff-return.ts:50  body: JSON.stringify({ name: "harness", repoPath: repoA }),
- server/scripts/test-handoff-return.ts:54  body: JSON.stringify({ name: "harness", repoPath: repoB }),
- server/scripts/test-handoff-suggestions.ts:95  const projectA = await api<{ id: string }>(machineA, "/projects", json({ name: "harness", repoPath: repoA }));
- server/scripts/test-handoff-suggestions.ts:96  const projectB = await api<{ id: string }>(machineB, "/projects", json({ name: "harness", repoPath: repoB }));
- server/src/codex-toml.ts:133  // 信任的 `[projects."/Users/x/code/harness"]` 正好命中 —— 跑过这个仓库的机器上整份配置
- web/scripts/fixtures/debate-bubble.data.json:11  "statement": "本段没有实际可回应的技术驳回：“执行者的驳回”为 null；执行者自己的完整记录也逐项接受了首轮五条发现（见 /Users/fjh/code/harness/data/runs/g6wp5QSD2N6Y/reSK_yrodFhZ.md:110-150）。\n\n我接受的是“其中四项已经不再是
- web/scripts/fixtures/palette-search.tsx:21  name: "harness",
- web/scripts/fixtures/palette-search.tsx:36  projectName: "harness",
- web/scripts/fixtures/palette-search.tsx:51  projectName: "harness",
- web/scripts/fixtures/palette-search.tsx:124  if (query === "新建任务" || query === "harness") return new Promise<Response>((resolve) => {
- web/scripts/fixtures/project-git-lifetime.tsx:127  const PROJECTS = [projectOf("p1", "harness", "main"), projectOf("p2", "other", "release")];
- web/scripts/fixtures/review-report-texts.ts:301  工作树 \`/Users/fjh/code/harness/.worktrees/x3Jj_JW5SoXk\`，分支 \`harness/x3Jj_JW5\`，HEAD \`45b8a02\`。
- web/scripts/monitor-dom-harness.mjs:10  export const LONG_CWD = "/Users/fjh/code/harness/.worktrees/S3Bp7iPC8wOe/server/scripts/fixtures/deeply/nested/working/directory";
- web/scripts/test-acceptance-freshness.mjs:53  return reply([{ id: "proj-1", name: "harness", repoPath: "/repo", myRole: "admin", acceptGateCommand: null, acceptCommit: true }]);
- web/scripts/test-acceptance-host-layout.mjs:80  return reply([{ id: "proj-1", name: "harness", repoPath: "/repo", myRole: "admin", acceptGateCommand: null }]);
- web/scripts/test-file-link-target.mjs:22  [`/Users/fjh/code/harness/.worktrees/${TASK}/docs/plan.md`, "docs/plan.md"],
- web/scripts/test-file-link-target.mjs:23  ["/Users/fjh/code/harness/.worktrees/OtherTask123/docs/plan.md", "/Users/fjh/code/harness/.worktrees/OtherTask123/docs/plan.md"],
- web/scripts/test-file-link-target.mjs:62  assert.equal(linkFilePath(`file:///Users/fjh/code/harness/.worktrees/${TASK}/docs/plan.md`, TASK), "docs/plan.md");
- web/scripts/test-palette-search.mjs:190  for (const [query, action] of [["新建任务", "new:task"], ["harness", "project:p1"]]) {
- web/scripts/test-report-roots.mjs:59  "/Users/fjh/code/harness/output/current.png",
- web/scripts/test-report-roots.mjs:60  "file:///Users/fjh/code/harness/output/current.png",
- web/scripts/test-report-roots.mjs:100  assert.ok(reviewFileTarget("/Users/fjh/code/harness/data/runs/T1/review/round-2/shot.png"));
- web/scripts/test-report-roots.mjs:101  assert.ok(reviewFileTarget("file:///Users/fjh/code/harness/data/runs/T1/review/round-2/shot.png"));
- web/scripts/test-review-report-fallback.mjs:197  "工作树 `/Users/fjh/code/harness/.worktrees/x3Jj_JW5SoXk`，HEAD `45b8a02`。",
- web/scripts/test-turn-images.mjs:353  ["/Users/fjh/code/harness/output/shot.png#view", "/Users/fjh/code/harness/output/shot.png"],
- web/scripts/test-turn-images.mjs:354  ["/Users/fjh/code/harness/output/shot.png", "/Users/fjh/code/harness/output/shot.png"],
- web/scripts/test-turn-images.mjs:355  ["file:///Users/fjh/code/harness/output/shot.png", "/Users/fjh/code/harness/output/shot.png"],
- web/scripts/test-turn-images.mjs:363  ["/code/harness/output/shot.png", "/code/harness/output/shot.png"],
- web/scripts/test-turn-images.mjs:382  "证据：![证据](/Users/fjh/code/harness/data/runs/kCIlzUlQsB9w/free-review/P6pTi1-Ksavv/round-2/team.png)",
- web/scripts/test-turn-images.mjs:394  "证据：![证据](/Users/fjh/code/harness/data/runs/kCIlzUlQsB9w/free-review/P6pTi1-Ksavv/round-2/team.png)",

## legacy-branch-prefix（25 处）

更早一代的任务分支前缀 harness/：升级前建的分支照样认得

- server/scripts/test-branch-acceptance.ts:122  const legacySource = await setup(); // case11: own source filtering also follows harness/*.
- server/scripts/test-branch-acceptance.ts:123  git(legacySource.childWs.path, "branch", "-m", legacySource.childWs.branch!.replace(TASK_BRANCH_PREFIX, "harness/"));
- server/scripts/test-branch-acceptance.ts:408  const legacyBranch = s.parentWs.branch!.replace(/^ash\//, "harness/");
- server/scripts/test-branch-acceptance.ts:418  console.log("✓ legacy refs/heads and harness branches, accepted target fallback and archived descendants stay visible");
- server/scripts/test-branch-plan-scale.ts:91  git("branch", "harness/parent-o");
- server/scripts/test-branch-plan-scale.ts:92  assert.equal(await branchOwner(root, "project", "harness/parent-o"), undefined, "ash branch wins when both namespaces exist");
- server/scripts/test-branch-plan-scale.ts:94  assert.equal((await branchOwner(root, "project", "refs/heads/harness/parent-o"))?.id, "parent-owner");
- server/scripts/test-branch-plan-scale.ts:95  await db.update(tasks).set({ worktreeBase: "harness/parent-o" }).where(eq(tasks.id, "child-legacy"));
- server/scripts/test-branch-plan-scale.ts:98  git("branch", "-D", "harness/parent-o");
- server/scripts/test-branch-plan-scale.ts:100  assert.equal(await branchOwner(root, "project", "harness/parent-o"), undefined);
- server/scripts/test-rename-compat.ts:6  //   ④ 任务分支:新建写 navi/,已有的 ash/、harness/ 分支照旧找得到;
- server/scripts/test-rename-compat.ts:116  assert.deepEqual(taskBranchNames(id), ["navi/Ab3dEf9h", "ash/Ab3dEf9h", "harness/Ab3dEf9h"]);
- server/scripts/test-rename-compat.ts:117  for (const prefix of ["navi/", "ash/", "harness/"]) {
- server/scripts/test-rename-compat.ts:128  for (const old of ["harness/Ab3dEf9h", "ash/Ab3dEf9h"]) {
- server/scripts/test-rename-compat.ts:134  console.log("✓ 任务分支:新建写 navi/,已有的 ash/、harness/ 分支照旧找得到");
- server/scripts/test-search-query.ts:41  for (const prefix of ["navi/", "ash/", "harness/"]) assert.deepEqual(candidates(`${prefix}Zx8Kq2mN`), ["zx8kq2mn"]);
- server/scripts/test-worktree-recovery.ts:86  const legacyBranch = `harness/${taskId.slice(0, 8)}`;
- server/src/git.ts:298  /** 这条任务的分支在仓库里实际叫什么：改名之前建的还是 `ash/<id8>`（再早 `harness/`），沿用它；都没有才用当前名。 */
- server/src/task-change-scope.ts:203  // 老任务还挂在 `harness/xxx` 上，这里得两边都认，否则老任务一律报 source_branch_missing。
- shared/src/task-branch.ts:2  // `ash/<id8>`、更早是 `harness/<id8>`（前缀见 legacy-names.ts），仓库里还在，**按任务找分支时
- web/scripts/base-update-recovery-checks.mjs:54  // 任务分支（navi/ harness/ 前缀）点下去只在层里出警告，要再点「改到这里」才发。
- web/scripts/base-update-recovery-checks.mjs:60  if (/^(navi|harness)\//.test(branch)) {
- web/scripts/branch-acceptance-checks.mjs:100  ensure(await d.option("harness/case11-c").count() === 0, "legacy own task branch must not be offered");
- web/scripts/fixtures/palette-search.tsx:22  repoPath: "/srv/harness/hit-00",
- web/scripts/test-turn-fold.mjs:54  "harness/report_stage",

## legacy-stored-keys（20 处）

浏览器、手机本机存储里更早一代的键（harness.baseURL、harness-next: 前缀）：升级时整批挪到 navi 前缀

- mobile/scripts/test-stored-keys.mjs:1  // 手机端本机存储改名：服务器地址、key 从 ash.* / harness.* 挪到 navi.*。跑：cd mobile && npm run test:stored-keys
- mobile/scripts/test-stored-keys.mjs:30  const store = memory({ "harness.baseURL": "http://old:4317" });
- mobile/scripts/test-stored-keys.mjs:36  const store = memory({ "navi.baseURL": "http://new:4317", "ash.baseURL": "http://stale:4317", "harness.baseURL": "http://older:4317" });
- mobile/scripts/test-stored-keys.mjs:42  const store = memory({ "ash.baseURL": "http://ash:4317", "harness.baseURL": "http://harness:4317" });
- mobile/scripts/test-stored-keys.mjs:82  console.log("PASS stored keys: server address and key move from ash.* / harness.* to navi.*, and a failed move never blocks startup");
- mobile/src/lib/storedKeys.ts:8  baseURL: { current: "navi.baseURL", legacy: ["ash.baseURL", "harness.baseURL"] },
- web/package.json:108  "//test:storage-rename": "改名后的本机存储：ash: / ash. / harness-next: 下的旧键在任何模块读存储之前整批挪到 navi 前缀。",
- web/scripts/test-storage-rename.mjs:1  // 改名之后的本机存储：老版本页面挂在 ash: / ash. / harness-next: 下的键，一启动就整批挪到 navi 前缀，
- web/scripts/test-storage-rename.mjs:3  // harness-next），跟存储枚举的先后无关；不认识的键不碰；写不进新键时旧键一个字不动（刷新之后照样在、照样
- web/scripts/test-storage-rename.mjs:41  "harness-next:diff-layout": "split",
- web/scripts/test-storage-rename.mjs:61  const storage = new MemoryStorage({ "ash:diff-layout": "unified", "navi:diff-layout": "split", "harness-next:diff-layout": "unified" });
- web/scripts/test-storage-rename.mjs:66  // 两代旧值同在：浏览器先枚举到更早的 harness-next 那份也不算数，ash 那份更新。
- web/scripts/test-storage-rename.mjs:68  const entries = { "harness-next:sidebar-width": "240", "ash:sidebar-width": "420", "harness-next:sidebar-collapsed": "1", "ash:sidebar-collapsed": "0" };
- web/scripts/test-storage-rename.mjs:70  assert.equal(storage.key(0), "harness-next:sidebar-width", "前提：更早那一代先被枚举到");
- web/scripts/test-storage-rename.mjs:103  const first = new StorageLike({ "ash:assistant-draft:r1": draft, "harness-next:small": "1", filler: "y".repeat(40) });
- web/scripts/test-storage-rename.mjs:221  const grep = spawnSync("git", ["grep", "-nE", "[\"`](ash|harness-next)[:.][a-zA-Z$]", "--", "src"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
- web/scripts/test-storage-rename.mjs:228  console.log("PASS storage rename: legacy ash:/ash./harness-next: keys move to navi before anything reads storage, newest generation wins, and what does not fit 
- web/src/lib/storageRename.ts:6  // 同一个新键可能同时有好几代旧值（`ash:x` 和更早的 `harness-next:x` 都在）：按代数定胜负，新键 > ash >
- web/src/lib/storageRename.ts:7  // harness-next，跟存储枚举的先后无关 —— 浏览器枚举键的顺序不是版本信息。新键已经在（比如另一个已升级
- web/src/lib/storageRename.ts:22  ["harness-next:", "navi:"],

## older-prose（13 处）

更早改名（harness → ash）那次没换掉的叙述、示例和临时目录名：说的是产品，但不是兼容值；本次只换 ash，这些不在范围里，原样留着

- server/scripts/test-search-scan.ts:4  // 任务的全文读进内存（`Promise.all` 全量并发），一次 `?q=harness` 20 秒，还把事件循环
- server/scripts/test-team-lead-resilience.ts:380  // 常驻会话里挂了后台监控的 agent,通知一到就接着干活,harness 一条消息都没 send 过。
- server/src/file-search.ts:138  // —— harness 自己的 `.worktrees/` 下就躺着九个完整检出。
- server/src/search.ts:9  // `?q=harness` 要 20 秒，**而且把整个事件循环占死**：同一时刻本该 33 ms 的
- server/src/search.ts:370  // （实测：`?q=harness` 有 301 条命中，全吐是 643 KB，只吐进得了前 50 的是 ~50 行。）
- server/src/team/session-consumer.ts:208  // 而 harness 一条消息都没 send 过 —— 上一个 turnEnd 已经把这台落成待命、turnStart
- web/scripts/test-conversation-self-turn.mjs:4  // 工具，而 harness 一条消息都没 send 过 —— 服务端那会儿还没给这种自发回合补回合起点，
- web/scripts/verify-git-workbench-busy-discard.mjs:16  || join(tmpdir(), "harness-git-workbench-busy-discard");
- web/scripts/verify-git-workbench-design.mjs:14  || join(tmpdir(), "harness-git-workbench-design-current");
- web/scripts/verify-git-workbench-diff-prefixes.mjs:15  || join(tmpdir(), "harness-git-workbench-diff-prefixes");
- web/scripts/verify-git-workbench-discard-menu.mjs:16  || join(tmpdir(), "harness-git-workbench-discard-menu");
- web/scripts/verify-git-workbench-header-resize.mjs:14  || join(tmpdir(), "harness-git-workbench-header-resize");
- web/scripts/verify-git-workbench-refresh-paths.mjs:16  || join(tmpdir(), "harness-git-workbench-refresh-paths");

## legacy-registry（12 处）

旧名登记处：更早一代的名字只在这两份里登记，别处要认就从这里取

- scripts/legacy-names.mjs:7  export const LEGACY_ENV_PREFIXES = ["ASH_", "HARNESS_"];
- scripts/legacy-names.mjs:8  export const LEGACY_MCP_SERVER_NAMES = ["ash", "harness"];
- scripts/legacy-names.mjs:9  export const LEGACY_REPO_DIR_NAMES = ["ash", "harness"];
- scripts/legacy-names.mjs:10  export const LEGACY_TASK_BRANCH_PREFIXES = ["ash/", "harness/"];
- scripts/legacy-names.mjs:13  export const LEGACY_HARNESS_DB_FILE = "harness.db";
- shared/src/legacy-names.ts:1  // 改名兼容：上几代产品名（ash ← harness）在**跨进程、落盘、落库、用户配置**里留下的字样。
- shared/src/legacy-names.ts:14  /** 环境变量的旧前缀，新的在前（`NAVI_X` 读不到时依次认 `ASH_X`、`HARNESS_X`）。拆：用户启动命令、
- shared/src/legacy-names.ts:16  export const LEGACY_ENV_PREFIXES = ["ASH_", "HARNESS_"] as const;
- shared/src/legacy-names.ts:20  export const LEGACY_MCP_SERVER_NAMES = ["ash", "harness"] as const;
- shared/src/legacy-names.ts:24  export const LEGACY_REPO_DIR_NAMES = ["ash", "harness"] as const;
- shared/src/legacy-names.ts:27  export const LEGACY_TASK_BRANCH_PREFIXES = ["ash/", "harness/"] as const;
- shared/src/legacy-names.ts:38  export const LEGACY_HARNESS_DB_FILE = "harness.db";

## generation-list（9 处）

逐代列出产品名：兼容逻辑的说明，或测试里把每一代名字都喂一遍

- docs/install.md:123  - 已有 `navi` 或历史名 `harness` 一律不覆盖,关着的不替你打开,那个键的值我们认不出来时也不动;
- mobile/scripts/test-stored-keys.mjs:3  // 两代旧名（harness → ash）按顺序都认；挪或删失败时读到的值照样返回、不拖住启动，旧键留着下次再挪；
- mobile/scripts/test-stored-keys.mjs:78  assert.doesNotMatch(config, /"(ash|harness)\.(baseURL|apiKey)"/, "旧键名只留在 storedKeys.ts");
- mobile/src/lib/storedKeys.ts:1  // 手机端本机存储（AsyncStorage）里的键。项目改过两次名（harness → ash → navi），老版本存下的
- server/scripts/test-rename-compat.ts:79  const env: Record<string, string | undefined> = { NAVI_TASK_ID: "n", ash_task_id: "a", Harness_Task_Id: "h", OTHER: "x" };
- server/scripts/test-rename-compat.ts:102  for (const name of ["navi", "ash", "harness"]) {
- server/src/chat/assistant-guide.ts:5  export const ASSISTANT_GUIDE = `Navi 是管理智能体工作、任务与验收的工作台，旧名 harness。
- server/src/codex-toml.ts:132  // 第二段是兼容名。上一版拿「行首是 `[` 且行内有 ash/harness」当信号，codex 自己记项目
- web/src/lib/storageRename.ts:2  // （harness → ash → navi），老版本页面存下的偏好、草稿、布局还挂在旧前缀上：页面一启动、任何模块读存储

## history（2 处）

事故记录：写的是当时的名字

- docs/incidents.md:325  早上看侧栏，三条 8 月就跑完的 `审查:*` 任务排在 harness 最前面，怎么都折不掉。第一反应是折叠坏了——不是，是那几行的数据在凌晨被改写过。
- docs/incidents.md:337  做进系统的是判据本身：没有待结算记录（证据行不存在、或存在但从没落过结算）且任务自己已终态、没有在飞的 `verifyRound`/`resumePrompt` 时，一律算已收口。回归用例在 `server/scripts/test-review-history.ts`（注意：harness 的验收前置命令只有 `np

## legacy-db（2 处）

更早一代的库文件名 harness.db：启动时就地改名成 ash.db（server/src/db/path.ts）

- server/scripts/test-singleton.ts:82  const legacy = join(root, "harness.db");
- server/src/db/path.ts:36  * 更早的 `harness.db` 照旧就地改名成 `ash.db`（那一代没有并存的旧版服务）。

