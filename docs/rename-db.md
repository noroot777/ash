# 库文件改名：ash.db → navi.db

2026-11-19 起库文件叫 `navi.db`。新安装起服务直接建 `navi.db`；改名之前的安装照常用 `ash.db`，什么都不用做也能一直跑下去。
想改成新名的，在**服务停着**的时候跑一次 `npm run rename-db`。

| 文件 | 管什么 |
| --- | --- |
| `server/src/db/path.ts` | 服务开哪一份库（`chooseDbFileIn`），以及为什么不在运行时改名 |
| `server/src/startup-lock.ts` | 启动先拿单例锁、再加载会开库的模块；锁里由 `recheckDbFileChoice` 重认一遍选中的库 |
| `scripts/db-file.mjs` | 脚本侧同一套认法：停服务找锁、组预览拷库、迁目录清点都用它；跟着库名走的文件清单 |
| `scripts/rename-db.mjs` / `rename-db-core.mjs` | 改名命令：演练 / 改名 / 退回，账本与失败退回 |
| `desktop/macos/Sources/NaviConfig.swift` 的 `DatabaseFile` | mac 应用的同一套认法（导入、更新前备份、首启判断） |
| `server/scripts/test-db-file.ts` | 回归（`npm -w server run test:db-file`，在 `test:accept` 里） |

## 服务开哪一份

数据目录（缺省 `<仓库>/data`，`NAVI_DATA_DIR` 可改）里：

| 情形 | 服务 |
| --- | --- |
| 只有 `navi.db`，或 `navi.db` + 改名留下的路标 `ash.db` | 开 `navi.db` |
| 只有 `ash.db`（还没改名的老安装） | 开 `ash.db`，启动日志里提一句可以改名 |
| 都没有 | 建 `navi.db`（更早一代的 `harness.db` 在的话就地改名成 `navi.db`） |
| `navi.db` 和 `ash.db` **都是库** | **不起**，说明两份都在、让人挑一份挪走 |
| 只有路标、`navi.db` 不见了 | **不起**（不对着空库起来） |
| 改名账本 `navi.db.renaming` 在（上次改名做到一半） | **不起**，说清用 `--apply` 做完或 `--rollback` 撤销 |

显式设了 `NAVI_DB`（旧名 `ASH_DB` 也认）就只认它的位置，上面这张表不看；但它所在的目录里改名账本还在、或者它指着的
是路标时照样不起。

跟着库名走的文件（`${库}${后缀}`）都随库一起改名：`-wal`、`-shm`、`-journal`、退出账本 `.exits.jsonl`、卡死判定账本
`.stall-verdicts.jsonl`（各带轮转出的 `.1`）、接力身份 `.identity.json`、远程访问密钥 `.remote-access.json`、飞书配置
`.feishu.json`。单例锁、在线登记、资源占用锁只对当时在跑的进程有意义，改名时挪进 `backups/db-rename-<时间>/` 留底，不带过去。
名字只是以 `ash.db` 开头的别的文件（比如自己留的 `ash.db.bak-…`）不动。

## 操作单（仓库里起服务的安装）

1. **停服务**：`npm run stop`（它说会打断任务就先等任务跑完）。
2. **演练**：`npm run rename-db`。看它列出的每一步；有人还开着这份数据（新旧两代的锁、在线登记、别的维护）会直接拦下。
3. **改名**：`npm run rename-db -- --apply`。
4. **起服务**：`npm run restart`。

数据目录不在 `<仓库>/data` 的，加 `-- --data <目录>`（或设好 `NAVI_DATA_DIR` 再跑）。启动脚本、计划任务里显式设了
`NAVI_DB=…/ash.db` 的，改完把它改成 `navi.db`，命令最后也会提醒。

**中途失败**：命令照账本把已经做的倒着撤回去，数据目录回到动手之前的样子，退出码 3，原因打在最后。
**进程被杀**（强杀、崩溃）：账本留在数据目录里，服务因此起不来。再跑一次 `--apply` 接着做完，或 `--rollback` 撤销这一次。
账本记着做到了第几步（每做完一步先记下再往下走），盘面只用来判记到的那一步；撤路标之前核对它是这一次的那份路标，
不凭「有个文件在」就删。停在撤回途中的，只能 `--rollback` 撤完，`--apply` 会拒绝。回归里每一步之前、之后真杀一次进程，
接着处理都落在「做完」或「原样」上（`test:db-file` 的被杀矩阵）。
**断电**没有实测过：macOS / Linux 上账本和目录项每一步都刷了盘（fsync），按理同上；Windows 刷不了目录，断电之后先跑一次
演练看它报的是什么状态，再决定 `--apply` 还是 `--rollback`。

**启动和改名撞在一起**：服务选库在拿单例锁之前，拿锁时（改名抢的是同一把锁）会再认一遍，认出来库已经改了名就不起、
让人重启一次，不会对着一份新建的空库起来。显式设了 `NAVI_DB` 的也一样：那个目录里改名做到一半、或者它指着路标时不起。

**两份都是库**：命令和服务都不替你选。看演练打出来的两份各多大、最后改于何时，把不要的那份（连同它名字开头的 `-wal`、`-shm`、
`.identity.json` 等）挪出数据目录。

## 回退到改名之前的版本

改名之前的服务只认 `ash.db`。改名时在原地留的 `ash.db` 是一份路标，不是库：旧版对着它会报 `file is not a database`
起不来，**不会**对着一份空库起来、让人以为数据没了。要换回旧版：

1. 用新版停服务：`npm run stop`；
2. `npm run rename-db -- --rollback`：库和跟着它的文件换回旧名、撤掉路标；
3. 再切回旧版代码、照旧版的方式起。

新版照样认 `ash.db`，所以退回之后再升上来不用做任何事；想再改名就再跑一次 `--apply`。

mac 应用的数据根（缺省 `~/Library/Application Support/dev.navi.mac`，从 Ash.app 升上来的是 `dev.ash.mac`）同理：
退出 app、停掉服务后，在一份新版检出里 `node scripts/rename-db.mjs --data <数据根> --apply`（或 `--rollback`）。
不改也行，新版 app 两个名字都认；新装的 app 直接是 `navi.db`。要回到认不得 `navi.db` 的旧版 app，先 `--rollback`。

## Windows 那台（`D:\ai_workspace\ash`）

升级本身照 `docs/rename-navi-windows.md` 第五节做：升完之后服务照常开 `ash.db`，不改名也能用。要改名的话多做这几步，
在 PowerShell 里、仓库目录下：

1. `node scripts\stop.mjs`，确认 `:4317` 已经没人监听。**Windows 上开着的文件改不了名**：服务、DB 浏览器、
   杀毒软件只要有谁开着 `data\ash.db`，改名那一步会失败，命令照账本退回原样、退出码 3 —— 关掉占着的程序再跑；
2. `Copy-Item data\ash.db data\ash.db.pre-rename.bak`（再留一份底）；
3. `node scripts\rename-db.mjs` 演练，再 `node scripts\rename-db.mjs --apply`（`npm.cmd run rename-db -- --apply` 也行）；
4. 照原样起服务，核对：`data\` 下是 `navi.db`、`navi.db.identity.json`、`navi.db.remote-access.json`，原来的 `ash.db`
   变成了几行字的路标；从 Mac 往那台接力、手机远程访问都照旧（身份和访问密钥是同一份）。

那台的接力身份和远程访问密钥都挂在库名上，**别手工只改 `ash.db` 一个文件**：那样服务会当成一台新机器，对端要重新批准、
手机要重新配对。
