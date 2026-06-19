// Backend base URL — the one piece of config the user sets. Persisted in
// AsyncStorage and cached in-module so the api/sse layers can read it
// synchronously after `loadBaseURL()` has run once at boot.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "harness.baseURL";
let cached: string | null = null;

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

export function getBaseURL(): string | null {
  return cached;
}

export async function loadBaseURL(): Promise<string | null> {
  cached = await AsyncStorage.getItem(KEY);
  return cached;
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
