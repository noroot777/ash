<!-- 由 .audit/tables.mjs 生成 -->

总计 578:绿 540 / 红 38 / 超时 0 / 未跑 0
门禁内 187:绿 180 / 红 7 / 超时 0 / 未跑 0
门禁外 391:绿 360 / 红 31 / 超时 0 / 未跑 0

## 表 A:入口脚本(384 条)

| 入口 | 叶子数 | 门禁范围 | 结果 |
|---|---|---|---|
| `root:test:restart` | 8 | 门禁外 | 全绿 |
| `root:test:accept` | 1 | 门禁外 | 1 条未跑 |
| `root:test:accept-gate` | 1 | 门禁外 | 全绿 |
| `root:test:web` | 141 | 门禁内 | **4 条非绿** |
| `root:test:diagnostics` | 1 | 门禁外 | 全绿 |
| `server:test:cli-commands` | 11 | 门禁外 | **2 条非绿** |
| `server:test:diagnostic-session-reply` | 1 | 门禁外 | 全绿 |
| `server:test:goal-native-live` | 2 | 门禁外 | 全绿 |
| `server:test:side-chat` | 3 | 门禁内 | 全绿 |
| `server:test:assistant` | 1 | 门禁外 | 全绿 |
| `server:test:native-work` | 5 | 门禁内 | 全绿 |
| `server:test:chat-context` | 1 | 门禁外 | 全绿 |
| `server:test:chat` | 11 | 门禁外 | 全绿 |
| `server:test:task-memos` | 1 | 门禁外 | 全绿 |
| `server:test:monitor-wake-data` | 1 | 门禁外 | 全绿 |
| `server:test:monitor-delivery-batch` | 1 | 门禁外 | **1 条非绿** |
| `server:test:monitor-checkpoint-recovery` | 1 | 门禁内 | 全绿 |
| `server:test:preview-annotation` | 1 | 门禁外 | 全绿 |
| `server:test:preview-assist` | 1 | 门禁外 | 全绿 |
| `server:test:diagnostics` | 1 | 门禁外 | 全绿 |
| `server:test:singleton` | 1 | 门禁外 | 全绿 |
| `server:test:detached` | 3 | 门禁外 | 全绿 |
| `server:test:process-identity` | 1 | 门禁外 | 全绿 |
| `server:test:process-subtrees` | 1 | 门禁外 | 全绿 |
| `server:test:reattach` | 1 | 门禁外 | 全绿 |
| `server:test:monitors` | 39 | 门禁外 | **3 条非绿** |
| `server:test:queue` | 1 | 门禁外 | 全绿 |
| `server:test:search` | 1 | 门禁外 | 全绿 |
| `server:test:search-scan` | 1 | 门禁外 | 全绿 |
| `server:test:search-visibility` | 1 | 门禁外 | 全绿 |
| `server:test:upload-names` | 1 | 门禁外 | 全绿 |
| `server:test:upload-visibility` | 2 | 门禁外 | 全绿 |
| `server:test:follow-up` | 1 | 门禁外 | 全绿 |
| `server:test:resume-prompt` | 1 | 门禁外 | 全绿 |
| `server:test:user-directives` | 1 | 门禁外 | 全绿 |
| `server:test:task-workspace` | 1 | 门禁外 | 全绿 |
| `server:test:file-delete` | 1 | 门禁外 | 全绿 |
| `server:test:open-in-ide` | 1 | 门禁外 | 全绿 |
| `server:test:turn-baseline` | 1 | 门禁外 | 全绿 |
| `server:test:turn-stall` | 1 | 门禁外 | 全绿 |
| `server:test:stall-flag` | 1 | 门禁外 | 全绿 |
| `server:test:stall-settle` | 1 | 门禁外 | 全绿 |
| `server:test:turn-stall-progress` | 1 | 门禁外 | 全绿 |
| `server:test:claude-retry-stall` | 1 | 门禁外 | 全绿 |
| `server:test:stall-restart` | 1 | 门禁外 | 全绿 |
| `server:test:turn-ownership` | 1 | 门禁外 | 全绿 |
| `server:test:turn-reclaim` | 4 | 门禁外 | 全绿 |
| `server:test:turn-output` | 1 | 门禁外 | 全绿 |
| `server:test:reopen-acceptance` | 1 | 门禁外 | 全绿 |
| `server:test:branch-acceptance` | 5 | 门禁外 | **2 条非绿** |
| `server:test:branch-plan-creation` | 1 | 门禁外 | **1 条非绿** |
| `server:test:accept-merge` | 7 | 门禁内 | **1 条非绿** |
| `server:test:accept` | 46 | 门禁内 | **3 条非绿** |
| `server:test:accept-gate-process` | 2 | 门禁外 | 全绿 |
| `server:test:multi-user` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-setup` | 1 | 门禁外 | 全绿 |
| `server:test:onboarding-gate` | 1 | 门禁外 | 全绿 |
| `server:test:user-cli-smoke` | 1 | 门禁外 | 全绿 |
| `server:test:user-cli-mcp` | 3 | 门禁外 | 全绿 |
| `server:test:ash-mcp-registry` | 3 | 门禁外 | 全绿 |
| `server:test:personal-cli-settings` | 1 | 门禁内 | 全绿 |
| `server:test:handoff` | 18 | 门禁外 | **3 条非绿** |
| `server:test:handoff-capability` | 2 | 门禁外 | **1 条非绿** |
| `server:test:handoff-accepted-return` | 2 | 门禁外 | 全绿 |
| `server:test:handoff-remote-return` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-cli-config-dir` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-peer-key` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-outbound-key` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-key-persistence` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-key-concurrency` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-source-address` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-notice` | 1 | 门禁外 | 全绿 |
| `server:test:repo-lock` | 1 | 门禁外 | 全绿 |
| `server:test:project-git` | 1 | 门禁外 | 全绿 |
| `server:test:git-workbench` | 7 | 门禁外 | 全绿 |
| `server:test:project-clone` | 1 | 门禁外 | 全绿 |
| `server:test:project-dir` | 1 | 门禁外 | 全绿 |
| `server:test:project-git-config` | 1 | 门禁外 | 全绿 |
| `server:test:scm` | 1 | 门禁外 | 全绿 |
| `server:test:scm-guard` | 1 | 门禁外 | 全绿 |
| `server:test:scm-nested` | 1 | 门禁外 | 全绿 |
| `server:test:worktree-recovery` | 1 | 门禁外 | 全绿 |
| `server:test:worktree-default` | 1 | 门禁外 | 全绿 |
| `server:test:worktree-leftover` | 1 | 门禁外 | 全绿 |
| `server:test:archive-cleanup` | 2 | 门禁外 | 全绿 |
| `server:test:workspace-cleanup` | 1 | 门禁外 | 全绿 |
| `server:test:workspace-dirty` | 1 | 门禁外 | 全绿 |
| `server:test:executor-resolution` | 2 | 门禁外 | 全绿 |
| `server:test:ssh-retire` | 1 | 门禁外 | 全绿 |
| `server:test:answer-routing` | 1 | 门禁外 | 全绿 |
| `server:test:question-history` | 1 | 门禁外 | 全绿 |
| `server:test:team-native` | 1 | 门禁外 | 全绿 |
| `server:test:team-resilience` | 4 | 门禁外 | 全绿 |
| `server:test:team-inbound-durability` | 2 | 门禁外 | 全绿 |
| `server:test:native-turn` | 1 | 门禁外 | **1 条非绿** |
| `server:test:executor-overrides` | 1 | 门禁外 | 全绿 |
| `server:test:cli-overrides` | 1 | 门禁外 | **1 条非绿** |
| `server:test:claude-settings-live` | 1 | 门禁外 | 全绿 |
| `server:test:claude-relay-settings-live` | 1 | 门禁外 | 全绿 |
| `server:test:model-effort-isolation` | 1 | 门禁外 | 全绿 |
| `server:test:cli-catalog` | 1 | 门禁外 | 全绿 |
| `server:test:kimi` | 2 | 门禁外 | 全绿 |
| `server:test:kimi-live` | 1 | 门禁外 | 全绿 |
| `server:test:cli-models` | 1 | 门禁外 | 全绿 |
| `server:test:task-derivation` | 1 | 门禁外 | 全绿 |
| `server:test:task-creation-origin` | 1 | 门禁外 | 全绿 |
| `server:test:task-list-body` | 1 | 门禁外 | 全绿 |
| `server:test:task-event-timestamps` | 1 | 门禁外 | 全绿 |
| `server:test:notes` | 1 | 门禁外 | 全绿 |
| `server:test:star` | 1 | 门禁外 | 全绿 |
| `server:test:task-activity` | 1 | 门禁外 | 全绿 |
| `server:test:scheduled-messages` | 8 | 门禁外 | 全绿 |
| `server:test:review` | 27 | 门禁内 | **2 条非绿** |
| `server:test:regression-evidence` | 14 | 门禁内 | **2 条非绿** |
| `server:test:regression-reuse` | 1 | 门禁内 | 全绿 |
| `server:test:review-sweep` | 1 | 门禁内 | 全绿 |
| `server:test:prompt-budget` | 1 | 门禁内 | 全绿 |
| `server:test:browser-policy` | 1 | 门禁外 | 全绿 |
| `server:test:browser-grant-timing` | 1 | 门禁外 | **1 条非绿** |
| `server:test:claude-stream` | 1 | 门禁外 | 全绿 |
| `server:test:session-lost` | 1 | 门禁外 | **1 条非绿** |
| `server:test:duet-session-lost` | 1 | 门禁外 | 全绿 |
| `server:test:duet-stall-visibility` | 1 | 门禁外 | 全绿 |
| `server:test:session-notice` | 2 | 门禁外 | 全绿 |
| `server:test:codex-resident` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-result` | 1 | 门禁外 | 全绿 |
| `server:test:holder-scan` | 1 | 门禁外 | **1 条非绿** |
| `server:test:cleanup-debt` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-pending` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-ownership` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-write-handoff` | 1 | 门禁外 | 全绿 |
| `server:test:kernel-confine` | 1 | 门禁外 | 全绿 |
| `server:test:kill-lineage` | 1 | 门禁外 | 全绿 |
| `server:test:codex-archive` | 3 | 门禁外 | 全绿 |
| `server:test:codex-archive-live` | 1 | 门禁外 | 全绿 |
| `server:test:session-trace` | 1 | 门禁外 | 全绿 |
| `server:test:session-waiting` | 1 | 门禁外 | 全绿 |
| `server:test:session-read-errors` | 1 | 门禁外 | 全绿 |
| `server:test:conversation-turn` | 1 | 门禁外 | 全绿 |
| `server:test:retry-turn` | 1 | 门禁外 | 全绿 |
| `server:test:settlement-note` | 1 | 门禁外 | 全绿 |
| `server:test:turn-freeze` | 1 | 门禁外 | 全绿 |
| `server:test:turn-visibility` | 1 | 门禁外 | 全绿 |
| `server:test:agent-attachments` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-entry` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-journal` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-meta` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-stream` | 2 | 门禁外 | 全绿 |
| `server:test:usage` | 3 | 门禁外 | 全绿 |
| `server:test:peer-context` | 1 | 门禁外 | 全绿 |
| `server:test:auto-title` | 2 | 门禁外 | 全绿 |
| `server:test:workflow-mode-default` | 1 | 门禁外 | 全绿 |
| `server:test:workflow` | 1 | 门禁外 | 全绿 |
| `server:test:workflow-library` | 1 | 门禁外 | 全绿 |
| `server:test:workflow-run` | 1 | 门禁外 | 全绿 |
| `server:test:workflow-gate` | 1 | 门禁外 | 全绿 |
| `server:test:free-workflow` | 11 | 门禁内 | 全绿 |
| `server:test:review-resume` | 1 | 门禁内 | 全绿 |
| `server:test:free-workflow-preview` | 1 | 门禁内 | 全绿 |
| `server:test:agent-spawn-guard` | 1 | 门禁外 | 全绿 |
| `server:test:agent-cleanup` | 1 | 门禁外 | 全绿 |
| `server:test:verify-override` | 1 | 门禁外 | 全绿 |
| `server:test:foreign-bins` | 1 | 门禁外 | 全绿 |
| `server:test:preview-settings-proxy` | 1 | 门禁外 | 全绿 |
| `server:test:preview-command` | 2 | 门禁外 | 全绿 |
| `server:test:preview-log` | 1 | 门禁外 | 全绿 |
| `server:test:preview-lent-port` | 1 | 门禁外 | 全绿 |
| `server:test:preview-launch` | 1 | 门禁外 | 全绿 |
| `server:test:preview-host-api` | 1 | 门禁外 | 全绿 |
| `server:test:preview-cookies` | 1 | 门禁外 | 全绿 |
| `server:test:preview-process` | 1 | 门禁外 | 全绿 |
| `server:test:preview-stop-notice` | 1 | 门禁外 | 全绿 |
| `server:test:preview-seed` | 1 | 门禁外 | 全绿 |
| `server:test:preview-probe` | 1 | 门禁外 | 全绿 |
| `server:test:openai-converter` | 1 | 门禁外 | 全绿 |
| `server:test:anthropic-context-1m` | 1 | 门禁外 | 全绿 |
| `server:test:llm-relay` | 1 | 门禁外 | 全绿 |
| `server:test:skills` | 1 | 门禁外 | 全绿 |
| `server:test:file-browser` | 1 | 门禁外 | 全绿 |
| `server:test:task-file-raw` | 1 | 门禁外 | 全绿 |
| `server:test:task-artifacts` | 1 | 门禁外 | 全绿 |
| `server:test:artifact-scope` | 1 | 门禁外 | 全绿 |
| `server:test:task-page` | 1 | 门禁外 | 全绿 |
| `server:test:file-search` | 1 | 门禁外 | 全绿 |
| `server:test:local-open` | 1 | 门禁外 | 全绿 |
| `server:test:openers-windows` | 1 | 门禁外 | 全绿 |
| `server:test:dir-picker` | 1 | 门禁外 | 全绿 |
| `server:test:mcp-handoff` | 1 | 门禁外 | 全绿 |
| `server:test:duet-attachments` | 1 | 门禁外 | 全绿 |
| `server:test:terminal` | 13 | 门禁外 | **3 条非绿** |
| `server:test:win-launch` | 3 | 门禁外 | 全绿 |
| `server:test:path-boundary` | 1 | 门禁外 | 全绿 |
| `server:test:no-libsql` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-free-workflow-rows` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-run` | 1 | 门禁外 | **1 条非绿** |
| `server:test:multi-user-git` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-agent` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-members` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-paths` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-settings` | 1 | 门禁外 | 全绿 |
| `server:test:missing-task-writes` | 1 | 门禁外 | 全绿 |
| `server:test:preview-deps` | 2 | 门禁外 | 全绿 |
| `server:test:page-annotation-batches` | 2 | 门禁外 | 全绿 |
| `server:test:annotation-batches` | 1 | 门禁外 | 全绿 |
| `server:test:preview-workspace` | 1 | 门禁外 | 全绿 |
| `server:test:monitor-races` | 1 | 门禁外 | **1 条非绿** |
| `server:test:db-tx` | 1 | 门禁外 | 全绿 |
| `server:test:turn-identity` | 3 | 门禁外 | **1 条非绿** |
| `server:test:turn-migration` | 1 | 门禁外 | 全绿 |
| `server:test:turn-persist` | 1 | 门禁外 | 全绿 |
| `server:test:duet-image-ownership` | 1 | 门禁外 | 全绿 |
| `server:test:ash-mcp-reach` | 1 | 门禁外 | **1 条非绿** |
| `server:test:ash-mcp-probe` | 1 | 门禁外 | 全绿 |
| `server:test:ash-mcp-file` | 1 | 门禁外 | 全绿 |
| `server:test:ash-mcp-launch` | 1 | 门禁外 | 全绿 |
| `server:test:stall-journal` | 1 | 门禁外 | 全绿 |
| `web:test:cli-commands` | 2 | 门禁外 | **2 条非绿** |
| `web:test:native-work` | 8 | 门禁内 | 全绿 |
| `web:test:native-agent-segments` | 1 | 门禁外 | 全绿 |
| `web:test:upstream-retry-placement` | 1 | 门禁内 | 全绿 |
| `web:test:chat` | 1 | 门禁外 | **1 条非绿** |
| `web:test` | 141 | 门禁内 | **4 条非绿** |
| `web:test:selection-content` | 1 | 门禁内 | 全绿 |
| `web:test:side-chat` | 9 | 门禁内 | 全绿 |
| `web:test:side-chat-upload` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-fork` | 3 | 门禁内 | 全绿 |
| `web:test:question-card` | 1 | 门禁内 | 全绿 |
| `web:test:question-history-dom` | 1 | 门禁内 | 全绿 |
| `web:test:page-token` | 1 | 门禁内 | 全绿 |
| `web:test:image-preview` | 1 | 门禁外 | 全绿 |
| `web:test:turn-images` | 1 | 门禁内 | 全绿 |
| `web:test:markdown-images` | 2 | 门禁内 | 全绿 |
| `web:test:inspector-shortcuts` | 1 | 门禁内 | 全绿 |
| `web:test:inspector-shortcut-stack` | 1 | 门禁内 | 全绿 |
| `web:test:key-chord` | 1 | 门禁内 | 全绿 |
| `web:test:roving-choice` | 1 | 门禁内 | 全绿 |
| `web:test:workspace-shortcuts` | 1 | 门禁内 | 全绿 |
| `web:test:sidebar-navigation` | 1 | 门禁内 | 全绿 |
| `web:test:sidebar-remote-race` | 1 | 门禁内 | 全绿 |
| `web:test:palette-keys` | 1 | 门禁内 | 全绿 |
| `web:test:palette-search` | 1 | 门禁内 | 全绿 |
| `web:test:shortcuts` | 8 | 门禁内 | 全绿 |
| `web:test:inspector-attachments` | 1 | 门禁外 | 全绿 |
| `web:test:open-with` | 1 | 门禁外 | 全绿 |
| `web:test:open-in-ide-menu` | 1 | 门禁外 | 全绿 |
| `web:test:cli-effort-policy` | 1 | 门禁内 | 全绿 |
| `web:test:run-target-picker` | 1 | 门禁外 | 全绿 |
| `web:test:provider-visibility` | 1 | 门禁内 | 全绿 |
| `web:test:executor-picker-field` | 1 | 门禁外 | 全绿 |
| `web:test:agent-profile-add-gate` | 1 | 门禁外 | 全绿 |
| `web:test:team-review-inspector` | 1 | 门禁外 | 全绿 |
| `web:test:free-review-copy` | 1 | 门禁外 | 全绿 |
| `web:test:reviewer-profile-summary` | 1 | 门禁外 | 全绿 |
| `web:test:free-workflow-inspector` | 1 | 门禁外 | 全绿 |
| `web:test:free-review-defer-dom` | 1 | 门禁内 | 全绿 |
| `web:test:free-review-delete` | 1 | 门禁内 | 全绿 |
| `web:test:dispute-timeline-cta` | 1 | 门禁内 | 全绿 |
| `web:test:debate-lane` | 1 | 门禁内 | 全绿 |
| `web:test:task-review-rounds` | 1 | 门禁外 | 全绿 |
| `web:test:review-report-sections` | 5 | 门禁内 | 全绿 |
| `web:test:review-report-split-dom` | 2 | 门禁内 | 全绿 |
| `web:test:review-diff-zoom` | 1 | 门禁外 | 全绿 |
| `web:test:data-layer` | 5 | 门禁外 | 全绿 |
| `web:test:session-merge` | 1 | 门禁外 | 全绿 |
| `web:test:task-sync` | 1 | 门禁外 | **1 条非绿** |
| `web:test:task-read-state` | 1 | 门禁内 | 全绿 |
| `web:test:scheduled-message-tray` | 3 | 门禁内 | 全绿 |
| `web:test:monitor-inspector` | 3 | 门禁内 | 全绿 |
| `web:test:task-memo-dom` | 1 | 门禁内 | 全绿 |
| `web:test:withdraw-scheduled` | 1 | 门禁内 | 全绿 |
| `web:test:users-role` | 1 | 门禁内 | 全绿 |
| `web:test:personal-cli-settings` | 2 | 门禁内 | 全绿 |
| `web:test:project-member-role` | 1 | 门禁内 | 全绿 |
| `web:test:create-project-scope` | 1 | 门禁内 | 全绿 |
| `web:test:ui-polish` | 1 | 门禁内 | 全绿 |
| `web:test:stick-to-bottom` | 2 | 门禁内 | 全绿 |
| `web:test:segment-layout` | 1 | 门禁内 | 全绿 |
| `web:test:confirm-enter` | 1 | 门禁内 | 全绿 |
| `web:test:send-key` | 1 | 门禁内 | 全绿 |
| `web:test:assistant-entry` | 1 | 门禁内 | **1 条非绿** |
| `web:test:select-all-on-focus` | 1 | 门禁内 | 全绿 |
| `web:test:run-activity` | 1 | 门禁外 | 全绿 |
| `web:test:tool-summary` | 1 | 门禁外 | 全绿 |
| `web:test:duet-timeline` | 1 | 门禁外 | 全绿 |
| `web:test:conversation-notes` | 1 | 门禁内 | 全绿 |
| `web:test:conversation` | 17 | 门禁内 | **1 条非绿** |
| `web:test:monitor-wake` | 2 | 门禁内 | **1 条非绿** |
| `web:test:conversation-task-switch` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-system-note` | 1 | 门禁内 | 全绿 |
| `web:test:settlement-note` | 1 | 门禁内 | 全绿 |
| `web:test:turn-fold` | 1 | 门禁内 | 全绿 |
| `web:test:claude-trace-accounting` | 1 | 门禁内 | 全绿 |
| `web:test:turn-fold-dom` | 1 | 门禁外 | 全绿 |
| `web:test:conversation-continuation` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-steer` | 1 | 门禁内 | 全绿 |
| `web:test:context-meter` | 1 | 门禁内 | 全绿 |
| `web:test:context-compact-quick` | 1 | 门禁内 | 全绿 |
| `web:test:client-id` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-notes-dom` | 1 | 门禁内 | 全绿 |
| `web:test:copy-feedback-dom` | 1 | 门禁内 | 全绿 |
| `web:test:system-notices-dom` | 1 | 门禁内 | 全绿 |
| `web:test:turn-remedy-dom` | 1 | 门禁内 | 全绿 |
| `web:test:turn-remedy-catch-up-dom` | 1 | 门禁内 | 全绿 |
| `web:test:task-catch-up-dom` | 1 | 门禁内 | 全绿 |
| `web:test:catch-up` | 1 | 门禁内 | 全绿 |
| `web:test:reviewer-turn` | 3 | 门禁内 | 全绿 |
| `web:test:reviewer-turn-dom` | 1 | 门禁外 | 全绿 |
| `web:test:task-tree` | 1 | 门禁外 | 全绿 |
| `web:test:task-tree-preview` | 1 | 门禁外 | 全绿 |
| `web:test:task-tree-paging` | 2 | 门禁外 | 全绿 |
| `web:test:task-tree-offline` | 1 | 门禁外 | 全绿 |
| `web:test:bulk-handoff` | 1 | 门禁内 | 全绿 |
| `web:test:remote-task` | 2 | 门禁内 | **1 条非绿** |
| `web:test:handoff-dialog-lifetime` | 1 | 门禁内 | 全绿 |
| `web:test:handoff-source-addresses` | 1 | 门禁外 | 全绿 |
| `web:test:spread-filter` | 1 | 门禁外 | 全绿 |
| `web:test:outbound-state` | 1 | 门禁外 | 全绿 |
| `web:test:notes-filter` | 1 | 门禁外 | 全绿 |
| `web:test:slash-match` | 1 | 门禁外 | 全绿 |
| `web:test:file-mention` | 1 | 门禁外 | 全绿 |
| `web:test:file-tree-git` | 2 | 门禁内 | 全绿 |
| `web:test:diff-model` | 1 | 门禁内 | 全绿 |
| `web:test:file-diff-view` | 1 | 门禁内 | 全绿 |
| `web:test:file-view-zoom` | 1 | 门禁内 | 全绿 |
| `web:test:file-reel` | 1 | 门禁内 | 全绿 |
| `web:test:file-entry-delete` | 2 | 门禁内 | 全绿 |
| `web:test:file-mention-dom` | 1 | 门禁外 | 全绿 |
| `web:test:workspace-history` | 1 | 门禁外 | 全绿 |
| `web:test:reply-drafts` | 1 | 门禁外 | 全绿 |
| `web:test:composer-upload` | 1 | 门禁内 | 全绿 |
| `web:test:composer-draft` | 1 | 门禁内 | 全绿 |
| `web:test:composer-studio` | 1 | 门禁内 | 全绿 |
| `web:test:composer-branches` | 1 | 门禁内 | 全绿 |
| `web:test:composer-delete-race` | 1 | 门禁内 | 全绿 |
| `web:test:settle-created-task` | 1 | 门禁外 | 全绿 |
| `web:test:queue-after` | 1 | 门禁外 | 全绿 |
| `web:test:created-task-merge` | 1 | 门禁外 | 全绿 |
| `web:test:inspector-queue` | 1 | 门禁内 | 全绿 |
| `web:test:notes-upload` | 1 | 门禁内 | 全绿 |
| `web:test:notes-empty-body` | 1 | 门禁内 | 全绿 |
| `web:test:notes-delete-race` | 1 | 门禁内 | 全绿 |
| `web:test:duet-upload` | 1 | 门禁内 | 全绿 |
| `web:test:workflow-rail` | 1 | 门禁外 | 全绿 |
| `web:test:workflow-edit` | 1 | 门禁外 | 全绿 |
| `web:test:turn-retry` | 1 | 门禁外 | 全绿 |
| `web:test:scm-paths` | 1 | 门禁外 | 全绿 |
| `web:test:scm-stale` | 1 | 门禁外 | 全绿 |
| `web:test:scm-race` | 1 | 门禁外 | **1 条非绿** |
| `web:test:scm-nested-ui` | 1 | 门禁外 | 全绿 |
| `web:test:scm-file-layout` | 1 | 门禁外 | 全绿 |
| `web:test:file-layout-surfaces` | 1 | 门禁外 | 全绿 |
| `web:test:agent-plate` | 1 | 门禁外 | 全绿 |
| `web:test:reply-resize` | 1 | 门禁外 | 全绿 |
| `web:test:bulk-handoff-dialog` | 1 | 门禁内 | 全绿 |
| `web:test:auth-boot` | 1 | 门禁内 | 全绿 |
| `web:test:preview-url` | 1 | 门禁内 | 全绿 |
| `web:test:command-placeholders` | 1 | 门禁内 | 全绿 |
| `web:test:command-session-state` | 1 | 门禁内 | 全绿 |
| `web:test:terminal-dock` | 2 | 门禁内 | 全绿 |
| `web:test:project-settings-draft` | 1 | 门禁内 | 全绿 |
| `web:test:preview-assist-ui` | 1 | 门禁内 | 全绿 |
| `web:test:preview-log-live` | 1 | 门禁内 | 全绿 |
| `web:test:preview-task-switch` | 1 | 门禁内 | 全绿 |
| `web:test:preview-error-toast` | 1 | 门禁内 | 全绿 |
| `web:test:preview-port-guide` | 1 | 门禁内 | 全绿 |
| `web:test:settings-path-jump` | 1 | 门禁内 | 全绿 |
| `web:test:settings-card-fit` | 1 | 门禁内 | 全绿 |
| `web:test:reply-standing-executor` | 1 | 门禁内 | 全绿 |
| `web:test:branch-acceptance` | 3 | 门禁内 | **1 条非绿** |
| `web:test:accept-gate-dom` | 1 | 门禁内 | 全绿 |
| `web:test:reply-rail-dom` | 1 | 门禁内 | 全绿 |
| `web:test:task-creation-origin` | 1 | 门禁内 | 全绿 |
| `web:test:project-git-lifetime` | 1 | 门禁内 | 全绿 |
| `web:test:git-workbench` | 10 | 门禁外 | **2 条非绿** |
| `web:test:git-workbench-polling` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-design` | 1 | 门禁外 | **1 条非绿** |
| `web:test:git-workbench-header-resize` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-discard-menu` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-diff-prefixes` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-refresh-paths` | 1 | 门禁外 | **1 条非绿** |
| `web:test:git-workbench-busy-discard` | 1 | 门禁外 | 全绿 |
| `web:test:annotation-review` | 2 | 门禁外 | 全绿 |
| `web:test:preview-workspace` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-self-turn` | 1 | 门禁内 | 全绿 |

## 表 B:全量叶子(578 条)

| # | 包 | 叶子命令 | 门禁 | 结果 | 耗时 | 历次 |
|---|---|---|---|---|---|---|
| 10 | root | `test-accept-test.mjs` |  | 绿 | 3s | green |
| 3 | root | `test-process-identity.mjs` |  | 绿 | 0s | green |
| 4 | root | `test-process-ownership.mjs` |  | 绿 | 41s | green |
| 5 | root | `test-restart-options.mjs` |  | 绿 | 6s | green |
| 8 | root | `test-restart.mjs` |  | 绿 | 61s | green |
| 1 | root | `test-test-process-failures.mjs` |  | 绿 | 21s | green |
| 2 | root | `test-test-process.mjs` |  | 绿 | 21s | green |
| 7 | root | `test-windows-restart.mjs` |  | 绿 | 0s | green |
| 6 | root | `test-workspace-repair.mjs` |  | 绿 | 2s | green |
| 267 | server | `run-accept-gate-tests.mjs` | ✔ | **红** | 93s | red → red |
| 308 | server | `run-accept-gate-tests.mjs --command-only` |  | 绿 | 0s | green |
| 262 | server | `test-accept-auto-commit.ts` | ✔ | 绿 | 87s | green |
| 266 | server | `test-accept-cleanup.ts` | ✔ | 绿 | 321s | green |
| 264 | server | `test-accept-commit-setting.ts` | ✔ | 绿 | 15s | green |
| 307 | server | `test-accept-gate-process.ts` |  | 绿 | 35s | green |
| 263 | server | `test-accept-merge.ts` | ✔ | 绿 | 20s | green |
| 265 | server | `test-accept-pending-merge.ts` | ✔ | 绿 | 10s | green |
| 425 | server | `test-agent-attachments.ts` |  | 绿 | 0s | green |
| 443 | server | `test-agent-descendant-cleanup.ts` |  | 绿 | 2s | green |
| 426 | server | `test-agent-image-entry.ts` |  | 绿 | 4s | green |
| 427 | server | `test-agent-image-journal.ts` |  | 绿 | 0s | green |
| 428 | server | `test-agent-image-meta.ts` |  | 绿 | 0s | green |
| 430 | server | `test-agent-image-stream-window.ts` |  | 绿 | 1s | green |
| 429 | server | `test-agent-image-stream.ts` |  | 绿 | 3s | green |
| 442 | server | `test-agent-spawn-guard.ts` |  | 绿 | 0s | green |
| 362 | server | `test-answer-routing.ts` |  | 绿 | 1s | green |
| 459 | server | `test-anthropic-context-1m.ts` |  | 绿 | 1s | green |
| 355 | server | `test-archive-cleanup.ts` |  | 绿 | 13s | green |
| 356 | server | `test-archive-preview-guard.ts` |  | 绿 | 2s | green |
| 510 | server | `test-ash-mcp-file.ts` |  | 绿 | 1s | green |
| 317 | server | `test-ash-mcp-installer.ts` |  | 绿 | 1s | green |
| 511 | server | `test-ash-mcp-launch.ts` |  | 绿 | 1s | green |
| 509 | server | `test-ash-mcp-probe.ts` |  | 绿 | 26s | green |
| 508 | server | `test-ash-mcp-reach.ts` |  | **红** | 1s | red → red |
| 316 | server | `test-ash-mcp-registry.ts` |  | 绿 | 1s | green |
| 166 | server | `test-assistant.ts` |  | 绿 | 2s | green |
| 436 | server | `test-auto-title-run.ts` |  | 绿 | 1s | green |
| 435 | server | `test-auto-title.ts` |  | 绿 | 0s | green |
| 259 | server | `test-base-update-followups.ts` |  | 绿 | 116s | green |
| 258 | server | `test-base-update-recovery.ts` |  | **红** | 35s | red → red |
| 256 | server | `test-branch-acceptance.ts` |  | 绿 | 163s | green |
| 261 | server | `test-branch-plan-creation.ts` |  | **红** | 2s | red → red |
| 260 | server | `test-branch-plan-scale.ts` |  | 绿 | 19s | green |
| 257 | server | `test-branch-worktree-state.ts` |  | **红** | 2s | red → red |
| 397 | server | `test-browser-grant-timing.ts` |  | **红** | 1s | red → red |
| 396 | server | `test-browser-policy-grant.ts` |  | 绿 | 1s | green |
| 177 | server | `test-chat-ash-data.ts` |  | 绿 | 5s | green |
| 172 | server | `test-chat-boundary.ts` |  | 绿 | 14s | green |
| 167 | server | `test-chat-context.ts` |  | 绿 | 2s | green |
| 170 | server | `test-chat-deletion.ts` |  | 绿 | 2s | green |
| 171 | server | `test-chat-execution.ts` |  | 绿 | 11s | green |
| 176 | server | `test-chat-git-metadata.ts` |  | 绿 | 7s | green |
| 175 | server | `test-chat-large-workspace.ts` |  | 绿 | 16s | green |
| 173 | server | `test-chat-recovery.ts` |  | 绿 | 3s | green |
| 168 | server | `test-chat-review.ts` |  | 绿 | 2s | green |
| 174 | server | `test-chat-watch-load.ts` |  | 绿 | 7s | green |
| 169 | server | `test-chat.ts` |  | 绿 | 2s | green |
| 165 | server | `test-claude-goal-live.ts` |  | 绿 | 4s | green |
| 219 | server | `test-claude-monitor-backfill.ts` |  | 绿 | 1s | green |
| 229 | server | `test-claude-monitor-checkpoint.ts` |  | 绿 | 4s | green |
| 227 | server | `test-claude-monitor-completeness.ts` |  | 绿 | 9s | green |
| 228 | server | `test-claude-monitor-converge.ts` |  | 绿 | 4s | green |
| 216 | server | `test-claude-monitor-hook.ts` |  | 绿 | 4s | green |
| 224 | server | `test-claude-monitor-identity.ts` |  | 绿 | 1s | green |
| 220 | server | `test-claude-monitor-ledger.ts` |  | 绿 | 4s | green |
| 225 | server | `test-claude-monitor-origin.ts` |  | 绿 | 1s | green |
| 217 | server | `test-claude-monitor-parse.ts` |  | 绿 | 2s | green |
| 221 | server | `test-claude-monitor-pending-key.ts` |  | 绿 | 1s | green |
| 204 | server | `test-claude-monitor-projection.ts` |  | 绿 | 3s | green |
| 205 | server | `test-claude-monitor-reaped.ts` |  | 绿 | 2s | green |
| 223 | server | `test-claude-monitor-recovery.ts` |  | 绿 | 6s | green |
| 222 | server | `test-claude-monitor-unready.ts` |  | 绿 | 1s | green |
| 226 | server | `test-claude-monitor-upgrade.ts` |  | 绿 | 1s | green |
| 218 | server | `test-claude-monitor-wiring.ts` |  | 绿 | 2s | green |
| 375 | server | `test-claude-relay-settings-live.ts` |  | 绿 | 4s | green |
| 247 | server | `test-claude-retry-stall.ts` |  | 绿 | 1s | green |
| 374 | server | `test-claude-settings-live.ts` |  | 绿 | 3s | green |
| 394 | server | `test-claude-steer-ack.ts` |  | 绿 | 6s | green |
| 398 | server | `test-claude-stream-errors.ts` |  | 绿 | 11s | green |
| 432 | server | `test-claude-usage-accounting.ts` |  | 绿 | 1s | green |
| 433 | server | `test-claude-usage-migration.ts` |  | 绿 | 17s | green |
| 407 | server | `test-cleanup-debt.ts` |  | 绿 | 12s | green |
| 409 | server | `test-cleanup-ownership.ts` |  | 绿 | 6s | green |
| 408 | server | `test-cleanup-pending.ts` |  | 绿 | 1s | green |
| 405 | server | `test-cleanup-result.ts` |  | 绿 | 0s | green |
| 410 | server | `test-cleanup-write-handoff.ts` |  | 绿 | 13s | green |
| 163 | server | `test-cli-active-goal.ts` |  | 绿 | 1s | green |
| 377 | server | `test-cli-catalog.ts` |  | 绿 | 4s | green |
| 156 | server | `test-cli-command-startup.ts` |  | **红** | 1s | red → red |
| 155 | server | `test-cli-command-task.ts` |  | 绿 | 1s | green |
| 153 | server | `test-cli-commands.ts` |  | 绿 | 0s | green |
| 162 | server | `test-cli-goal-lifecycle.ts` |  | 绿 | 10s | green |
| 160 | server | `test-cli-goal-queue.ts` |  | 绿 | 27s | green |
| 159 | server | `test-cli-goal-recovery.ts` |  | 绿 | 8s | green |
| 380 | server | `test-cli-models.ts` |  | 绿 | 8s | green |
| 373 | server | `test-cli-overrides.ts` |  | **红** | 1s | red → red |
| 157 | server | `test-cli-plan-scheduling.ts` |  | **红** | 2s | red → red |
| 158 | server | `test-cli-state-scopes.ts` |  | 绿 | 1s | green |
| 416 | server | `test-codex-archive-live.ts` |  | 绿 | 27s | green |
| 415 | server | `test-codex-desktop-catalog.ts` |  | 绿 | 0s | green |
| 152 | server | `test-codex-diagnostics.ts` |  | 绿 | 1s | green |
| 154 | server | `test-codex-goal-bridge.ts` |  | 绿 | 1s | green |
| 315 | server | `test-codex-mcp-setup.mjs` |  | 绿 | 0s | green |
| 392 | server | `test-codex-mcp-turn-token.ts` |  | 绿 | 3s | green |
| 404 | server | `test-codex-resident.ts` |  | 绿 | 12s | green |
| 414 | server | `test-codex-resume-command.ts` |  | 绿 | 2s | green |
| 413 | server | `test-codex-session-archive.ts` |  | 绿 | 35s | green |
| 186 | server | `test-controllable-detached.ts` |  | 绿 | 1s | green |
| 420 | server | `test-conversation-turn.ts` |  | 绿 | 0s | green |
| 191 | server | `test-db-tx-ownership.ts` |  | 绿 | 0s | green |
| 185 | server | `test-detached-survival.ts` |  | 绿 | 4s | green |
| 161 | server | `test-diagnostic-session-reply.ts` |  | 绿 | 19s | green |
| 470 | server | `test-dir-picker.ts` |  | 绿 | 0s | green |
| 472 | server | `test-duet-attachments.ts` |  | 绿 | 1s | green |
| 507 | server | `test-duet-image-ownership.ts` |  | 绿 | 2s | green |
| 31 | server | `test-duet-native-trace.ts` | ✔ | 绿 | 2s | green |
| 400 | server | `test-duet-session-lost.ts` |  | 绿 | 1s | green |
| 401 | server | `test-duet-stall-visibility.ts` |  | 绿 | 1s | green |
| 360 | server | `test-executor-default-scope.ts` |  | 绿 | 1s | green |
| 372 | server | `test-executor-overrides.ts` |  | 绿 | 0s | green |
| 359 | server | `test-executor-resolution.ts` |  | 绿 | 2s | green |
| 462 | server | `test-file-browser.ts` |  | 绿 | 0s | green |
| 240 | server | `test-file-delete.ts` |  | 绿 | 3s | green |
| 467 | server | `test-file-search.ts` |  | 绿 | 0s | green |
| 236 | server | `test-follow-up.ts` |  | 绿 | 0s | green |
| 445 | server | `test-foreign-bins.ts` |  | 绿 | 0s | green |
| 303 | server | `test-free-preview-review-turn.ts` | ✔ | 绿 | 2s | green |
| 306 | server | `test-free-review-defer.ts` | ✔ | 绿 | 1s | green |
| 305 | server | `test-free-review-dispute.ts` | ✔ | 绿 | 1s | green |
| 298 | server | `test-free-review-reservation.ts` | ✔ | 绿 | 2s | green |
| 299 | server | `test-free-review-settlement.ts` | ✔ | 绿 | 6s | green |
| 301 | server | `test-free-workflow-hardening.ts` | ✔ | 绿 | 8s | green |
| 302 | server | `test-free-workflow-lifecycle.ts` | ✔ | 绿 | 5s | green |
| 297 | server | `test-free-workflow-preview.ts` | ✔ | 绿 | 4s | green |
| 296 | server | `test-free-workflow.ts` | ✔ | 绿 | 5s | green |
| 344 | server | `test-git-workbench-change-stats.ts` |  | 绿 | 1s | green |
| 342 | server | `test-git-workbench-maintenance.ts` |  | 绿 | 34s | green |
| 343 | server | `test-git-workbench-outcomes.ts` |  | 绿 | 75s | green |
| 345 | server | `test-git-workbench-partial-discard.ts` |  | 绿 | 19s | green |
| 341 | server | `test-git-workbench-safety.ts` |  | 绿 | 27s | green |
| 340 | server | `test-git-workbench.ts` |  | 绿 | 61s | green |
| 164 | server | `test-goal-native-live.ts` |  | 绿 | 97s | green |
| 332 | server | `test-handoff-accept-gate.ts` |  | 绿 | 1s | green |
| 331 | server | `test-handoff-accepted-return.ts` |  | 绿 | 4s | green |
| 324 | server | `test-handoff-auth.ts` |  | **红** | 7s | red → red |
| 321 | server | `test-handoff-capability-e2e.ts` |  | 绿 | 7s | green |
| 320 | server | `test-handoff-capability.ts` |  | **红** | 4s | red → red |
| 336 | server | `test-handoff-cli-config-dir.ts` |  | 绿 | 1s | green |
| 335 | server | `test-handoff-free-workflow-rows.ts` |  | 绿 | 0s | green |
| 334 | server | `test-handoff-holder.ts` |  | 绿 | 0s | green |
| 328 | server | `test-handoff-key-concurrency.ts` |  | 绿 | 1s | green |
| 327 | server | `test-handoff-key-persistence.ts` |  | 绿 | 1s | green |
| 323 | server | `test-handoff-local.ts` |  | 绿 | 1s | green |
| 333 | server | `test-handoff-notice.ts` |  | 绿 | 4s | green |
| 326 | server | `test-handoff-outbound-key.ts` |  | 绿 | 1s | green |
| 325 | server | `test-handoff-peer-key.ts` |  | 绿 | 1s | green |
| 319 | server | `test-handoff-remote-return.ts` |  | 绿 | 1s | green |
| 330 | server | `test-handoff-return.ts` |  | 绿 | 25s | green |
| 329 | server | `test-handoff-source-address.ts` |  | 绿 | 1s | green |
| 322 | server | `test-handoff.ts` |  | **红** | 6s | red → red |
| 406 | server | `test-holder-scan.ts` |  | **红** | 14s | red → red |
| 411 | server | `test-kernel-confine.ts` |  | 绿 | 0s | green |
| 412 | server | `test-kill-lineage.ts` |  | 绿 | 3s | green |
| 379 | server | `test-kimi-live.ts` |  | 绿 | 8s | green |
| 318 | server | `test-kimi-mcp.mjs` |  | 绿 | 0s | green |
| 378 | server | `test-kimi.ts` |  | 绿 | 2s | green |
| 485 | server | `test-launch-abandon-races.ts` |  | 绿 | 14s | green |
| 484 | server | `test-launch-abandon.ts` |  | 绿 | 3s | red → green |
| 460 | server | `test-llm-relay.ts` |  | 绿 | 3s | green |
| 468 | server | `test-local-open.ts` |  | 绿 | 0s | green |
| 471 | server | `test-mcp-handoff.ts` |  | 绿 | 1s | green |
| 497 | server | `test-missing-task-writes.ts` |  | 绿 | 1s | green |
| 376 | server | `test-model-effort-isolation.ts` |  | 绿 | 4s | green |
| 197 | server | `test-monitor-block-eligibility.ts` |  | 绿 | 29s | green |
| 181 | server | `test-monitor-checkpoint-recovery.ts` | ✔ | 绿 | 152s | green |
| 209 | server | `test-monitor-complete-columns.ts` |  | 绿 | 1s | green |
| 208 | server | `test-monitor-complete-gate.ts` |  | **红** | 4s | red → red |
| 199 | server | `test-monitor-create-protocol.ts` |  | 绿 | 5s | green |
| 202 | server | `test-monitor-create-window.ts` |  | 绿 | 14s | green |
| 180 | server | `test-monitor-delivery-batch.ts` |  | **红** | 53s | red → red |
| 196 | server | `test-monitor-end-condition-gate.ts` |  | 绿 | 2s | green |
| 195 | server | `test-monitor-end-condition.ts` |  | 绿 | 8s | red → green |
| 215 | server | `test-monitor-generation.ts` |  | 绿 | 5s | green |
| 200 | server | `test-monitor-intent-handover.ts` |  | 绿 | 19s | green |
| 193 | server | `test-monitor-offline.ts` |  | 绿 | 18s | green |
| 194 | server | `test-monitor-owed-batch.ts` |  | 绿 | 11s | green |
| 198 | server | `test-monitor-perturbation.ts` |  | 绿 | 0s | green |
| 203 | server | `test-monitor-races.ts` |  | **红** | 8s | red → red |
| 211 | server | `test-monitor-reclaim-debt.ts` |  | 绿 | 43s | green |
| 212 | server | `test-monitor-reclaim-identity.ts` |  | 绿 | 11s | green |
| 213 | server | `test-monitor-reclaim-unit.ts` |  | 绿 | 32s | green |
| 210 | server | `test-monitor-result-lifecycle.ts` |  | 绿 | 3s | green |
| 207 | server | `test-monitor-review-lifecycle.ts` |  | **红** | 2s | red → red |
| 201 | server | `test-monitor-settle-handover.ts` |  | 绿 | 33s | green |
| 214 | server | `test-monitor-unit-proof.ts` |  | 绿 | 40s | green |
| 179 | server | `test-monitor-wake-data.ts` |  | 绿 | 2s | green |
| 206 | server | `test-monitor-wake-role.ts` |  | 绿 | 4s | green |
| 192 | server | `test-monitors.ts` |  | 绿 | 16s | green |
| 493 | server | `test-multi-user-agent.ts` |  | 绿 | 1s | green |
| 492 | server | `test-multi-user-git.ts` |  | 绿 | 5s | green |
| 494 | server | `test-multi-user-members.ts` |  | 绿 | 1s | green |
| 495 | server | `test-multi-user-paths.ts` |  | 绿 | 0s | green |
| 491 | server | `test-multi-user-run.ts` |  | **红** | 3s | red → red |
| 496 | server | `test-multi-user-settings.ts` |  | 绿 | 0s | green |
| 310 | server | `test-multi-user-setup.ts` |  | 绿 | 2s | green |
| 309 | server | `test-multi-user.ts` |  | 绿 | 2s | green |
| 29 | server | `test-native-activity-stream.ts` | ✔ | 绿 | 1s | green |
| 28 | server | `test-native-agent-models.ts` | ✔ | 绿 | 1s | green |
| 371 | server | `test-native-command-turn.ts` |  | **红** | 1s | red → red |
| 393 | server | `test-native-steer.ts` |  | 绿 | 3s | green |
| 30 | server | `test-native-upload-visibility.ts` | ✔ | 绿 | 3s | green |
| 27 | server | `test-native-work.ts` | ✔ | 绿 | 2s | green |
| 490 | server | `test-no-libsql.ts` |  | 绿 | 1s | green |
| 385 | server | `test-note-task-history.ts` |  | 绿 | 1s | green |
| 311 | server | `test-onboarding-gate.ts` |  | 绿 | 1s | green |
| 241 | server | `test-open-in-ide.ts` |  | 绿 | 4s | green |
| 458 | server | `test-openai-converter.ts` |  | 绿 | 1s | green |
| 469 | server | `test-openers-windows.ts` |  | 绿 | 0s | green |
| 500 | server | `test-page-annotation-batches.ts` |  | 绿 | 1s | green |
| 489 | server | `test-path-boundary.ts` |  | 绿 | 0s | green |
| 434 | server | `test-peer-context.ts` |  | 绿 | 0s | green |
| 75 | server | `test-personal-cli-settings.ts` | ✔ | 绿 | 0s | green |
| 304 | server | `test-post-merge-review.ts` | ✔ | 绿 | 2s | green |
| 487 | server | `test-powershell-command.ts` |  | 绿 | 0s | green |
| 182 | server | `test-preview-annotation.ts` |  | 绿 | 0s | green |
| 183 | server | `test-preview-assist.ts` |  | 绿 | 12s | green |
| 499 | server | `test-preview-cache-path.ts` |  | 绿 | 0s | green |
| 447 | server | `test-preview-command.ts` |  | 绿 | 0s | green |
| 453 | server | `test-preview-cookies.ts` |  | 绿 | 0s | green |
| 498 | server | `test-preview-deps.ts` |  | 绿 | 3s | green |
| 452 | server | `test-preview-host-api.ts` |  | 绿 | 3s | green |
| 451 | server | `test-preview-launch.ts` |  | 绿 | 4s | green |
| 450 | server | `test-preview-lent-port.ts` |  | 绿 | 2s | green |
| 449 | server | `test-preview-log.ts` |  | 绿 | 0s | green |
| 457 | server | `test-preview-probe.ts` |  | 绿 | 0s | green |
| 454 | server | `test-preview-process.ts` |  | 绿 | 21s | green |
| 456 | server | `test-preview-seed.ts` |  | 绿 | 0s | green |
| 446 | server | `test-preview-settings-proxy.ts` |  | 绿 | 13s | green |
| 448 | server | `test-preview-static.ts` |  | 绿 | 4s | green |
| 455 | server | `test-preview-stop-notice.ts` |  | 绿 | 2s | green |
| 501 | server | `test-preview-workspace.ts` |  | 绿 | 5s | green |
| 188 | server | `test-process-identity.ts` |  | 绿 | 33s | green |
| 189 | server | `test-process-subtrees.ts` |  | 绿 | 8s | green |
| 346 | server | `test-project-clone.ts` |  | 绿 | 2s | green |
| 475 | server | `test-project-commands.ts` |  | **红** | 6s | red → red |
| 347 | server | `test-project-dir.ts` |  | 绿 | 1s | green |
| 348 | server | `test-project-git-config.ts` |  | 绿 | 3s | green |
| 338 | server | `test-project-git.ts` |  | 绿 | 13s | green |
| 271 | server | `test-prompt-budget.ts` | ✔ | 绿 | 1s | green |
| 363 | server | `test-question-history.ts` |  | 绿 | 1s | green |
| 230 | server | `test-queue-order.ts` |  | 绿 | 1s | green |
| 190 | server | `test-reattach.ts` |  | 绿 | 12s | green |
| 277 | server | `test-regression-availability.ts` | ✔ | 绿 | 2s | green |
| 278 | server | `test-regression-conclusion-atomicity.ts` | ✔ | 绿 | 6s | green |
| 295 | server | `test-regression-file-types.ts` | ✔ | 绿 | 3s | green |
| 274 | server | `test-regression-input.ts` | ✔ | 绿 | 7s | green |
| 276 | server | `test-regression-lifecycle.ts` | ✔ | 绿 | 5s | green |
| 275 | server | `test-regression-order.ts` | ✔ | 绿 | 7s | green |
| 280 | server | `test-regression-recovery.ts` | ✔ | 绿 | 36s | green |
| 273 | server | `test-regression-reuse.ts` | ✔ | 绿 | 11s | green |
| 279 | server | `test-regression-settlement.ts` | ✔ | 绿 | 22s | green |
| 272 | server | `test-regression-start.ts` | ✔ | 绿 | 3s | green |
| 255 | server | `test-reopen-acceptance.ts` |  | 绿 | 0s | green |
| 288 | server | `test-repair-start.ts` | ✔ | 绿 | 11s | green |
| 337 | server | `test-repo-lock.ts` |  | 绿 | 7s | green |
| 237 | server | `test-resume-prompt-broadcast.ts` |  | 绿 | 1s | green |
| 421 | server | `test-retry-turn.ts` |  | 绿 | 1s | green |
| 292 | server | `test-review-accepted-policy.ts` | ✔ | 绿 | 12s | green |
| 290 | server | `test-review-accepted-tail.ts` | ✔ | 绿 | 12s | green |
| 286 | server | `test-review-boundaries.ts` | ✔ | 绿 | 21s | green |
| 289 | server | `test-review-delivery-freeze.ts` | ✔ | 绿 | 19s | green |
| 285 | server | `test-review-entry.ts` | ✔ | 绿 | 11s | green |
| 269 | server | `test-review-flow.ts` | ✔ | 绿 | 2s | green |
| 294 | server | `test-review-gate-repair.ts` | ✔ | 绿 | 3s | green |
| 282 | server | `test-review-history.ts` | ✔ | 绿 | 44s | green |
| 281 | server | `test-review-ownership.ts` | ✔ | **红** | 14s | red → red |
| 293 | server | `test-review-repair-delivery.ts` | ✔ | 绿 | 15s | green |
| 300 | server | `test-review-resume.ts` | ✔ | 绿 | 1s | green |
| 291 | server | `test-review-start-recovery.ts` | ✔ | 绿 | 90s | green |
| 270 | server | `test-review-sweep.ts` | ✔ | 绿 | 1s | green |
| 287 | server | `test-review-transfer.ts` | ✔ | 绿 | 3s | green |
| 284 | server | `test-review-wait-storage.ts` | ✔ | **红** | 11s | red → red |
| 283 | server | `test-review-wait.ts` | ✔ | 绿 | 29s | green |
| 395 | server | `test-run-notices.ts` |  | 绿 | 2s | green |
| 388 | server | `test-scheduled-messages.ts` |  | 绿 | 144s | green |
| 350 | server | `test-scm-guard.ts` |  | 绿 | 14s | green |
| 351 | server | `test-scm-nested.ts` |  | 绿 | 3s | green |
| 349 | server | `test-scm-workspace.ts` |  | 绿 | 8s | green |
| 231 | server | `test-search-query.ts` |  | 绿 | 0s | green |
| 232 | server | `test-search-scan.ts` |  | 绿 | 1s | green |
| 233 | server | `test-search-visibility.ts` |  | 绿 | 2s | green |
| 251 | server | `test-seat-ownership.ts` |  | 绿 | 1s | green |
| 476 | server | `test-service-ports-scan.ts` |  | 绿 | 0s | green |
| 481 | server | `test-service-ports-script.ts` |  | 绿 | 18s | red → green |
| 480 | server | `test-service-ports.ts` |  | **红** | 18s | red → red |
| 399 | server | `test-session-lost.ts` |  | **红** | 1s | red → red |
| 402 | server | `test-session-notice.ts` |  | 绿 | 1s | green |
| 419 | server | `test-session-read-errors.ts` |  | 绿 | 1s | green |
| 417 | server | `test-session-trace.ts` |  | 绿 | 0s | green |
| 502 | server | `test-session-turn-identity.ts` |  | 绿 | 87s | green |
| 505 | server | `test-session-turn-migration.ts` |  | 绿 | 0s | green |
| 506 | server | `test-session-turn-persist.ts` |  | 绿 | 1s | green |
| 418 | server | `test-session-waiting.ts` |  | 绿 | 0s | green |
| 422 | server | `test-settlement-note.ts` |  | 绿 | 1s | green |
| 11 | server | `test-side-authorization.ts` | ✔ | 绿 | 0s | green |
| 13 | server | `test-side-chat-deletion.ts` | ✔ | 绿 | 1s | green |
| 12 | server | `test-side-chat.ts` | ✔ | 绿 | 6s | green |
| 184 | server | `test-singleton.ts` |  | 绿 | 21s | green |
| 461 | server | `test-skills.ts` |  | 绿 | 1s | green |
| 361 | server | `test-ssh-profile-retire.ts` |  | 绿 | 1s | green |
| 244 | server | `test-stall-flag.ts` |  | 绿 | 1s | green |
| 512 | server | `test-stall-journal.ts` |  | 绿 | 4s | green |
| 248 | server | `test-stall-restart.ts` |  | 绿 | 24s | green |
| 245 | server | `test-stall-settle.ts` |  | 绿 | 1s | green |
| 477 | server | `test-stop-evidence.ts` |  | 绿 | 0s | green |
| 478 | server | `test-stop-review.ts` |  | 绿 | 4s | green |
| 252 | server | `test-stop-turn-observation.ts` |  | 绿 | 1s | green |
| 479 | server | `test-stop-verification.ts` |  | 绿 | 9s | green |
| 387 | server | `test-task-activity.ts` |  | 绿 | 1s | green |
| 465 | server | `test-task-artifact-scope.ts` |  | 绿 | 6s | green |
| 464 | server | `test-task-artifacts.ts` |  | 绿 | 3s | green |
| 268 | server | `test-task-background-state.ts` | ✔ | 绿 | 1s | green |
| 382 | server | `test-task-creation-origin.ts` |  | 绿 | 1s | green |
| 381 | server | `test-task-derivation-policy.ts` |  | 绿 | 1s | green |
| 391 | server | `test-task-direction-epoch-entries.ts` |  | 绿 | 8s | green |
| 384 | server | `test-task-event-timestamps.ts` |  | 绿 | 1s | green |
| 463 | server | `test-task-file-raw.ts` |  | 绿 | 1s | green |
| 383 | server | `test-task-list-body.ts` |  | 绿 | 1s | green |
| 178 | server | `test-task-memos.ts` |  | 绿 | 1s | green |
| 466 | server | `test-task-page.ts` |  | 绿 | 1s | green |
| 386 | server | `test-task-star.ts` |  | 绿 | 1s | green |
| 389 | server | `test-task-steer-hardening.ts` |  | 绿 | 1s | green |
| 390 | server | `test-task-steer-rollback.ts` |  | 绿 | 1s | green |
| 239 | server | `test-task-workspace.ts` |  | 绿 | 7s | green |
| 369 | server | `test-team-inbound-durability.ts` |  | 绿 | 3s | green |
| 370 | server | `test-team-inbound-interleave.ts` |  | 绿 | 1s | green |
| 366 | server | `test-team-inbound-resilience.ts` |  | 绿 | 3s | green |
| 365 | server | `test-team-lead-resilience.ts` |  | 绿 | 4s | green |
| 364 | server | `test-team-native-command.ts` |  | 绿 | 1s | green |
| 368 | server | `test-team-notice-trace.ts` |  | 绿 | 2s | green |
| 403 | server | `test-team-session-notice.ts` |  | 绿 | 3s | green |
| 503 | server | `test-team-turn-artifacts.ts` |  | **红** | 1s | red → red |
| 367 | server | `test-team-user-interrupt.ts` |  | 绿 | 1s | green |
| 482 | server | `test-terminal-capacity.ts` |  | **红** | 13s | red → red |
| 483 | server | `test-terminal-lifecycle.ts` |  | 绿 | 5s | green |
| 473 | server | `test-terminal-pty.ts` |  | 绿 | 6s | green |
| 474 | server | `test-terminal.ts` |  | 绿 | 15s | green |
| 242 | server | `test-turn-baseline.ts` |  | 绿 | 3s | green |
| 423 | server | `test-turn-freeze.ts` |  | 绿 | 1s | green |
| 504 | server | `test-turn-identity-bridge.ts` |  | 绿 | 0s | green |
| 254 | server | `test-turn-output.ts` |  | 绿 | 1s | green |
| 249 | server | `test-turn-ownership.ts` |  | 绿 | 1s | green |
| 250 | server | `test-turn-reclaim.ts` |  | 绿 | 5s | green |
| 253 | server | `test-turn-release-ownership.ts` |  | 绿 | 1s | green |
| 246 | server | `test-turn-stall-progress.ts` |  | 绿 | 0s | green |
| 243 | server | `test-turn-stall.ts` |  | 绿 | 11s | green |
| 424 | server | `test-turn-visibility.ts` |  | 绿 | 2s | green |
| 234 | server | `test-upload-names.ts` |  | 绿 | 1s | green |
| 235 | server | `test-upload-visibility.ts` |  | 绿 | 6s | green |
| 431 | server | `test-usage-accounting.ts` |  | 绿 | 1s | green |
| 313 | server | `test-user-cli-mcp.ts` |  | 绿 | 1s | green |
| 312 | server | `test-user-cli-smoke.ts` |  | 绿 | 0s | green |
| 314 | server | `test-user-cli-write-identity.ts` |  | 绿 | 0s | green |
| 238 | server | `test-user-directives.ts` |  | 绿 | 0s | green |
| 488 | server | `test-user-shell-powershell.ts` |  | 绿 | 0s | green |
| 444 | server | `test-verify-override.ts` |  | 绿 | 2s | green |
| 486 | server | `test-win-launch.ts` |  | 绿 | 0s | green |
| 187 | server | `test-windows-detached.ts` |  | 绿 | 1s | green |
| 438 | server | `test-workflow-def.ts` |  | 绿 | 0s | green |
| 441 | server | `test-workflow-gate.ts` |  | 绿 | 2s | green |
| 439 | server | `test-workflow-library.ts` |  | 绿 | 1s | green |
| 437 | server | `test-workflow-mode-default.ts` |  | 绿 | 1s | green |
| 440 | server | `test-workflow-run.ts` |  | 绿 | 11s | green |
| 357 | server | `test-workspace-cleanup.ts` |  | 绿 | 3s | green |
| 358 | server | `test-workspace-dirty.ts` |  | 绿 | 1s | green |
| 353 | server | `test-worktree-default.ts` |  | 绿 | 2s | green |
| 354 | server | `test-worktree-leftover.ts` |  | 绿 | 3s | green |
| 339 | server | `test-worktree-porcelain.ts` |  | 绿 | 3s | green |
| 352 | server | `test-worktree-recovery.ts` |  | 绿 | 3s | green |
| 133 | web | `../server/scripts/test-file-delete.ts` | ✔ | 绿 | 6s | green |
| 127 | web | `../server/scripts/test-file-git-status.ts` | ✔ | 绿 | 2s | green |
| 22 | web | `../server/scripts/test-task-reply-fork.ts` | ✔ | 绿 | 2s | green |
| 123 | web | `test-accept-gate-dom.mjs` | ✔ | 绿 | 202s | green |
| 121 | web | `test-acceptance-workspace-commit-dom.mjs` | ✔ | 绿 | 20s | green |
| 564 | web | `test-agent-plate.mjs` |  | 绿 | 12s | green |
| 523 | web | `test-agent-profile-add-gate.mjs` |  | 绿 | 11s | green |
| 579 | web | `test-annotation-review-presentation.tsx` |  | 绿 | 4s | green |
| 578 | web | `test-annotation-review.ts` |  | 绿 | 0s | green |
| 85 | web | `test-assistant-entry.mjs` | ✔ | **红** | 23s | red → red |
| 106 | web | `test-auth-boot.mjs` | ✔ | 绿 | 18s | green |
| 122 | web | `test-branch-acceptance.mjs` | ✔ | **红** | 78s | red → red |
| 36 | web | `test-bulk-handoff-dialog.mjs` | ✔ | 绿 | 15s | green |
| 35 | web | `test-bulk-handoff.mjs` | ✔ | 绿 | 0s | green |
| 64 | web | `test-catch-up.mjs` | ✔ | 绿 | 0s | green |
| 516 | web | `test-chat-browser.mjs` |  | **红** | 24s | red → red |
| 51 | web | `test-claude-trace-accounting.mjs` | ✔ | 绿 | 0s | green |
| 513 | web | `test-cli-commands-ui.mjs` |  | **红** | 40s | red → red |
| 149 | web | `test-cli-effort-policy.mjs` | ✔ | 绿 | 14s | green |
| 514 | web | `test-cli-goal-lifecycle-ui.mjs` |  | **红** | 40s | red → red |
| 40 | web | `test-client-id.mjs` | ✔ | 绿 | 0s | green |
| 111 | web | `test-command-placeholders.mjs` | ✔ | 绿 | 17s | green |
| 113 | web | `test-command-session-state.mjs` | ✔ | 绿 | 0s | green |
| 90 | web | `test-composer-branches.mjs` | ✔ | 绿 | 21s | green |
| 91 | web | `test-composer-delete-race.mjs` | ✔ | 绿 | 17s | green |
| 88 | web | `test-composer-draft.mjs` | ✔ | 绿 | 17s | green |
| 89 | web | `test-composer-studio.mjs` | ✔ | 绿 | 21s | green |
| 87 | web | `test-composer-upload.mjs` | ✔ | 绿 | 17s | green |
| 83 | web | `test-confirm-enter.mjs` | ✔ | 绿 | 14s | green |
| 53 | web | `test-context-compact-quick.mjs` | ✔ | 绿 | 13s | green |
| 52 | web | `test-context-meter.tsx` | ✔ | 绿 | 2s | green |
| 42 | web | `test-conversation-continuation.tsx` | ✔ | 绿 | 2s | green |
| 23 | web | `test-conversation-fork-dom.mjs` | ✔ | 绿 | 15s | green |
| 21 | web | `test-conversation-fork.ts` | ✔ | 绿 | 0s | green |
| 57 | web | `test-conversation-notes-dom.mjs` | ✔ | 绿 | 13s | green |
| 41 | web | `test-conversation-notes.mjs` | ✔ | 绿 | 0s | green |
| 46 | web | `test-conversation-self-turn.mjs` | ✔ | 绿 | 0s | green |
| 45 | web | `test-conversation-steer.mjs` | ✔ | 绿 | 0s | green |
| 47 | web | `test-conversation-system-note.mjs` | ✔ | 绿 | 0s | green |
| 48 | web | `test-conversation-task-switch.mjs` | ✔ | 绿 | 25s | green |
| 59 | web | `test-copy-feedback-dom.mjs` | ✔ | 绿 | 16s | green |
| 78 | web | `test-create-project-scope.mjs` | ✔ | 绿 | 15s | green |
| 532 | web | `test-created-task-merge.mjs` |  | 绿 | 0s | green |
| 530 | web | `test-data-layer.mjs` |  | 绿 | 0s | green |
| 148 | web | `test-debate-lane.mjs` | ✔ | 绿 | 13s | green |
| 129 | web | `test-diff-model.ts` | ✔ | 绿 | 0s | green |
| 147 | web | `test-dispute-timeline-cta.mjs` | ✔ | 绿 | 17s | green |
| 538 | web | `test-duet-timeline.mjs` |  | 绿 | 0s | green |
| 96 | web | `test-duet-upload.mjs` | ✔ | 绿 | 14s | green |
| 522 | web | `test-executor-picker-field.mjs` |  | 绿 | 11s | green |
| 130 | web | `test-file-diff-view.mjs` | ✔ | 绿 | 17s | green |
| 134 | web | `test-file-entry-delete.mjs` | ✔ | 绿 | 14s | green |
| 563 | web | `test-file-layout-surfaces.mjs` |  | 绿 | 15s | green |
| 552 | web | `test-file-mention-dom.mjs` |  | 绿 | 16s | green |
| 551 | web | `test-file-mention.mjs` |  | 绿 | 0s | green |
| 132 | web | `test-file-reel.mjs` | ✔ | 绿 | 15s | green |
| 128 | web | `test-file-tree-git.mjs` | ✔ | 绿 | 22s | green |
| 131 | web | `test-file-view-zoom.mjs` | ✔ | 绿 | 15s | green |
| 525 | web | `test-free-review-copy.mjs` |  | 绿 | 0s | green |
| 135 | web | `test-free-review-defer-dom.mjs` | ✔ | 绿 | 15s | green |
| 136 | web | `test-free-review-delete.mjs` | ✔ | 绿 | 41s | green |
| 527 | web | `test-free-workflow-inspector.mjs` |  | 绿 | 16s | green |
| 570 | web | `test-git-workbench-conflict-errors.mjs` |  | 绿 | 61s | green |
| 569 | web | `test-git-workbench-conflict-gates.mjs` |  | 绿 | 52s | green |
| 566 | web | `test-git-workbench-polling.mjs` |  | 绿 | 45s | green |
| 571 | web | `test-git-workbench-review-fixes.mjs` |  | **红** | 19s | red → red |
| 568 | web | `test-git-workbench-review.mjs` |  | 绿 | 50s | green |
| 567 | web | `test-git-workbench.mjs` |  | 绿 | 59s | green |
| 39 | web | `test-handoff-dialog-lifetime.mjs` | ✔ | 绿 | 0s | green |
| 546 | web | `test-handoff-source-addresses.mjs` |  | 绿 | 19s | green |
| 517 | web | `test-image-preview.mjs` |  | 绿 | 11s | green |
| 518 | web | `test-inspector-attachments.mjs` |  | 绿 | 11s | green |
| 92 | web | `test-inspector-queue.mjs` | ✔ | 绿 | 13s | green |
| 99 | web | `test-inspector-shortcut-stack.mjs` | ✔ | 绿 | 13s | green |
| 98 | web | `test-inspector-shortcuts.mjs` | ✔ | 绿 | 0s | green |
| 97 | web | `test-key-chord.mjs` | ✔ | 绿 | 0s | green |
| 138 | web | `test-markdown-images.mjs` | ✔ | 绿 | 14s | green |
| 71 | web | `test-monitor-composer-dom.mjs` | ✔ | 绿 | 13s | green |
| 70 | web | `test-monitor-inspector-dom.mjs` | ✔ | 绿 | 34s | green |
| 69 | web | `test-monitor-inspector.tsx` | ✔ | 绿 | 1s | green |
| 43 | web | `test-monitor-wake.tsx` | ✔ | **红** | 1s | red → red |
| 515 | web | `test-native-agent-segments.mjs` |  | 绿 | 0s | green |
| 34 | web | `test-native-work-dom.mjs` | ✔ | 绿 | 17s | green |
| 32 | web | `test-native-work-metadata.ts` | ✔ | 绿 | 0s | green |
| 33 | web | `test-native-work-presentation.tsx` | ✔ | 绿 | 2s | green |
| 95 | web | `test-notes-delete-race.mjs` | ✔ | 绿 | 21s | green |
| 94 | web | `test-notes-empty-body.mjs` | ✔ | 绿 | 19s | green |
| 549 | web | `test-notes-filter.mjs` |  | 绿 | 0s | green |
| 93 | web | `test-notes-upload.mjs` | ✔ | 绿 | 14s | green |
| 520 | web | `test-open-in-ide-menu.mjs` |  | 绿 | 11s | green |
| 519 | web | `test-open-with-menu.mjs` |  | 绿 | 11s | green |
| 548 | web | `test-outbound-state.mjs` |  | 绿 | 0s | green |
| 120 | web | `test-page-interactions.tsx` | ✔ | 绿 | 4s | green |
| 26 | web | `test-page-token-delivery.mjs` | ✔ | 绿 | 3s | green |
| 100 | web | `test-palette-keys.mjs` | ✔ | 绿 | 0s | green |
| 101 | web | `test-palette-search.mjs` | ✔ | 绿 | 17s | green |
| 76 | web | `test-personal-cli-settings.mjs` | ✔ | 绿 | 13s | green |
| 110 | web | `test-preview-assist-ui.mjs` | ✔ | 绿 | 162s | green |
| 116 | web | `test-preview-error-toast.mjs` | ✔ | 绿 | 21s | green |
| 114 | web | `test-preview-log-live.mjs` | ✔ | 绿 | 54s | green |
| 117 | web | `test-preview-port-guide.mjs` | ✔ | 绿 | 14s | green |
| 115 | web | `test-preview-task-switch.mjs` | ✔ | 绿 | 13s | green |
| 107 | web | `test-preview-url.tsx` | ✔ | 绿 | 4s | green |
| 108 | web | `test-preview-workspace-launch.tsx` | ✔ | 绿 | 44s | green |
| 126 | web | `test-project-git-lifetime.mjs` | ✔ | 绿 | 18s | green |
| 77 | web | `test-project-member-role.mjs` | ✔ | 绿 | 12s | green |
| 109 | web | `test-project-settings-draft.mjs` | ✔ | 绿 | 19s | green |
| 150 | web | `test-provider-visibility.mjs` | ✔ | 绿 | 18s | green |
| 24 | web | `test-question-card.tsx` | ✔ | 绿 | 3s | green |
| 25 | web | `test-question-history-dom.mjs` | ✔ | 绿 | 35s | green |
| 534 | web | `test-queue-after.mjs` |  | 绿 | 0s | green |
| 38 | web | `test-remote-return.mjs` | ✔ | **红** | 35s | red → red |
| 37 | web | `test-remote-task.mjs` | ✔ | 绿 | 0s | green |
| 554 | web | `test-reply-drafts.mjs` |  | 绿 | 13s | green |
| 15 | web | `test-reply-quote.ts` | ✔ | 绿 | 0s | green |
| 124 | web | `test-reply-rail-dom.mjs` | ✔ | 绿 | 16s | green |
| 565 | web | `test-reply-resize.mjs` |  | 绿 | 13s | green |
| 105 | web | `test-reply-standing-executor.mjs` | ✔ | 绿 | 22s | green |
| 139 | web | `test-report-roots.mjs` | ✔ | 绿 | 0s | green |
| 529 | web | `test-review-diff-zoom.mjs` |  | 绿 | 13s | green |
| 56 | web | `test-review-lane-monitor-wake.mjs` | ✔ | 绿 | 0s | green |
| 55 | web | `test-review-presentation.tsx` | ✔ | 绿 | 1s | green |
| 141 | web | `test-review-report-boundary.mjs` | ✔ | 绿 | 0s | green |
| 143 | web | `test-review-report-claim.mjs` | ✔ | 绿 | 0s | green |
| 142 | web | `test-review-report-fallback.mjs` | ✔ | 绿 | 0s | green |
| 140 | web | `test-review-report-format.mjs` | ✔ | 绿 | 0s | green |
| 145 | web | `test-review-report-split-dom.mjs` | ✔ | 绿 | 15s | green |
| 146 | web | `test-review-report-summary-fold-dom.mjs` | ✔ | 绿 | 14s | green |
| 144 | web | `test-review-report-summary-fold.mjs` | ✔ | 绿 | 0s | green |
| 526 | web | `test-reviewer-profile-summary.mjs` |  | 绿 | 10s | green |
| 540 | web | `test-reviewer-turn-dom.mjs` |  | 绿 | 14s | green |
| 54 | web | `test-reviewer-turn.mjs` | ✔ | 绿 | 0s | green |
| 151 | web | `test-roving-choice.mjs` | ✔ | 绿 | 13s | green |
| 536 | web | `test-run-activity.mjs` |  | 绿 | 0s | green |
| 521 | web | `test-run-target-picker.mjs` |  | 绿 | 11s | green |
| 68 | web | `test-scheduled-message-reply.mjs` | ✔ | 绿 | 16s | green |
| 67 | web | `test-scheduled-message-tray-dom.mjs` | ✔ | 绿 | 17s | green |
| 66 | web | `test-scheduled-message-tray.tsx` | ✔ | 绿 | 1s | green |
| 562 | web | `test-scm-file-layout.mjs` |  | 绿 | 13s | green |
| 561 | web | `test-scm-nested-ui.mjs` |  | 绿 | 13s | green |
| 558 | web | `test-scm-paths.mjs` |  | 绿 | 0s | green |
| 560 | web | `test-scm-race.mjs` |  | **红** | 40s | red → red |
| 559 | web | `test-scm-stale.mjs` |  | 绿 | 13s | green |
| 82 | web | `test-segment-layout-dom.mjs` | ✔ | 绿 | 17s | green |
| 86 | web | `test-select-all-on-focus.mjs` | ✔ | 绿 | 14s | green |
| 20 | web | `test-selection-content.mjs` | ✔ | 绿 | 18s | green |
| 84 | web | `test-send-key.mjs` | ✔ | 绿 | 18s | green |
| 531 | web | `test-session-merge.mjs` |  | 绿 | 0s | green |
| 119 | web | `test-settings-card-fit.mjs` | ✔ | 绿 | 15s | green |
| 118 | web | `test-settings-path-jump.mjs` | ✔ | 绿 | 14s | green |
| 533 | web | `test-settle-created-task.mjs` |  | 绿 | 0s | green |
| 49 | web | `test-settlement-note.mjs` | ✔ | 绿 | 0s | green |
| 16 | web | `test-side-chat-browser.mjs` | ✔ | 绿 | 86s | green |
| 18 | web | `test-side-chat-direct-browser.mjs` | ✔ | 绿 | 20s | green |
| 17 | web | `test-side-chat-selection-browser.mjs` | ✔ | 绿 | 21s | green |
| 14 | web | `test-side-chat-state.ts` | ✔ | 绿 | 0s | green |
| 19 | web | `test-side-chat-upload.mjs` | ✔ | 绿 | 21s | green |
| 103 | web | `test-sidebar-navigation.mjs` | ✔ | 绿 | 18s | green |
| 104 | web | `test-sidebar-remote-race.mjs` | ✔ | 绿 | 23s | green |
| 550 | web | `test-slash-match.mjs` |  | 绿 | 0s | green |
| 547 | web | `test-spread-filter.mjs` |  | 绿 | 0s | green |
| 81 | web | `test-stick-to-bottom-dom.mjs` | ✔ | 绿 | 21s | green |
| 80 | web | `test-stick-to-bottom.mjs` | ✔ | 绿 | 0s | green |
| 60 | web | `test-system-notices-dom.mjs` | ✔ | 绿 | 18s | green |
| 63 | web | `test-task-catch-up-dom.mjs` | ✔ | 绿 | 32s | green |
| 125 | web | `test-task-creation-origin.mjs` | ✔ | 绿 | 20s | green |
| 72 | web | `test-task-memo-dom.mjs` | ✔ | 绿 | 22s | green |
| 544 | web | `test-task-mode-paging.mjs` |  | 绿 | 17s | green |
| 65 | web | `test-task-read-state.mjs` | ✔ | 绿 | 0s | green |
| 528 | web | `test-task-review-rounds.mjs` |  | 绿 | 13s | green |
| 535 | web | `test-task-sync.mjs` |  | **红** | 0s | red → red |
| 545 | web | `test-task-tree-offline.mjs` |  | 绿 | 13s | green |
| 543 | web | `test-task-tree-paging.mjs` |  | 绿 | 13s | green |
| 542 | web | `test-task-tree-preview.mjs` |  | 绿 | 14s | green |
| 541 | web | `test-task-tree.mjs` |  | 绿 | 0s | green |
| 524 | web | `test-team-review-inspector.mjs` |  | 绿 | 11s | green |
| 112 | web | `test-terminal-dock.mjs` | ✔ | 绿 | 15s | green |
| 537 | web | `test-tool-summary.mjs` |  | 绿 | 0s | green |
| 539 | web | `test-turn-fold-dom.mjs` |  | 绿 | 14s | green |
| 50 | web | `test-turn-fold.mjs` | ✔ | 绿 | 0s | green |
| 137 | web | `test-turn-images.mjs` | ✔ | 绿 | 0s | green |
| 62 | web | `test-turn-remedy-catch-up-dom.mjs` | ✔ | 绿 | 27s | green |
| 61 | web | `test-turn-remedy-dom.mjs` | ✔ | 绿 | 13s | green |
| 557 | web | `test-turn-retry.mjs` |  | 绿 | 0s | green |
| 79 | web | `test-ui-polish.mjs` | ✔ | 绿 | 12s | green |
| 58 | web | `test-upstream-retry-placement.tsx` | ✔ | 绿 | 1s | green |
| 74 | web | `test-users-role.mjs` | ✔ | 绿 | 15s | green |
| 73 | web | `test-withdraw-scheduled.mjs` | ✔ | 绿 | 16s | green |
| 556 | web | `test-workflow-edit.mjs` |  | 绿 | 0s | green |
| 555 | web | `test-workflow-rail.mjs` |  | 绿 | 0s | green |
| 553 | web | `test-workspace-history.mjs` |  | 绿 | 0s | green |
| 102 | web | `test-workspace-shortcuts.mjs` | ✔ | 绿 | 14s | green |
| 44 | web | `tsconfig.json scripts/test-monitor-wake-delivery.tsx` | ✔ | 绿 | 3s | green |
| 575 | web | `verify-git-workbench-busy-discard.mjs` |  | 绿 | 32s | green |
| 576 | web | `verify-git-workbench-design.mjs` |  | **红** | 17s | red → red |
| 573 | web | `verify-git-workbench-diff-prefixes.mjs` |  | 绿 | 45s | green |
| 572 | web | `verify-git-workbench-discard-menu.mjs` |  | 绿 | 46s | green |
| 577 | web | `verify-git-workbench-header-resize.mjs` |  | 绿 | 37s | green |
| 574 | web | `verify-git-workbench-refresh-paths.mjs` |  | **红** | 34s | red → red |