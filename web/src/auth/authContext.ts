import { createContext, useContext } from "react";
import type { AuthState } from "@ash/shared";

export interface AuthContextValue {
  state: AuthState;
  refresh: () => Promise<void>;
}

// 自用模式的兜底值:`mode: "single"`、没有用户。这样每个消费点都不必写
// `?.` —— 「有没有多人这回事」用 `mode` 判断,而不是用「context 在不在」。
const SINGLE: AuthContextValue = {
  state: { mode: "single", needsSetup: false, user: null, rootDir: null, homeDir: null },
  refresh: async () => {},
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
