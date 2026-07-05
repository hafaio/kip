// next-themes stores "system" | "light" | "dark"; the toggle cycles through them.
export type ThemeChoice = "system" | "light" | "dark";

const THEME_ORDER: readonly ThemeChoice[] = ["system", "light", "dark"];

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export function asThemeChoice(value: string | undefined): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

export function nextThemeChoice(current: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
}

export function themeLabel(current: ThemeChoice): string {
  return THEME_LABEL[current];
}
