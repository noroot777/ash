import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = '/Users/fjh/code/harness/.worktrees/1GYkm4-K_7zu';
const stage = mkdtempSync(join(tmpdir(), 'ash-review-preflight-'));
process.env.ASH_DB = join(stage, 'probe.db');
process.env.ASH_RUNS_DIR = join(stage, 'runs');
const { db, dbClient, ensureSchema } = await import(`${source}/server/src/db/index.ts`);
const { projects, tasks } = await import(`${source}/server/src/db/schema.ts`);
const { mergePreflight } = await import(`${source}/server/src/task-accept-merge-preflight.ts`);
const git = (...args) => execFileSync('git', ['-C', stage, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Review Probe');
  git('config', 'user.email', 'review@example.invalid');
  writeFileSync(join(stage, 'seed'), 'seed');
  git('add', 'seed');
  git('commit', '-m', 'fixture');
  git('branch', 'other');
  git('branch', 'ash/prefligh');
  await ensureSchema();
  const createdAt = new Date().toISOString();
  await db.insert(projects).values({ id: 'probe', name: 'probe', repoPath: stage, createdAt });
  await db.insert(tasks).values({ id: 'preflight-probe', projectId: 'probe', title: 'probe', body: '', status: 'done', useWorktree: true, workflowMode: 'free', createdAt, updatedAt: createdAt });
  const project = (await db.select().from(projects))[0];
  const stale = (await db.select().from(tasks))[0];
  console.log('before', { inputTarget: stale.acceptedTargetBranch, checkout: git('branch', '--show-current') });
  const first = await mergePreflight(stale, project, 'human'); console.log('firstResult', first.failure, 'returnedTarget', first.task.acceptedTargetBranch);
  console.log('afterFirst', { persistedTarget: (await db.select().from(tasks))[0].acceptedTargetBranch, inputTarget: stale.acceptedTargetBranch });
  git('checkout', 'other');
  const second = await mergePreflight(stale, project, 'human'); console.log('secondResult(stale input)', second.failure, 'returnedTarget', second.task.acceptedTargetBranch); const third = await mergePreflight(first.task, project, 'human'); console.log('thirdResult(frozen input)', third.failure, 'returnedTarget', third.task.acceptedTargetBranch);
  console.log('afterSecond', { persistedTarget: (await db.select().from(tasks))[0].acceptedTargetBranch, inputTarget: stale.acceptedTargetBranch, checkout: git('branch', '--show-current') });
} finally {
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
