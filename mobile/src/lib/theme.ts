// Palettes echoing the harness web console. Plain hex values (no Tailwind here)
// consumed by RN StyleSheet / inline styles. The app follows the device's
// system appearance (app.json `userInterfaceStyle: "automatic"`): useTheme()
// returns the matching palette and re-renders its consumers when the user
// toggles light/dark in iOS/Android settings.
import { useColorScheme } from "react-native";

export type Theme = {
  bg: string;
  panel: string;
  raised: string;
  overlay: string;
  line: string;
  line2: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  accentFg: string;
  danger: string;
  ok: string;
};

// The original dark console look. Surfaces get lighter as they rise: bg <
// panel < raised < overlay.
export const darkTheme: Theme = {
  bg: "#0a0a0b",
  panel: "#161618",
  raised: "#1d1d20",
  overlay: "#26262b",
  line: "#2a2a2f",
  line2: "#35353c",
  ink: "#ededee",
  muted: "#9a9aa3",
  faint: "#6a6a73",
  accent: "#4f7cff",
  accentFg: "#ffffff",
  danger: "#f87171",
  ok: "#34d399",
};

// Light mirror: a near-white grey base with white cards, grey fills, and
// accents deepened for contrast on white. Same semantic roles as darkTheme.
export const lightTheme: Theme = {
  bg: "#f7f7f8",
  panel: "#ffffff",
  raised: "#ececed",
  overlay: "#e8e8eb",
  line: "#e3e3e6",
  line2: "#d2d2d6",
  ink: "#1c1c1e",
  muted: "#6c6c72",
  faint: "#9b9ba1",
  accent: "#2563eb",
  accentFg: "#ffffff",
  danger: "#dc2626",
  ok: "#059669",
};

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

// Follow the device's system light/dark setting. Falls back to dark while the
// scheme is still undetermined (null) so the first paint matches the console.
export function useTheme(): Theme {
  return useColorScheme() === "light" ? lightTheme : darkTheme;
}
