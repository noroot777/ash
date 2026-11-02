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
