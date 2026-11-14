// 独立 mac app 导入旧数据时用自带 node 跑这一个（desktop/macos/Sources/DataImport.swift）：
//   node import-snapshot-cli.js <暂存的库> <目标数据根> <源数据根>...
// 成功时 stdout 是一行 JSON（ImportPreparation），失败退出码非 0、原因在 stderr。
import { prepareImportedSnapshot } from "./import-snapshot.js";

const [file, target, ...sources] = process.argv.slice(2);
if (!file || !target || !sources.length) {
  console.error("用法: import-snapshot-cli.js <库文件> <目标数据根> <源数据根>...");
  process.exit(2);
}
try {
  process.stdout.write(`${JSON.stringify(prepareImportedSnapshot(file, sources, target))}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
