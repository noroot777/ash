import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings, ComposerSendKey } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import "../../src/styles/global.css";
import { ComposerObjective } from "../../src/composer/ComposerObjective.tsx";
import { ComposerSendKeyCard } from "../../src/settings/ComposerSendKeyCard.tsx";
import { api } from "../../src/lib/api.ts";
import { composerSendKey } from "../../src/lib/sendKey.ts";
import { useSendKeyLabels } from "../../src/lib/useComposerSendKey.ts";

// 「输入框按哪一下算发送」的台子。走的是真实那条链路：
//   GET/PATCH /api/settings → settingsSync 的新旧判定 → sendKey.ts → 输入框与提示文案。
// 所以 fetch 是打桩的、组件是真的。设置页上「每张卡各自 PATCH 完 setSettings 一把」
// 那个形状也照搬过来（__patchSkill），问题 3 要的就是它。
//
// 查询参数：
//   `?send-key=`  服务端那份的初值
//   `?fail=N`     接下来 N 条 GET 直接 503
//
// 测试把手（window 上）：
//   __probe()                  再发一条普通 GET（立刻回）
//   __probeHeld()              再发一条 GET，应答被扣住，交回的是**发出那一刻**的值
//   __releaseProbe()           放行被扣住的那条 GET
//   __holdPatch(applyOnRelease, failOnRelease)
//                              扣住下一条 PATCH。applyOnRelease=true 表示「服务端还没
//                              写，放行才写」；false 表示「服务端已经写了，只是应答在
//                              路上」——两种交错对应两类缺陷，别混用。failOnRelease=true
//                              则放行时回 503（服务端一个字都没写）
//   __releasePatch()           放行被扣住的那条 PATCH
//   __patchSkill(n)            改另一项设置（技能刷新间隔），走设置页同一个形状
//   __failPatch(n)             接下来 n 条**没被扣住的** PATCH 直接 503
//   __reopenSettings()         把发送键卡片卸载再挂上、并重新读一次设置 —— 等价于
//                              「离开设置页再回来」：卡片级的「保存中」就这么丢掉的
//   __allowReads()             取消剩余的 GET 失败
//   __state()                  { mode, value, skill, epoch, applied }
//                              mode  = 此刻真正生效的那一档（含排着队还没落地的选择）
//                              value = settingsSync **交出去的快照**里的那一档，按设计
//                                      只该有服务端确认过的值
//                              applied = 真正落到「服务端」的 PATCH 条数

const params = new URLSearchParams(location.search);
const stored: AppSettings = {
  ...DEFAULT_APP_SETTINGS,
  composerSendKey: (params.get("send-key") as ComposerSendKey | null) ?? DEFAULT_APP_SETTINGS.composerSendKey,
};
let failsLeft = Number(params.get("fail") ?? 0);
let patchFailsLeft = 0;
// 真正写进 stored 的 PATCH 条数。被扣住的那条在放行之后才计 —— 「还没到服务端」就是
// 还没计这一笔。同字段有没有抢跑，看这个数比看值准：两次写的值可能恰好相同。
let applied = 0;

const reply = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

let patchGate: (() => void) | null = null;
let holdPatch: { applyOnRelease: boolean; failOnRelease: boolean } | null = null;
// 显式扣住的那条 GET（__probeHeld）。跟「第几条 GET」无关，免得顺序一变用例就飘。
let probeGate: (() => void) | null = null;
let probing = false;

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(href, location.origin).pathname;
  if (path === "/api/settings") {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Partial<AppSettings>;
      const held = holdPatch;
      holdPatch = null;
      if (!held) {
        if (patchFailsLeft > 0) { patchFailsLeft -= 1; return new Response("boom", { status: 503 }); }
        Object.assign(stored, patch); applied += 1; return reply(stored);
      }
      if (!held.applyOnRelease) { Object.assign(stored, patch); applied += 1; }
      // 应答那一刻的快照：放行之后 stored 再变也不影响这一份（真实应答就是这样）。
      const snapshot = held.applyOnRelease ? null : { ...stored };
      await new Promise<void>((resolve) => { patchGate = resolve; });
      if (held.failOnRelease) return new Response("boom", { status: 503 });
      if (held.applyOnRelease) { Object.assign(stored, patch); applied += 1; }
      return reply(snapshot ?? stored);
    }
    if (probing) {
      const snapshot = { ...stored };
      await new Promise<void>((resolve) => { probeGate = resolve; });
      return reply(snapshot);
    }
    if (failsLeft > 0) { failsLeft -= 1; return new Response("boom", { status: 503 }); }
    return reply(stored);
  }
  if (path.startsWith("/api/")) return reply({});
  return realFetch(input, init);
};

function Fixture() {
  const [settings, setSettings] = useState<AppSettings>(stored);
  const [loading, setLoading] = useState(true);
  // 卡片的「第几次挂载」。换 key = 卸载旧实例、挂上新的，组件级的 saving 跟着归零
  // —— 这正是「离开设置页再回来」丢掉的那个状态。
  const [cardEpoch, setCardEpoch] = useState(0);
  const [body, setBody] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const labels = useSendKeyLabels();

  // 设置页就是这么读写的（DefaultsSettings.tsx）：GET 一份、每张卡各自 PATCH 回一份。
  useEffect(() => {
    api.settings().then(setSettings).catch(() => undefined).finally(() => setLoading(false));
  }, []);
  const changeSendKey = useCallback(async (next: ComposerSendKey) => {
    setSettings(await api.patchSettings({ composerSendKey: next }));
  }, []);

  useEffect(() => {
    // 这几个把手**一律不返回 Promise**：`page.evaluate` 会等返回的 Promise 落定，
    // 而「发一条会被扣住的请求」这件事的全部意义就是它不落定 —— 返回它等于把用例挂死。
    // 要等就等能观察到的状态（__state / DOM），别等这里的返回值。
    Object.assign(window, {
      __probe: () => { void api.settings().then(setSettings).catch(() => undefined); },
      // fetch 打桩的入口同步跑到第一个 await，所以这个标记在那一刻读得到。
      __probeHeld: () => {
        probing = true;
        void api.settings().then(setSettings).catch(() => undefined);
        probing = false;
      },
      __releaseProbe: () => { probeGate?.(); probeGate = null; },
      __holdPatch: (applyOnRelease = false, failOnRelease = false) => {
        holdPatch = { applyOnRelease, failOnRelease };
      },
      __releasePatch: () => { patchGate?.(); patchGate = null; },
      __patchSkill: (seconds: number) => {
        void api.patchSettings({ skillRefreshSeconds: seconds }).then(setSettings).catch(() => undefined);
      },
      __failPatch: (times = 1) => { patchFailsLeft = times; },
      __reopenSettings: () => {
        setCardEpoch((epoch) => epoch + 1);
        void api.settings().then(setSettings).catch(() => undefined);
      },
      __allowReads: () => { failsLeft = 0; },
      __state: () => ({
        mode: composerSendKey(),
        value: settings.composerSendKey,
        skill: settings.skillRefreshSeconds,
        epoch: cardEpoch,
        applied,
      }),
    });
  }, [settings, cardEpoch]);

  return <main className="settings-main" style={{ width: "min(100%, 960px)", margin: "auto", padding: 20 }}>
    <p data-testid="log">{log.join(",")}</p>
    <p data-testid="hint">{labels.send} 发送 · {labels.newline} 换行</p>
    <ComposerSendKeyCard key={cardEpoch} loading={loading} onChange={changeSendKey} />
    <div style={{ marginTop: 16 }}>
      <ComposerObjective
        body={body} mode="single" textareaRef={textareaRef}
        onChange={setBody} onPaste={() => {}}
        items={[]} selected={0} token={null}
        onSelect={() => {}} onPick={() => {}} onDismiss={() => {}}
        onSubmit={() => setLog((prev) => [...prev, `submit(${JSON.stringify(body)})`])}
      />
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
