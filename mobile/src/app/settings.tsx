import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { useRouter } from "expo-router";
import type { PairTicket } from "@ash/shared/multiuser";
import { getApiKey, getBaseURL, setApiKey, setBaseURL } from "@/lib/config";
import { api } from "@/lib/api";
import { refreshAll } from "@/lib/data";
import { useTheme } from "@/lib/theme";
import { Button, Input } from "@/components/ui";

type Status = { kind: "idle" | "testing" | "ok" | "fail"; msg?: string };

/** 配对时报给电脑那边的名字:机主靠它认出「就是我手上这台」。网页导出版不报,让服务端按浏览器认。 */
const DEVICE_NAME =
  Platform.OS === "ios" ? "iPhone · ash app" : Platform.OS === "android" ? "Android · ash app" : undefined;

export default function Settings() {
  const router = useRouter();
  const theme = useTheme();
  const [url, setUrl] = useState(getBaseURL() ?? "");
  const [key, setKey] = useState(getApiKey() ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // 这台后端怎么认人?多人模式要个人 key;自用模式从手机连过去要先配对(只有和 ash 同机
  // 的模拟器才不用):点保存就递一张申请,在电脑上点「允许」即可,什么都不用填。那把给
  // 脚本用的访问密钥也能填,但要自己点开。地址一变就重探一次。
  const [multi, setMulti] = useState<boolean | null>(null);
  const [needsKey, setNeedsKey] = useState<boolean | null>(null);
  const [manualKey, setManualKey] = useState(false);
  const [pairing, setPairing] = useState<{ url: string; ticket: PairTicket } | null>(null);

  const finish = useCallback(async (v: string, credential: string, who?: string) => {
    await setBaseURL(v);
    await setApiKey(credential);
    await refreshAll();
    setStatus({ kind: "ok", msg: who ? `已连接 · ${who}` : "已连接" });
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  // 等电脑那边点头。
  useEffect(() => {
    if (!pairing) return;
    let alive = true;
    const check = async () => {
      try {
        const claim = await api.pairClaim(pairing.url, pairing.ticket);
        if (!alive || claim.status === "pending") return;
        setPairing(null);
        if (claim.status === "approved") await finish(pairing.url, claim.token);
        else setStatus({ kind: "fail", msg: claim.status === "denied" ? "这次申请被拒绝了" : "申请过期了，再点一次" });
      } catch {
        // 断网或后端重启中:下一轮再问。
      }
    };
    const timer = setInterval(() => void check(), 2_000);
    return () => { alive = false; clearInterval(timer); };
  }, [pairing, finish]);

  useEffect(() => {
    const v = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(v)) {
      setMulti(null);
      setNeedsKey(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.authState(v, "")
        .then((state) => {
          if (!alive) return;
          setMulti(state.mode === "multi");
          setNeedsKey(state.mode === "multi" || state.needsAccessKey === true);
        })
        .catch(() => { if (alive) { setMulti(null); setNeedsKey(null); } });
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [url]);

  const save = async () => {
    const v = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(v)) {
      setStatus({ kind: "fail", msg: "地址需以 http:// 或 https:// 开头" });
      return;
    }
    setStatus({ kind: "testing" });
    try {
      await api.health(v); // probe before persisting
      // key 也要当场验。不验的话,填错一个字的后果是保存成功、回到列表页满屏 401,而用户
      // 完全看不出问题出在这一栏。
      const state = await api.authState(v, key.trim());
      if (state.mode === "multi" && !state.user) {
        setStatus({
          kind: "fail",
          msg: key.trim() ? "这把 key 不对（可能已被重置或停用），找管理员重发" : "这台 ash 是多人模式，需要填你的 key",
        });
        return;
      }
      if (state.needsAccessKey) {
        if (manualKey && key.trim()) {
          setStatus({ kind: "fail", msg: "访问密钥不对（可能已被重新生成）" });
          return;
        }
        // 这台手机还没被放进来(或者之前的凭证被移除了):递一张申请,等电脑那边点头。
        setPairing({ url: v, ticket: await api.pairOpen(v, DEVICE_NAME) });
        setStatus({ kind: "idle" });
        return;
      }
      // 自用模式下只在「不带 key 就进不去」时才存它:同机模拟器那种本来就不用的,不留一把
      // 多余的凭证在手机上。
      const keyed = state.mode === "multi" || (await api.authState(v, "")).needsAccessKey === true;
      await finish(v, keyed ? key.trim() : "", state.user?.name);
    } catch (e) {
      setStatus({ kind: "fail", msg: `连接失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const statusColor =
    status.kind === "ok" ? theme.ok : status.kind === "fail" ? theme.danger : theme.muted;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Text style={{ color: theme.muted, fontSize: 13, lineHeight: 19 }}>
          填写 ash 后端地址（经 Tailscale 访问 Mac）。例如 http://100.x.x.x:4317 或
          http://你的主机名:4317。
        </Text>

        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.faint, fontSize: 12 }}>后端地址</Text>
          <Input
            value={url}
            onChangeText={setUrl}
            placeholder="http://mac-ts:4317"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>

        {needsKey !== false && (multi !== false || manualKey) && (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.faint, fontSize: 12 }}>
              {multi === false ? "访问密钥" : "你的 key"}
            </Text>
            <Input
              value={key}
              onChangeText={setKey}
              placeholder="ash_…"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={{ color: theme.faint, fontSize: 11, lineHeight: 16 }}>
              {multi === false
                ? "在跑着 ash 的那台电脑上打开它 → 设置 → 默认规则 → 远程访问。"
                : "在电脑上打开 ash → 设置 → 我的 key 里拿。"}
              它只存在这台手机上，每次请求带一次。
            </Text>
          </View>
        )}

        {pairing ? (
          <View style={{ gap: 10, alignItems: "center", paddingVertical: 8 }}>
            <Text style={{ color: theme.muted, fontSize: 13, lineHeight: 19, textAlign: "center" }}>
              在跑着 ash 的那台电脑上点「允许」，这里会自己连上。
            </Text>
            <Text
              accessibilityLabel={`配对码 ${pairing.ticket.code}`}
              style={{ color: theme.ink, fontSize: 40, fontWeight: "600", letterSpacing: 10, fontVariant: ["tabular-nums"] }}
            >
              {pairing.ticket.code}
            </Text>
            <Button label="取消" variant="secondary" onPress={() => setPairing(null)} />
          </View>
        ) : (
          <Button label={status.kind === "testing" ? "测试中…" : "测试并保存"} onPress={save} disabled={status.kind === "testing"} />
        )}

        {multi === false && needsKey && !pairing ? (
          <Pressable onPress={() => setManualKey((value) => !value)} accessibilityRole="button">
            <Text style={{ color: theme.faint, fontSize: 12, textDecorationLine: "underline" }}>
              {manualKey ? "不用密钥，改为向电脑申请配对" : "改用访问密钥"}
            </Text>
          </Pressable>
        ) : null}

        {status.msg ? <Text style={{ color: statusColor, fontSize: 13 }}>{status.msg}</Text> : null}

        <Text style={{ color: theme.faint, fontSize: 12, lineHeight: 18, marginTop: 8 }}>
          {multi === true
            ? "这台 ash 开了多人模式：每个人用自己的 key，看到的也只是自己有权限的项目。"
            : "安全提示：连接本身不加密，请仅经 Tailscale 内网访问，不要把端口暴露到公网。"}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
