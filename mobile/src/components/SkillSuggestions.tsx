import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { SkillEntry, SkillSource } from "@harness/shared";
import { api } from "@/lib/api";
import { useTheme, radius, fonts } from "@/lib/theme";

// 手机上的 `/` 补全。桌面那套是键盘菜单(↑↓ + 回车),手机没有键盘导航,所以做成
// 输入框上方的一条横向候选带:点一下把 `/名字 ` 填进输入框,原样发下去由 CLI 自己
// 认 —— harness 不写任何提示词,也不截走这条消息。
//
// 只在「整段正文就是一个斜杠 token」时出现,句子中间的 `/` 不打扰打字。

const SOURCE_LABEL: Record<SkillSource, string> = {
  project: "项目",
  user: "个人",
  plugin: "插件",
  builtin: "内置",
};

// 拉过的清单按「执行器+项目」记住:手机上每敲一次 `/` 都转一次圈太难看。
const cache = new Map<string, { skills: SkillEntry[]; remote: boolean }>();

export function slashToken(text: string): string | null {
  return /^\s*(\/\S*)$/.exec(text)?.[1]?.toLowerCase() ?? null;
}

export function SkillSuggestions({
  agentType,
  projectId,
  executorId,
  value,
  onPick,
}: {
  agentType?: string | null;
  projectId?: string | null;
  executorId?: string | null;
  value: string;
  onPick: (command: string) => void;
}) {
  const theme = useTheme();
  const token = slashToken(value);
  const wants = token !== null;
  const cli = agentType || "claude";
  const key = [cli, projectId ?? "", executorId ?? ""].join("|");
  const [state, setState] = useState(() => cache.get(key) ?? { skills: [], remote: false });

  useEffect(() => {
    setState(cache.get(key) ?? { skills: [], remote: false });
    // 没敲斜杠就不发请求:这条带子是按需出现的,没必要每开一个任务就扫一遍磁盘。
    if (!wants) return;
    let alive = true;
    api
      .skills({ agentType: cli, projectId: projectId ?? undefined, executorId: executorId ?? undefined })
      .then((list) => {
        const next = { skills: list.skills, remote: list.remote };
        cache.set(key, next);
        if (alive) setState(next);
      })
      .catch(() => {
        // 拉不到就当没有技能:补全坏掉不该让输入框看起来出事。
      });
    return () => {
      alive = false;
    };
  }, [cli, executorId, key, projectId, wants]);

  if (!token) return null;
  if (state.remote) {
    // ssh 执行器:技能装在远端盘上,本机列不出来。如实说,别装成「没装技能」。
    return (
      <Text style={{ color: theme.faint, fontSize: 11 }}>
        这个执行器跑在 ssh 远端,技能清单只有它自己看得见——照常发 /名字,它认得。
      </Text>
    );
  }
  const matches = state.skills.filter((skill) => skill.command.toLowerCase().startsWith(token));
  if (!matches.length) return null;

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.faint, fontSize: 11 }}>
        已装技能 · 点一下补进输入框,原样发给 CLI 自己认
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // 键盘弹着的时候点候选必须直接生效,否则第一下只是收键盘。
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ gap: 6, paddingRight: 12 }}
      >
        {matches.map((skill) => (
          <Pressable
            key={`${skill.source}:${skill.command}`}
            onPress={() => onPick(skill.command)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              maxWidth: 260,
              backgroundColor: theme.overlay,
              borderRadius: radius.sm,
              paddingHorizontal: 10,
              paddingVertical: 7,
            }}
          >
            <Text style={{ color: theme.accent, fontSize: 13, fontFamily: fonts.mono }}>
              {skill.command}
            </Text>
            {!!skill.description && (
              <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.muted, fontSize: 12 }}>
                {skill.description}
              </Text>
            )}
            <Text style={{ color: theme.faint, fontSize: 10 }}>{SOURCE_LABEL[skill.source]}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
