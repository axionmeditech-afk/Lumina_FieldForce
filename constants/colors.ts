export type ThemeMode = "system" | "light" | "dark";

export interface ThemePalette {
  primary: string;
  primaryLight: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  background: string;
  backgroundElevated: string;
  backgroundTint: string;
  surface: string;
  surfaceSecondary: string;
  glass: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  borderLight: string;
  tint: string;
  tabIconDefault: string;
  tabIconSelected: string;
  statusActive: string;
  statusIdle: string;
  statusOffline: string;
  cardShadow: string;
  overlay: string;
  heroStart: string;
  heroEnd: string;
}

const Colors: { light: ThemePalette; dark: ThemePalette } = {
  light: {
    primary: "#0E5FD8",
    primaryLight: "#EAF3FF",
    secondary: "#2E5B8F",
    accent: "#0B1E3A",
    success: "#00A870",
    warning: "#E8891A",
    danger: "#E0474C",
    background: "#F4F7FB",
    backgroundElevated: "#FFFFFF",
    backgroundTint: "#E5F0FF",
    surface: "#FFFFFF",
    surfaceSecondary: "#ECF3FD",
    glass: "rgba(255, 255, 255, 0.74)",
    text: "#091426",
    textSecondary: "#35506F",
    textTertiary: "#6D87A4",
    border: "#D4E1F2",
    borderLight: "#EAF1FA",
    tint: "#0E5FD8",
    tabIconDefault: "#7B92AB",
    tabIconSelected: "#0E5FD8",
    statusActive: "#00A870",
    statusIdle: "#E8891A",
    statusOffline: "#E0474C",
    cardShadow: "rgba(8, 32, 63, 0.14)",
    overlay: "rgba(9, 20, 38, 0.45)",
    heroStart: "#0E5FD8",
    heroEnd: "#198BF4",
  },
  dark: {
    primary: "#63A6FF",
    primaryLight: "#1B2E47",
    secondary: "#9BC2F9",
    accent: "#E2EEFF",
    success: "#20C88F",
    warning: "#F2B45C",
    danger: "#F17D82",
    background: "#060B16",
    backgroundElevated: "#0D1628",
    backgroundTint: "#122237",
    surface: "#101C31",
    surfaceSecondary: "#1A2A46",
    glass: "rgba(16, 28, 49, 0.72)",
    text: "#F2F7FF",
    textSecondary: "#B4C9E8",
    textTertiary: "#7D94B6",
    border: "#253A57",
    borderLight: "#1A2B45",
    tint: "#63A6FF",
    tabIconDefault: "#5E7598",
    tabIconSelected: "#63A6FF",
    statusActive: "#20C88F",
    statusIdle: "#F2B45C",
    statusOffline: "#F17D82",
    cardShadow: "rgba(0, 0, 0, 0.44)",
    overlay: "rgba(2, 6, 12, 0.72)",
    heroStart: "#103464",
    heroEnd: "#1567AD",
  },
};

export default Colors;
