import { createContext, useContext } from "react";
import type { AuthState } from "@ash/shared";

export interface AuthContextValue {
  state: AuthState;
  /**
   * 重新确认身份。**回 false = 这一次没问到**(服务端不可达 / 比前端旧)。
   *
   * 返回值不是装饰:吞掉失败的那一版让首启向导的「进入 ash」在一次 503 之后永久停在
   * 「正在进入…」—— 状态已经有旧的那份,`AuthGate` 的错误屏不出来,子组件也看不见
   * 失败,服务恢复了按钮还是灰的(第 1 轮审查实测)。调用方据此恢复自己的入口。
   */
  refresh: () => Promise<boolean>;
}

// 自用模式的兜底值:`mode: "single"`、没有用户。这样每个消费点都不必写
// `?.` —— 「有没有多人这回事」用 `mode` 判断,而不是用「context 在不在」。
const SINGLE: AuthContextValue = {
  state: { mode: "single", needsSetup: false, user: null, rootDir: null, homeDir: null, needsOnboarding: false },
  refresh: async () => true,
};

export const AuthContext = createContext<AuthContextValue>(SINGLE);

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/** 当前这个人是不是实例管理员。自用模式恒为 true(那条路人人是管理员)。 */
export function useIsInstanceAdmin(): boolean {
  const { state } = useAuth();
  return state.mode !== "multi" || state.user?.role === "admin";
}

/** 现在处于多人模式吗。界面上一大堆「要不要显示这一块」都问它。 */
export function useIsMultiUser(): boolean {
  return useAuth().state.mode === "multi";
}
