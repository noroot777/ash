// 目录观察并发负载回归（审查第 5 轮 P1）：以 4 路并发（与 ChatService 最多 4 个 active
// 回复一致）重复真实写入/编辑/改名，observer 不得漏报。固定 100ms 结算延时曾在这种负载
// 下 3/12 漏报（rename / edit-existing / sync-write 拿到空附注）——晚到的 FSEvents 事件
// 被 close() 永久丢弃且不降级。静默结算 + 武装窗口后必须稳定捕获；另铺不在观察范围内的
// 背景 churn 抬高 fseventsd 投递负载，逼近真实并发场景。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-watch-load-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { watchChatWorkspace } = await import("../src/chat/boundary.js");

const ROUNDS = 6;
const WORKERS = 4;
const churnDir = join(stage, "churn");
mkdirSync(churnDir);
const failures: string[] = [];
try {
  for (let round = 0; round < ROUNDS; round++) {
    await Promise.all(Array.from({ length: WORKERS }, async (_, worker) => {
      const dir = join(stage, `w${worker}-r${round}`);
      mkdirSync(dir);
      const existing = join(dir, "existing.txt");
      writeFileSync(existing, "before");
      writeFileSync(join(dir, "from.txt"), "move me");
      const observer = await watchChatWorkspace(dir);
      // 背景 churn：不在任何被观察目录里，但同样流经 fseventsd，抬高投递延迟。
      for (let i = 0; i < 25; i++) writeFileSync(join(churnDir, `w${worker}-r${round}-${i}.txt`), String(i));
      // 三种真实变化都写在 watch 返回后立刻发生——正是曾经漏报的启动/投递窗口。
      writeFileSync(join(dir, "created.txt"), "written right after watch armed");
      writeFileSync(existing, "after");
      renameSync(join(dir, "from.txt"), join(dir, "renamed.txt"));
      const result = await observer.settle();
      for (const expected of [/created\.txt/, /existing\.txt/, /renamed\.txt|from\.txt/]) {
        if (!result.paths.some((path) => expected.test(path))) failures.push(`w${worker} r${round}: ${expected} 未捕获，paths=${JSON.stringify(result.paths)} degraded=${result.degraded ?? "无"}`);
      }
      if (result.degraded) failures.push(`w${worker} r${round}: 不应降级（写入在结算前已停止）：${result.degraded}`);
    }));
  }
  assert.equal(failures.length, 0, `并发负载下目录观察漏报：\n${failures.join("\n")}`);
  console.log(`chat watch load: ${ROUNDS} 轮 × ${WORKERS} 路并发的真实写入/编辑/改名全部捕获，无降级`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
