// `shared/src/legacy-names.ts` 的镜像：scripts 要在没有 TS 支持的 Node 上裸跑，导不了那份 .ts。
// 每一项的含义和「什么时候可以拆」都写在那份里，这里不复述；两份一致由
// `server/scripts/test-rename-compat.ts` 钉住 —— 改一边不改另一边，那条测试就红。
//
// 跟那份一样：旧名只在这两份文件里出现，别处要认旧名就从这里取。

export const LEGACY_ENV_PREFIXES = ["ASH_", "HARNESS_"];
export const LEGACY_MCP_SERVER_NAMES = ["ash", "harness"];
export const LEGACY_TASK_BRANCH_PREFIXES = ["ash/", "harness/"];
export const LEGACY_ACCEPT_TAG_PREFIX = "ash-accepted/";
export const LEGACY_DB_FILE = "ash.db";
export const LEGACY_HARNESS_DB_FILE = "harness.db";
export const LEGACY_SINGLETON_LOCK_SUFFIX = ".ash.lock";
export const LEGACY_RESOURCE_CLAIM_SUFFIX = ".ash-claim.lock";
export const LEGACY_PRESENCE_PREFIX = ".ash-online.";
export const LEGACY_PREVIEW_DEPS_READY_MARK = ".ash-deps-ready";
export const LEGACY_HTTP_HEADER_PREFIX = "x-ash-";
export const LEGACY_SESSION_COOKIE = "ash_session";
export const LEGACY_INSTANCE_COOKIE = "ash_instance";
export const LEGACY_HANDOFF_SERVICE = "ash";
export const LEGACY_PREVIEW_ANNOTATION_PROTOCOL = "ash-preview-annotation-v1";
export const LEGACY_GIT_WORKBENCH_DIR = "ash-workbench";
export const LEGACY_GIT_WORKTREE_BACKUPS_DIR = "ash-worktree-backups";
export const LEGACY_LOG_TAG = "[ash]";
export const LEGACY_TURN_PROGRESS_WATCH_HEAD = "ash-turn-progress-watch/v2";
export const FROZEN_HANDOFF_SIGNATURE_DOMAIN = "ash-handoff-v1";
export const FROZEN_HANDOFF_ENCRYPTION_DOMAIN = "ash-handoff-enc-v1";
export const FROZEN_HANDOFF_ENCRYPTION_MAGIC = "ash-enc1";
export const FROZEN_IM_BIND_SALT = "ash-im-bind:";
export const FROZEN_GIT_REF_NAMESPACE = "refs/ash/";
export const FROZEN_GIT_BACKUP_REF_NAMESPACE = "refs/ash-backup/";
export const FROZEN_HUMAN_APPROVAL_PURPOSE = "ash-human-approval-v1";
export const FROZEN_AGENT_UNIT_PREFIX = "ash-agent-";
export const FROZEN_CONFINE_TMP_DIR = "ash-confine";
export const FROZEN_WINDOWS_AGENT_WRAP_SUFFIX = ".ash-agent-wrap.cjs";
export const FROZEN_CODEX_RELAY_PROVIDER_ID = "ash_relay";
