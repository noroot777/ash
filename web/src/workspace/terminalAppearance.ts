import type { ITheme } from "@xterm/xterm";

export const TERMINAL_APPEARANCE_KEY = "navi:terminal-appearance";

export const terminalThemes = {
  graphite: {
    label: "石墨",
    colors: {
      background: "#17191f", foreground: "#d8dee9", cursor: "#e5e9f0", cursorAccent: "#17191f",
      selectionBackground: "#414b60", black: "#303642", red: "#e78284", green: "#a6d189",
      yellow: "#e5c890", blue: "#8caaee", magenta: "#ca9ee6", cyan: "#81c8be", white: "#d8dee9",
      brightBlack: "#79849a", brightRed: "#ea999c", brightGreen: "#b5dda0", brightYellow: "#f1d9aa",
      brightBlue: "#a6c0ff", brightMagenta: "#dfb7f5", brightCyan: "#a0ddd4", brightWhite: "#f2f5fa",
    },
  },
  midnight: {
    label: "午夜",
    colors: {
      background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "#33467c", black: "#414868", red: "#f7768e", green: "#9ece6a",
      yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#787c99", brightRed: "#ff9eaa", brightGreen: "#b9e38a", brightYellow: "#f0ca8f",
      brightBlue: "#9dbdff", brightMagenta: "#d4baff", brightCyan: "#a4e2ff", brightWhite: "#dce3ff",
    },
  },
  paper: {
    label: "纸白",
    colors: {
      background: "#f5f2eb", foreground: "#343b45", cursor: "#343b45", cursorAccent: "#f5f2eb",
      selectionBackground: "#d7dfeb", black: "#343b45", red: "#b74743", green: "#46763c",
      yellow: "#8d6519", blue: "#345fa4", magenta: "#8052a1", cyan: "#247783", white: "#646b75",
      brightBlack: "#777d86", brightRed: "#a83d39", brightGreen: "#37682d", brightYellow: "#79530a",
      brightBlue: "#244d92", brightMagenta: "#70418f", brightCyan: "#156773", brightWhite: "#242b35",
    },
  },
} satisfies Record<string, { label: string; colors: ITheme }>;

export type TerminalTheme = keyof typeof terminalThemes;
export type TerminalAppearance = { theme: TerminalTheme; fontSize: number };

export function readTerminalAppearance(): TerminalAppearance {
  try {
    const stored = JSON.parse(localStorage.getItem(TERMINAL_APPEARANCE_KEY) ?? "null");
    return {
      theme: stored && Object.hasOwn(terminalThemes, stored.theme) ? stored.theme : "graphite",
      fontSize: [12, 14, 16].includes(stored?.fontSize) ? stored.fontSize : 14,
    };
  } catch {
    return { theme: "graphite", fontSize: 14 };
  }
}
