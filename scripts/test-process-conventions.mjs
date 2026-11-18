import ts from "typescript";

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

// 就是要起真 CLI 的脚本：只有它们可以把测试隔离闸整个打开（ASH_ALLOW_REAL_AGENT）。
// 其余要验证进程管理的测试用 ASH_TEST_AGENT_BIN 列出自己铺的假 CLI。整体放行分不出
// 「测试铺的」和「机器上真装着的」：起跑是异步的，收尾把 PATH 还原后才轮到的那一次会起真的
// （server/src/executors/spawn.ts 的 guardAgentSpawn）。
export const REAL_AGENT_SCRIPTS = [
  "server/scripts/e2e-opencode-ash-mcp.ts",
  "server/scripts/test-agent-spawn-guard.ts", // 钉的是这道闸本身
  "server/scripts/test-chat-cli.ts",
  "server/scripts/test-claude-goal-live.ts",
  "server/scripts/test-goal-native-live.ts",
  "server/scripts/test-kimi-live.ts",
  "server/scripts/test-side-authorization-cli.ts",
];

const REAL_AGENT_SWITCH = "ASH_ALLOW_REAL_AGENT";

/** 写 ASH_ALLOW_REAL_AGENT 的地方：赋值，或拼给子进程的环境对象里的同名键。读、比较、delete 不算。 */
export function realAgentSwitchViolations(source, filename) {
  if (!source.includes(REAL_AGENT_SWITCH)) return [];
  const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    /\.tsx?$/.test(filename) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const named = (node) => node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === REAL_AGENT_SWITCH;
  const violations = [];
  function visit(node) {
    const written = ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (ts.isPropertyAccessExpression(node.left) ? named(node.left.name)
        : ts.isElementAccessExpression(node.left) && named(node.left.argumentExpression));
    const passed = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && named(node.name);
    if (written || passed) {
      const location = syntax.getLineAndCharacterOfPosition(node.getStart(syntax));
      violations.push(`${filename}:${location.line + 1}:${location.character + 1}  ${node.getText(syntax).slice(0, 72)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return violations;
}
