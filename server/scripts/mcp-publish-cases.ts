// 发布事务那一层的回归:**预演 → 备份 → 写盘前再校验 → 就地写 → 读回来比对**。
//
// 为什么跟 `test-ash-mcp-installer.ts` 分开:那边测「哪家写在哪、拼成什么样」,这边只测
// 「怎么安全地落盘」。两份实现(裸 Node `scripts/config-publish.mjs` 与服务端
// `server/src/auth/config-publish.ts`)规矩完全一致,所以用例也在一处写、两边都过。
// 由 `test-ash-mcp-installer.ts` 调用,不是独立的回归入口。
//
// **哪几条只能用结构断言**(写在用例里,不藏着):
//  · 探针的「独占创建」是 open 的 flag 决定的 —— 名字带随机段,拿不到那个名字就没法在测试
//    里先占住它,所以 `wx` + 随机段靠读源码钉;它真正要防住的后果(路径上已经有东西时绝不
//    写进去、绝不删掉它)有行为用例。
//  · 服务端那份没有 `write` 注入口,「慢步骤排在最终校验之前」只能读源码比先后;裸 Node 那
//    份有注入口,同一条不变量在那边是真跑出来的。
import assert from "node:assert/strict";
import {
  existsSync, lstatSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** 裸 Node 那份发布器的外形(动态 import,因为它是 `.mjs`)。 */
export interface BarePublish {
  readForWrite: (file: string) => { file: string; text: string | null } | null;
  publishConfirmed: (opts: {
    file: string; previous: string | null; body: string; backupSuffix?: string;
    write?: (file: string | number, body: string, enc?: unknown) => void;
  }) => { ok: true; backup: string | null } | { ok: false; why: string; stale?: boolean };
}

/** 上一版那个**固定**名字:用来在测试里先占住那个路径(审查 F1 的复现形状)。 */
const PROBE_MARK = ".ash-publish-probe";

/** 这一版的产物一律是 `<目标>.ash-publish-probe-<随机>`,所以按带横线的那个前缀扫残留。 */
const probeLeft = (file: string): boolean =>
  readdirSync(dirname(file)).some((n) => n.includes(`${PROBE_MARK}-`));

export async function checkPublishCases(
  publish: BarePublish,
  home: (name: string) => string,
  group: (name: string) => void,
): Promise<void> {
  // ── ② 写盘失败:活动配置必须还是原来那份(审查 R1 两轮)──────────────────────
  {
    // ⒜ **持续**写不动(配额耗尽、设备 EIO、挂载转只读):第 2 轮审查注入持续 EIO 实测,上一版
    //    先截断活动文件、再靠「第二次写」回写,持续故障下回写同样失败 —— 盘上留下半截正文
    //    (`{"userSetting":"ke`),备份完整而 CLI 读的是活动那份。现在**预演先行**:同目录写个
    //    临时文件试一次,落不下去就在动用户那份之前收手。
    const hp = home("persistent");
    const file0 = join(hp, "config.json");
    const intact = `${JSON.stringify({ userSetting: "keep-me" }, null, 2)}\n`;
    writeFileSync(file0, intact, "utf8");
    let calls = 0;
    const r0 = publish.publishConfirmed({
      file: file0,
      previous: publish.readForWrite(file0)!.text,
      body: `${JSON.stringify({ ash: "x", userSetting: "keep-me" }, null, 2)}\n`,
      write: (target: string | number, body: string) => {
        calls++;
        if (typeof body === "string" && body.length > 18) writeFileSync(target, body.slice(0, 18), "utf8");
        const e = new Error("i/o error") as Error & { code?: string };
        e.code = "EIO";
        throw e;
      },
    });
    assert.ok(!r0.ok, "写不动要如实说");
    assert.match(r0.ok ? "" : r0.why, /什么都没写/, "而且要说清一个字节都没写");
    assert.equal(readFileSync(file0, "utf8"), intact, "活动配置必须逐字节还是原来那份");
    assert.equal(calls, 1, "预演那一次就收手了,活动文件根本没被碰");
    assert.ok(!probeLeft(file0), "预演产物不许留下");
    assert.ok(!existsSync(`${file0}.bak-ash-setup`), "没动过就别留一份白备份");

    // ⒝ 预演过得去、**真写那一下**才失败(只读文件、文件被别人独占):这一档只能靠回写,
    //    所以仍要钉住「原文回去了 + 备份在」。
    const h = home("partial");
    const file = join(h, "config.json");
    const before = `${JSON.stringify({ userSetting: "keep-me", mcpServers: { other: { command: "x" } } }, null, 2)}\n`;
    writeFileSync(file, before, "utf8");
    const read = publish.readForWrite(file)!;
    let wrote = 0;
    const flaky = (target: string | number, body: string, opts?: unknown) => {
      // 预演照常放过(它写的是自己那个句柄,不是路径),真写那一下才抛。
      if (typeof target === "number") { writeFileSync(target, body, opts as never); return; }
      if (wrote++ === 0) {
        writeFileSync(target, body.slice(0, 21), "utf8");
        const e = new Error("no space left on device") as Error & { code?: string };
        e.code = "ENOSPC";
        throw e;
      }
      writeFileSync(target, body, "utf8");
    };
    const r = publish.publishConfirmed({ file, previous: read.text, body: "{}\n", write: flaky });
    assert.ok(!r.ok, "写失败要如实说");
    assert.match(r.ok ? "" : r.why, /原样放回去/, "而且要说清原文已经回去了");
    assert.equal(readFileSync(file, "utf8"), before, "活动配置必须还是原来那份(不许留半截)");
    assert.ok(existsSync(`${file}.bak-ash-setup`), "备份也还在");
    assert.ok(!probeLeft(file), "预演产物不许留下");

    // ⒞ 原来**没有**这个文件:写失败就不该留下一个半截的新文件。
    const h2 = home("partial-new");
    const file2 = join(h2, "sub", "config.json");
    let tries = 0;
    const r2 = publish.publishConfirmed({
      file: file2,
      previous: null,
      body: "{}\n",
      write: (target: string | number, body: string, opts?: unknown) => {
        if (typeof target === "number") { writeFileSync(target, body, opts as never); return; }
        if (tries++ === 0) { writeFileSync(target, body.slice(0, 1), "utf8"); throw new Error("boom"); }
        writeFileSync(target, body, "utf8");
      },
    });
    assert.ok(!r2.ok, "写失败要如实说");
    assert.ok(!existsSync(file2), "原来没有这个文件 ⇒ 失败后也不许留下来");
    assert.ok(!probeLeft(file2), "预演产物不许留下");

    // ⒟ 新建那一份只给自己读(kimi 原来的写入器就是 0600;改走通用发布器后别退成 umask)。
    const h3 = home("mode");
    const file3 = join(h3, "deep", "config.json");
    const r3 = publish.publishConfirmed({ file: file3, previous: null, body: "{}\n" });
    assert.ok(r3.ok, r3.ok ? "" : r3.why);
    assert.equal(statSync(file3).mode & 0o777, 0o600, "新建的配置只给自己读");
    group("写盘失败:持续故障在动手之前收手、真写失败回写原文、新建不留半截也不放宽权限");
  }

  // ── ③ 提交前的新鲜度 + 写完读回来比对 ────────────────────────────────────
  {
    const h = home("fresh");
    const file = join(h, "config.json");
    writeFileSync(file, "{\n}\n", "utf8");
    const read = publish.readForWrite(file)!;
    writeFileSync(file, '{\n  "userJustSaved": true\n}\n', "utf8");   // 别的程序抢先存了一版
    const r = publish.publishConfirmed({ file, previous: read.text, body: "{}\n" });
    assert.ok(!r.ok && /被别的程序改过/.test(r.why), `过期快照不许盖下去:${r.ok ? "" : r.why}`);
    assert.ok(!r.ok && r.stale, "而且要标成「盘上那份变了」,调用方据此报 foreignChange");
    assert.equal(readFileSync(file, "utf8"), '{\n  "userJustSaved": true\n}\n', "那次改动要留着");

    // 写完读回来跟要写的不一样(有人同时也在写)⇒ 如实报,别说「已注册」。
    const h2 = home("readback");
    const file2 = join(h2, "config.json");
    writeFileSync(file2, "{\n}\n", "utf8");
    const read2 = publish.readForWrite(file2)!;
    const r2 = publish.publishConfirmed({
      file: file2, previous: read2.text, body: '{"mine":1}\n',
      write: (target: string | number, body: string, opts?: unknown) => {
        if (typeof target === "number") { writeFileSync(target, body, opts as never); return; }
        writeFileSync(target, '{"someone-else":1}\n', "utf8");
      },
    });
    assert.ok(!r2.ok && /读回来跟要写的那份不一样/.test(r2.why), `读回来不一致要报:${r2.ok ? "" : r2.why}`);

    // 正常那一路:就地写,inode 不换(文件身份保住)。
    const h3 = home("inplace");
    const file3 = join(h3, "config.json");
    writeFileSync(file3, "{\n}\n", "utf8");
    const ino = Number(statSync(file3).ino);
    const read3 = publish.readForWrite(file3)!;
    const r3 = publish.publishConfirmed({ file: file3, previous: read3.text, body: '{"ok":1}\n' });
    assert.ok(r3.ok, r3.ok ? "" : r3.why);
    if (ino !== 0) assert.equal(Number(statSync(file3).ino), ino, "就地写:inode 不换");
    group("发布事务:过期快照不盖、落盘后读回来比对、就地写");
  }

  // ── ⑩ 预演产物只碰自己建出来的那一个(本轮审查 F1)────────────────────────
  {
    // 审查的复现形状:上一版预演用的是一个**固定名字**(`<目标>.ash-publish-probe`),而那个
    // 路径上可以先放一条软链接 —— 于是「预演」把用户配置全文整份写进了那条链接指的无关文件,
    // 收尾那句 `rmSync` 又把它删了。两边实现都如此。
    const h = home("probe-symlink");
    const file = join(h, "config.json");
    writeFileSync(file, "{\n}\n", "utf8");
    const victim = join(h, "unrelated.txt");
    const victimBody = "someone else's file\n";
    writeFileSync(victim, victimBody, "utf8");
    symlinkSync(victim, `${file}${PROBE_MARK}`);
    const read = publish.readForWrite(file)!;
    const r = publish.publishConfirmed({ file, previous: read.text, body: '{"ash":1}\n' });
    assert.ok(r.ok, `正事还得办成:${r.ok ? "" : r.why}`);
    assert.equal(readFileSync(victim, "utf8"), victimBody, "无关文件的正文一个字节都不许动");
    assert.ok(existsSync(victim), "更不许把它删掉");
    assert.ok(lstatSync(`${file}${PROBE_MARK}`).isSymbolicLink(), "那条软链接本身也该还在");
    assert.equal(readFileSync(file, "utf8"), '{"ash":1}\n', "目标文件正常写进去");

    // 同一个路径上放**普通文件**(并发的另一个发布器、上一次崩溃留下的残渣)也一样:
    // 既不许写它,也不许删它。
    const h2 = home("probe-file");
    const file2 = join(h2, "config.json");
    writeFileSync(file2, "{\n}\n", "utf8");
    const squatter = `${file2}${PROBE_MARK}`;
    writeFileSync(squatter, "not mine\n", "utf8");
    const read2 = publish.readForWrite(file2)!;
    const r2 = publish.publishConfirmed({ file: file2, previous: read2.text, body: '{"ash":2}\n' });
    assert.ok(r2.ok, `正事还得办成:${r2.ok ? "" : r2.why}`);
    assert.equal(readFileSync(squatter, "utf8"), "not mine\n", "别人占着的那个路径不许被写");

    // 正常跑完一轮,目录里不许留下任何预演产物(名字带随机段,所以按前缀扫)。
    assert.ok(!probeLeft(file2), "预演产物不许留下");
    group("预演产物:路径被占着也绝不写它、不删它,自己那份用完就清");
  }

  // ── ⑪ 最终校验紧贴写盘:慢步骤期间别人存的那一版不许被盖掉(本轮审查 F3)──────
  {
    // 复现:注入的 `write` 在**预演**那一刻(慢步骤,真实世界里是写全文 + fsync)替用户存了
    // 一版新配置。上一版的新鲜度校验在预演之前,于是照旧拿旧快照盖下去、读回来还匹配、报成功。
    const h = home("fresh-late");
    const file = join(h, "config.json");
    const mine = '{\n  "userSetting": "old"\n}\n';
    writeFileSync(file, mine, "utf8");
    const read = publish.readForWrite(file)!;
    const theirs = '{\n  "userJustSaved": true\n}\n';
    const r = publish.publishConfirmed({
      file, previous: read.text, body: '{"ash":1}\n',
      write: (target: string | number, body: string, opts?: unknown) => {
        if (typeof target === "number") {
          writeFileSync(target, body, opts as never);
          writeFileSync(file, theirs, "utf8");   // 预演这会儿,用户在另一处按了保存
          return;
        }
        writeFileSync(target, body, "utf8");
      },
    });
    assert.ok(!r.ok, "慢步骤期间盘上那份变了 ⇒ 这一轮不许写");
    assert.ok(!r.ok && r.stale, "而且要标成「盘上那份变了」");
    assert.equal(readFileSync(file, "utf8"), theirs, "用户刚存的那一版必须留着");
    assert.ok(!existsSync(`${file}.bak-ash-setup`), "没写成就别留一份白备份");
    assert.ok(!probeLeft(file), "预演产物不许留下");

    // 备份本身也要核对:它是「活动那份坏了」唯一的出路,一份半截的备份比没有更坏。
    const h2 = home("backup-verified");
    const file2 = join(h2, "config.json");
    const body2 = '{\n  "userSetting": "keep"\n}\n';
    writeFileSync(file2, body2, "utf8");
    const read2 = publish.readForWrite(file2)!;
    const r2 = publish.publishConfirmed({ file: file2, previous: read2.text, body: '{"ash":1}\n' });
    assert.ok(r2.ok, r2.ok ? "" : r2.why);
    assert.equal(r2.ok ? r2.backup : "", `${file2}.bak-ash-setup`, "备份路径要交回给调用方");
    assert.equal(readFileSync(`${file2}.bak-ash-setup`, "utf8"), body2, "备份必须是改之前那一版");

    // 上一次发布留下的备份不许被这一轮的收手动作删掉(那是用户手里唯一的旧版本)。
    const read3 = publish.readForWrite(file2)!;
    writeFileSync(file2, '{\n  "userJustSaved": 2\n}\n', "utf8");
    const r3 = publish.publishConfirmed({ file: file2, previous: read3.text, body: '{"ash":2}\n' });
    assert.ok(!r3.ok && r3.stale, "过期快照不许盖下去");
    assert.equal(readFileSync(`${file2}.bak-ash-setup`, "utf8"), body2, "上一轮那份备份还在");
    group("最终校验紧贴写盘:慢步骤期间的外部保存不被盖掉,备份核对过且不被误删");
  }

  // ── ⑫ 两份实现的结构不变量(行为测不出来的那几条)──────────────────────────
  {
    const src = {
      bare: readFileSync(new URL("../../scripts/config-publish.mjs", import.meta.url), "utf8"),
      server: readFileSync(new URL("../src/auth/config-publish.ts", import.meta.url), "utf8"),
    };
    for (const [side, code] of Object.entries(src)) {
      // 独占创建:名字带随机段 + `wx`。拿不到那个随机名字,测试没法先占住它来证明 —— 但
      // 这两条一起才是「绝不写到别人的对象上」的来源(本轮审查 F1)。
      assert.match(code, /PROBE_PREFIX\s*=\s*"\.ash-publish-probe-"/, `${side}:预演产物的名字要带后缀分隔`);
      assert.match(code, /randomBytes\(\d+\)\.toString\("hex"\)/, `${side}:预演产物的名字必须带随机段`);
      assert.match(code, /openSync\(probe, "wx", TMP_MODE\)/, `${side}:预演产物必须独占创建、0600 出生`);
      assert.ok(!/\.ash-publish-probe`/.test(code), `${side}:不许再有固定名字的预演路径`);
      // 写和 fsync 都走自己那个句柄,不按路径二次打开。
      assert.ok(!/openSync\(probe, "r\+"\)/.test(code), `${side}:不许按路径把预演产物再打开一次`);
    }
    // 服务端那份没有 `write` 注入口,「慢步骤排在最终校验之前」(F3)只能读源码比先后。
    // 裸 Node 那侧同一条不变量在第 ⑪ 组是真跑出来的。
    const commit = src.server.slice(src.server.indexOf("const commit: Commit = "));
    const at = (needle: string) => {
      const i = commit.indexOf(needle);
      assert.ok(i > 0, `服务端 commit 里找不到 ${needle}`);
      return i;
    };
    const lastCheck = at("const now = readForWrite(read.file)");
    assert.ok(at("rehearse(") < lastCheck, "预演必须排在最终校验之前(F3)");
    assert.ok(at("backupBefore(read)") < lastCheck, "备份必须排在最终校验之前(F3)");
    assert.ok(at("publishInPlace(read, body)") > lastCheck, "写盘必须排在最终校验之后(F3)");
    group("结构不变量:预演独占创建、慢步骤排在最终校验之前");
  }
}
