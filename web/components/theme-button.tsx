"use client";

import { useTheme } from "next-themes";
import { type ReactElement, useEffect, useState } from "react";
import { LuMonitor, LuMoon, LuSun } from "react-icons/lu";
import { asThemeChoice, nextThemeChoice, themeLabel } from "../utils/theme";
import IconButton from "./ui/icon-button";

export default function ThemeButton(): ReactElement {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Until mounted, next-themes hasn't resolved the stored choice; render the
  // neutral "system" state so server and client markup match.
  const current = mounted ? asThemeChoice(theme) : "system";
  const title = `${themeLabel(current)} theme`;
  const icon =
    current === "dark" ? (
      <LuMoon />
    ) : current === "light" ? (
      <LuSun />
    ) : (
      <LuMonitor />
    );

  return (
    <IconButton
      label={title}
      onClick={() => setTheme(nextThemeChoice(current))}
    >
      {icon}
    </IconButton>
  );
}
