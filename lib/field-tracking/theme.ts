export const palette = {
  background: '#F7F8FC',
  surface: '#FFFFFF',
  surfaceMuted: '#F0F3F8',
  surfaceStrong: '#E7ECF3',
  ink: '#172033',
  text: '#172033',
  textMuted: '#697386',
  textSubtle: '#8A94A6',
  line: '#D8DEE8',
  lineStrong: '#C5CEDB',
  primary: '#2638D8',
  primaryDark: '#1B2AB7',
  primarySoft: '#EDF0FF',
  success: '#168A5B',
  successSoft: '#E8F7F0',
  warning: '#B96A00',
  warningSoft: '#FFF4DF',
  danger: '#C73E45',
  dangerSoft: '#FDEDEF',
  info: '#2C6FC7',
  mapRoute: '#2638D8',
  mapRouteShadow: '#FFFFFF',
  mapLand: '#F4F5F7',
  mapRoad: '#FFFFFF'
} as const;

export const radii = {
  sm: 8,
  md: 13,
  lg: 18,
  pill: 999
} as const;

export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 22,
  xl: 30
} as const;

export const shadow = {
  card: {
    shadowColor: '#172033',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3
  }
} as const;
