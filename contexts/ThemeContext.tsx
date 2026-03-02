import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import Colors, { type ThemeMode, type ThemePalette } from "@/constants/colors";
import { getThemePreference, setThemePreference } from "@/lib/storage";

interface ThemeContextValue {
  mode: ThemeMode;
  isDark: boolean;
  colors: ThemePalette;
  setMode: (nextMode: ThemeMode) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveMode(_mode: ThemeMode, _systemTheme: "light" | "dark" | null | undefined): "light" | "dark" {
  if (_mode === "system") {
    return _systemTheme === "dark" ? "dark" : "light";
  }
  return _mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemTheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("light");
  const [isBootstrapping, setIsBootstrapping] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const persistedMode = await getThemePreference();
        setModeState(persistedMode);
      } finally {
        setIsBootstrapping(false);
      }
    })();
  }, []);

  const setMode = useCallback(async (nextMode: ThemeMode) => {
    setModeState(nextMode);
    await setThemePreference(nextMode);
  }, []);

  const resolvedMode = resolveMode(mode, systemTheme);
  const isDark = resolvedMode === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  const value = useMemo(
    () => ({
      mode,
      isDark,
      colors,
      setMode,
    }),
    [mode, isDark, colors, setMode]
  );

  if (isBootstrapping) {
    return null;
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useAppTheme must be used within ThemeProvider");
  }
  return context;
}
