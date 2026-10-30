// ── 跑一个子进程,并且**证明**它创建的东西都停了 ─────────────────────────────────
// 结果校验(退出码、信号、双流收齐)与所有权证明都收在这里,调用方只拿一个结论。
// 所有权与「谁还活着」的判据在 test-process-scope.mjs 顶部。
import assert from "node:assert/strict";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestProcessScope, delay, preservedPids } from "./test-process-scope.mjs";

export function assertProcessResult(result, expectedStatus = 0, label = "子进程") {
  const details = `${label}: status=${result.status}, signal=${result.signal}, error=${result.error?.code ?? "none"}\n${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    throw Object.assign(new Error(details, { cause: result.error }), {
      code: result.error.code, stdout: result.stdout, stderr: result.stderr,
    });
  }
  assert.equal(result.signal, null, details);
  assert.equal(result.status, expectedStatus, details);
  assert.equal(typeof result.stdout, "string", `${label}: stdout 未完整收集`);
  assert.equal(typeof result.stderr, "string", `${label}: stderr 未完整收集`);
  return result;
}

export async function runTestProcess(command, args, options = {}, expectedStatus = 0) {
  const descriptors = [];
  const { timeout = 120_000, preserveScripts = [], ...spawnOptions } = options;
  // 这两个目录都在 try 之外建过:谁先建成、后一个建失败(磁盘满、配额),前一个就没人回收
  // 了(N2 实测留下两个目录)。所以都挪进来,由同一个 finally 负责。
  let temporary;
  let scope;
  let completed = false;
  let expired = false;
  /** 子进程自己有没有按预期收场(与「它创建的工作停没停」是两件事)。 */
  let settled = false;
  let timer;
  let result;
  let operationError;
  /** 子进程自己结束了、却还没停下来的那些行(见下面 settle)。 */
  let stranded = [];
  const captured = { stdout: "", stderr: "" };
  const cleanupErrors = [];
  let stdoutPath;
  let stderrPath;
  try {
    temporary = mkdtempSync(join(tmpdir(), "ash-test-process-"));
    stdoutPath = join(temporary, "stdout.log");
    stderrPath = join(temporary, "stderr.log");
    scope = new TestProcessScope();
    const stdout = openSync(stdoutPath, "w");
    descriptors.push(stdout);
    const stderr = openSync(stderrPath, "w");
    descriptors.push(stderr);
    const capturedStreams = descriptors.map((descriptor) => { const stat = fstatSync(descriptor); return `${stat.dev}:${stat.ino}`; });
    const child = scope.spawn(command, args, {
      ...spawnOptions,
      stdio: ["ignore", stdout, stderr],
    });
    const finished = new Promise((resolveResult) => {
      child.once("error", (error) => resolveResult({ status: null, signal: null, error }));
      child.once("exit", (status, signal) => resolveResult({ status, signal }));
    });
    const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
    const expiration = new Promise((resolveTimeout) => {
      if (timeout > 0) timer = setTimeout(() => { expired = true; resolveTimeout(null); }, timeout);
    });
    result = await Promise.race([finished, expiration]);
    /**
     * 「本次创建的、不该保留的工作都停了」—— 收齐输出之前必须先拿到这个证明。
     *
     * 两件事与旧写法不同,都是实测踩出来的:
     *  · 扫描**失败**绝不等于「没有活的」。查不动进程表时旧写法会抛,但抛的是什么没人
     *    关心;这里显式区分,把「证明不了」走失败路径,不让它长得像清场成功。
     *  · 到点仍有活的也不是超时,而是**遗留**:子进程自己早就正常退出了,是它留下的后代
     *    还在跑(原生 fork+setsid 那一类,父子链和进程组都断了,环境块这条线索才认得出
     *    它们)。这时如实报遗留,不能返回成功 —— 旧写法两种模式都返回了,而后代随后还
     *    在往 stdout 和磁盘上写。
     */
    const settle = async () => {
      while (true) {
        const survey = await scope.survey();
        if (!survey.ok) throw survey.error;
        const spared = preservedPids(scope, preserveScripts, capturedStreams);
        const live = survey.rows.filter((row) => !spared.has(row.pid));
        if (!live.length) return [];
        if (expired || Date.now() >= deadline) return live;
        await delay(30);
      }
    };
    // 子进程自己是不是正常收场。**这一格定下来之后就不许再被超时改写**:它已经退出了,
    // 后面那段等待等的是它留下的后代,到点了该报遗留而不是报「子进程超时」—— 两种诊断
    // 指向完全不同的两件事,混成一句话,下一个人会去调 timeout。
    settled = !!result && !result.error && !result.signal && result.status === expectedStatus;
    if (settled) stranded = await settle();
    clearTimeout(timer);
    if (!settled && (!result || expired)) result = { ...result, error: Object.assign(new Error("测试执行超时"), { code: "ETIMEDOUT" }) };
    if (result.error || result.signal || result.status !== expectedStatus || stranded.length) {
      await scope.stop();
      await finished;
    }
    const remaining = await scope.active();
    if (!remaining.length) scope.remove();
    completed = true;
  } catch (error) { operationError = error; }
  finally {
    clearTimeout(timer);
    const cleanupScope = async () => {
      if (!scope || !existsSync(scope.directory)) return;
      try { await scope.stop(); scope.remove(); }
      catch (error) { cleanupErrors.push(error); }
    };
    if (!completed) await cleanupScope();
    for (const [stream, path] of [["stdout", stdoutPath], ["stderr", stderrPath]]) {
      if (!path) continue;
      try { captured[stream] = readFileSync(path, "utf8"); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (completed && cleanupErrors.length) await cleanupScope();
    for (const descriptor of descriptors) {
      try { closeSync(descriptor); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  if (expired && !settled) result = { ...result, error: Object.assign(new Error("测试执行超时"), { code: "ETIMEDOUT" }) };
  if (!result) result = { status: null, signal: null, error: operationError };
  let failure;
  try { assertProcessResult({ ...result, ...captured }, expectedStatus, command); }
  catch (error) { failure = error; }
  const strandedError = stranded.length
    ? Object.assign(new Error(`${command}: 子进程已结束，但本次创建的工作仍在运行（${stranded.map((row) => row.pid).join(",")}），已强制停止`),
      { code: "ESTRANDED", pids: stranded.map((row) => row.pid) })
    : undefined;
  const errors = [failure, strandedError, operationError, ...cleanupErrors].filter(Boolean);
  if (errors.length) {
    if (errors.length === 1 && failure) throw failure;
    const cause = failure ?? strandedError ?? operationError ?? cleanupErrors[0];
    throw Object.assign(new AggregateError(errors,
      `${command}: 测试执行或清理失败\n${errors.map((error) => error.message).join("\n")}\n${captured.stdout}${captured.stderr}`, { cause }), {
      code: cause.code, ...captured, cleanupErrors,
    });
  }
  return { ...result, ...captured };
}
