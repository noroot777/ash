import assert from "node:assert/strict";
import { codexSpec } from "../src/executors/catalog/codex.js";
import { CodexExecutor } from "../src/executors/codex.js";
import { codexRelay } from "../src/executors/codex-provider.js";
import { protocolConverterBaseUrl } from "../src/openai-converter/common.js";
import type { RelayConfig, RunOpts } from "../src/executors/types.js";

type ExecutorConfig = {
  relayArgs(): string[];
  env(): Record<string, string | undefined>;
  execArgs(opts: Pick<RunOpts, "cwd" | "model" | "extraArgs" | "env">, sessionId: string): string[];
  appServerArgs(opts: Pick<RunOpts, "extraArgs" | "env">): { args: string[]; ignored: string[] };
};

const actorHeader = 'model_providers.ash_relay.http_headers.x-openai-actor-authorization="codex-imagegen-enabled"';
const relay: RelayConfig = {
  providerId: "fixture-provider",
  name: "Fixture",
  baseUrl: "https://provider.invalid",
  apiKey: "private-fixture-key-not-for-argv",
  defaultModel: "fixture-model",
  protocolConversionEnabled: false,
  context1mModels: [],
};

for (const baseUrl of ["https://provider.invalid", "https://provider.invalid/v1/", "https://provider.invalid/v2/"]) {
  for (const protocolConversionEnabled of [false, true]) {
    const configured = { ...relay, baseUrl, protocolConversionEnabled };
    const wiring = codexRelay(configured);
    const declared = codexSpec.exec.relay!(configured);
    assert.deepEqual(declared, wiring, "声明路径与执行器共用供应商配置");
    assert.deepEqual(wiring.env, { ASH_RELAY_KEY: relay.apiKey });
    assert.equal(wiring.envHint, "ASH_RELAY_KEY=<你的key> ");
    assert.ok(wiring.args!.includes(actorHeader), "注入用户指定的新标记");
    assert.ok(wiring.args!.includes('model_providers.ash_relay.env_key="ASH_RELAY_KEY"'));
    assert.ok(wiring.args!.includes('model_providers.ash_relay.wire_api="responses"'));
    const expectedBase = protocolConversionEnabled
      ? `${protocolConverterBaseUrl(relay.providerId)}/v1`
      : baseUrl.includes("/v2") ? "https://provider.invalid/v2" : "https://provider.invalid/v1";
    assert.ok(wiring.args!.includes(`model_providers.ash_relay.base_url="${expectedBase}"`));

    const executor = new CodexExecutor({ relay: configured });
    const config = executor as unknown as ExecutorConfig;
    assert.deepEqual(config.relayArgs(), wiring.args);
    assert.equal(config.env().ASH_RELAY_KEY, relay.apiKey);
    const appServer = config.appServerArgs({});
    assert.deepEqual(appServer.ignored, []);
    assert.deepEqual(appServer.args, ["app-server", "--stdio", ...wiring.args!]);
    for (const sessionId of ["", "fixture-session"]) {
      const execArgs = config.execArgs({ cwd: "/fixture" }, sessionId);
      assert.equal(execArgs.filter((arg) => arg === actorHeader).length, 1);
      assert.equal(execArgs[0], "exec");
      if (sessionId) assert.deepEqual(execArgs.slice(-3), ["resume", sessionId, "-"]);
      assert.ok(execArgs.indexOf(actorHeader) < execArgs.length - 1);
      assert.ok(!execArgs.join(" ").includes(relay.apiKey), "exec argv 不包含密钥");
    }
    for (const visible of [appServer.args.join(" "), wiring.envHint, executor.resumeCommand("/fixture", "fixture-session")]) {
      assert.ok(!visible.includes(relay.apiKey), "密钥不进入 argv 或恢复命令");
      assert.ok(!visible.includes("cockpit-tools"), "不沿用试验标记");
    }
    assert.equal(configured.apiKey, relay.apiKey, "不修改供应商密钥");
  }
}

const local = new CodexExecutor() as unknown as ExecutorConfig;
assert.deepEqual(local.relayArgs(), [], "未挂供应商时不覆盖本机登录配置");
assert.ok(!local.appServerArgs({}).args.includes(actorHeader));
assert.ok(!local.execArgs({ cwd: "/fixture" }, "").includes(actorHeader));

const overridden = new CodexExecutor({
  relay,
  extraArgs: ["-c", 'model_reasoning_effort="low"'],
}) as unknown as ExecutorConfig;
const extraArgs = ["-c", 'model_reasoning_effort="high"'];
for (const args of [overridden.execArgs({ cwd: "/fixture", extraArgs }, ""), overridden.appServerArgs({ extraArgs }).args]) {
  assert.ok(args.includes(actorHeader));
  assert.ok(args.indexOf('model_reasoning_effort="low"') < args.indexOf('model_reasoning_effort="high"'));
}

console.log("Codex provider injection tests passed (app-server, exec, resume, catalog, conversion, key isolation)");
