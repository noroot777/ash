import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RebaseStep } from "@ash/shared/git-workbench";
import { commitOid, fail, git } from "./core.js";
import { journalDirectory } from "./journal.js";
import { cleanupRebaseHelpers } from "./maintenance.js";

const shellWord = (word: string) =>
  `'${word.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
export async function rebasePlan(
  root: string,
  target: string,
  steps: RebaseStep[],
): Promise<void> {
  const base = await commitOid(root, target);
  await git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
  const lines = (
    await git(root, ["rev-list", "--reverse", "--parents", `${base}..HEAD`])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!lines.length || lines.length > 100)
    fail("交互式变基支持 1–100 个提交，请选择更近的基点");
  if (lines.some((line) => line.split(" ").length > 2))
    fail("这段历史含合并提交，请先选择一段线性历史，或使用普通变基");
  const commits = lines.map((line) => line.split(" ")[0]);
  if (
    !Array.isArray(steps) ||
    steps.length !== commits.length ||
    new Set(steps.map((s) => s.sha)).size !== commits.length ||
    steps.some(
      (s) =>
        !commits.includes(s.sha) ||
        !["pick", "reword", "squash", "fixup", "drop"].includes(s.action),
    )
  ) {
    fail("变基计划与当前历史不一致，请重新打开计划", 400);
  }
  const kept = steps.filter((s) => s.action !== "drop");
  if (kept[0] && ["squash", "fixup"].includes(kept[0].action))
    fail("第一条保留的提交不能 squash 或 fixup", 400);
  if (
    steps.some(
      (s) =>
        s.action === "reword" &&
        (typeof s.message !== "string" ||
          !s.message.trim() ||
          s.message.length > 10000),
    )
  )
    fail("请填写重写后的提交信息", 400);

  const directory = join(
    await journalDirectory(root),
    `rebase-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  try {
    const node = shellWord(process.execPath);
    const amend = join(directory, "amend.cjs");
    await writeFile(
      amend,
      "const {spawnSync}=require('node:child_process');const r=spawnSync('git',['commit','--amend','--file',process.argv[2]],{stdio:'inherit',windowsHide:true});process.exit(r.status??1);\n",
    );
    const todo: string[] = [];
    for (const [i, step] of steps.entries()) {
      todo.push(
        `${step.action === "reword" ? "pick" : step.action} ${step.sha}`,
      );
      if (step.action === "reword") {
        const message = join(directory, `message-${i}.txt`);
        await writeFile(message, step.message + "\n");
        todo.push(`exec ${node} ${shellWord(amend)} ${shellWord(message)}`);
      }
    }
    const editor = join(directory, "sequence.cjs");
    await writeFile(
      editor,
      `require('node:fs').writeFileSync(process.argv[2],${JSON.stringify(todo.join("\n") + "\n")});\n`,
    );
    await git(root, ["rebase", "-i", base], {
      GIT_SEQUENCE_EDITOR: `${node} ${shellWord(editor)}`,
    });
  } finally {
    await cleanupRebaseHelpers(root);
  }
}
