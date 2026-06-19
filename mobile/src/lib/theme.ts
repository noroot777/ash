// "Mission Control" palette — a cold graphite console with a single signal accent
// (mint-teal). Plain hex (no Tailwind) consumed by RN StyleSheet / inline styles.
// The app follows the device's system appearance (app.json
// `userInterfaceStyle: "automatic"`): useTheme() returns the matching palette and
// re-renders consumers when the user toggles light/dark.
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

// Dark = the primary look: near-black cold graphite, surfaces rise bg < panel <
// raised < overlay. Accent is a restrained signal mint-teal (deliberately NOT the
// AI-default acid-green / vermilion).
export const darkTheme: Theme = {
  bg: "#0C0E12",
  panel: "#161A20",
  raised: "#1E232B",
  overlay: "#262C36",
  line: "#2A2F38",
  line2: "#353C47",
  ink: "#E6E9EE",
  muted: "#8B92A0",
  faint: "#565E6B",
  accent: "#5EE6C5",
  accentFg: "#06140F",
  danger: "#FF6B6B",
  ok: "#5EE6C5",
};

// Light mirror: cold near-white, white cards, accent deepened for contrast on
// white. Same semantic roles as darkTheme.
export const lightTheme: Theme = {
  bg: "#F4F6F8",
  panel: "#FFFFFF",
  raised: "#EAEEF1",
  overlay: "#E2E7EB",
  line: "#DDE3E8",
  line2: "#C9D1D8",
  ink: "#161A20",
  muted: "#5A6472",
  faint: "#93A0AD",
  accent: "#0EA88A",
  accentFg: "#FFFFFF",
  danger: "#E5484D",
  ok: "#0EA88A",
};

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

// Type roles — Space Grotesk (display, characterful), Inter (body, neutral),
// IBM Plex Mono (machine data: agent names, task ids, timestamps, status). Loaded
// in _layout via expo-google-fonts; names must match the package exports.
export const fonts = {
  display: "SpaceGrotesk_700Bold",
  displayMd: "SpaceGrotesk_500Medium",
  body: "Inter_400Regular",
  bodyMed: "Inter_500Medium",
  bodySemi: "Inter_600SemiBold",
  mono: "IBMPlexMono_400Regular",
  monoMed: "IBMPlexMono_500Medium",
} as const;

// Follow the device's system light/dark setting. Falls back to dark while the
// scheme is still undetermined (null) so the first paint matches the console.
export function useTheme(): Theme {
  return useColorScheme() === "light" ? lightTheme : darkTheme;
}
