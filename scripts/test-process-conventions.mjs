import ts from "typescript";
import { envNameGenerations } from "./env.mjs";

export function testCleanupViolations(source, filename) {
  const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const violations = new Set();
  function inspectCleanup(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const access = node.expression;
      const method = ts.isPropertyAccessExpression(access) ? access.name.text
        : ts.isElementAccessExpression(access) && ts.isStringLiteral(access.argumentExpression) ? access.argumentExpression.text : undefined;
      if (["stop", "remove", "dispose"].includes(method)) {
        const location = syntax.getLineAndCharacterOfPosition(node.getStart(syntax));
        violations.add(`${filename}:${location.line + 1}:${location.character + 1}  ${access.getText(syntax)}()`);
      }
    }
    ts.forEachChild(node, inspectCleanup);
  }
  function visit(node) {
    if (ts.isTryStatement(node) && node.finallyBlock) inspectCleanup(node.finallyBlock);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return [...violations];
}

// 就是要起真 CLI 的脚本：只有它们可以把测试隔离闸整个打开（NAVI_ALLOW_REAL_AGENT）。
// 其余要验证进程管理的测试用 NAVI_TEST_AGENT_BIN 列出自己铺的假 CLI。整体放行分不出
// 「测试铺的」和「机器上真装着的」：起跑是异步的，收尾把 PATH 还原后才轮到的那一次会起真的
// （server/src/executors/spawn.ts 的 guardAgentSpawn）。
export const REAL_AGENT_SCRIPTS = [
  "server/scripts/e2e-opencode-navi-mcp.ts",
  "server/scripts/test-agent-spawn-guard.ts", // 钉的是这道闸本身
  "server/scripts/test-chat-cli.ts",
  "server/scripts/test-claude-goal-live.ts",
  "server/scripts/test-goal-native-live.ts",
  "server/scripts/test-kimi-live.ts",
  "server/scripts/test-side-authorization-cli.ts",
];

// 闸那一侧各代名字都认（server/src/executors/spawn.ts 走 readEnv），所以这里各代都要拦：
// 只拦新名，写一句改名之前的 `NAVI_ALLOW_REAL_AGENT` 就绕过去了。
const REAL_AGENT_SWITCHES = envNameGenerations("NAVI_ALLOW_REAL_AGENT");

/**
 * 写 NAVI_ALLOW_REAL_AGENT（任一代名字）的地方：赋值、拼给子进程的环境对象里的同名键（含 `["…"]` 这种写死的
 * 计算键）、`Reflect.set` / `Object.defineProperty` 点名写它。读、比较、delete 不算。
 * 认的是**字面上点了名**的写法；键名运行时才拼出来的认不出，这不是「没人写它」的证明。
 */
export function realAgentSwitchViolations(source, filename) {
  if (!REAL_AGENT_SWITCHES.some((name) => source.includes(name))) return [];
  const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    /\.tsx?$/.test(filename) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const named = (node) => {
    const key = node && ts.isComputedPropertyName(node) ? node.expression : node;
    return !!key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && REAL_AGENT_SWITCHES.includes(key.text);
  };
  const SETTERS = ["Reflect.set", "Object.defineProperty"];
  const violations = [];
  function visit(node) {
    const written = ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (ts.isPropertyAccessExpression(node.left) ? named(node.left.name)
        : ts.isElementAccessExpression(node.left) && named(node.left.argumentExpression));
    const passed = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && named(node.name);
    const called = ts.isCallExpression(node) && SETTERS.includes(node.expression.getText(syntax))
      && named(node.arguments[1]);
    if (written || passed || called) {
      const location = syntax.getLineAndCharacterOfPosition(node.getStart(syntax));
      violations.push(`${filename}:${location.line + 1}:${location.character + 1}  ${node.getText(syntax).slice(0, 72)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return violations;
}
