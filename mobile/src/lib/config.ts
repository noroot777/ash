// Backend base URL — the one piece of config the user sets. Persisted in
// AsyncStorage and cached in-module so the api/sse layers can read it
// synchronously after `loadBaseURL()` has run once at boot.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "ash.baseURL";
const LEGACY_KEY = "harness.baseURL";
const TOKEN_KEY = "ash.apiKey";
let cached: string | null = null;
// 多人模式下每个请求都要带 `Authorization: Bearer <key>`(§三)。手机上没有 cookie
// 那条路 —— 它也不该有:cookie 会跟着 WebView 到处跑,而这把 key 只归这个 app。
// 与 baseURL 同样在 boot 时读一次进内存,好让 api 层同步取用。
let cachedKey: string | null = null;

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

export function getBaseURL(): string | null {
  return cached;
}

/** 自用模式的 ash 不需要它,留空即可 —— 服务端那边根本不看这个头。 */
export function getApiKey(): string | null {
  return cachedKey;
}

export async function loadBaseURL(): Promise<string | null> {
  cached = await AsyncStorage.getItem(KEY);
  if (!cached) {
    cached = await AsyncStorage.getItem(LEGACY_KEY);
    if (cached) {
      await AsyncStorage.setItem(KEY, cached);
      await AsyncStorage.removeItem(LEGACY_KEY);
    }
  }
  // On web (the desktop preview, served from the ash itself) default to the
  // serving origin so the preview talks to that same backend with zero setup.
  // Native is left untouched — a phone can't assume the server's origin.
  if (!cached && Platform.OS === "web" && typeof window !== "undefined" && window.location?.origin) {
    cached = normalize(window.location.origin);
  }
  return cached;
}

export async function loadApiKey(): Promise<string | null> {
  cachedKey = await AsyncStorage.getItem(TOKEN_KEY);
  return cachedKey;
}

export async function setApiKey(key: string): Promise<void> {
  const v = key.trim();
  cachedKey = v || null;
  if (v) await AsyncStorage.setItem(TOKEN_KEY, v);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

export async function setBaseURL(url: string): Promise<string> {
  const v = normalize(url);
  cached = v;
  await AsyncStorage.setItem(KEY, v);
  return v;
}

export async function clearBaseURL(): Promise<void> {
  cached = null;
  await AsyncStorage.removeItem(KEY);
}
