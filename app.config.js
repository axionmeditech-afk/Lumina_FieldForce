const appJson = require("./app.json");
const fs = require("fs");
const path = require("path");

function readDotenvValue(name) {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return "";

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    return rawValue.replace(/^['"]|['"]$/g, "");
  }

  return "";
}

module.exports = () => {
  const expoConfig = appJson.expo || {};
  const androidConfig = expoConfig.android || {};
  const iosConfig = expoConfig.ios || {};
  const googleMapsApiKey =
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    readDotenvValue("EXPO_PUBLIC_GOOGLE_MAPS_API_KEY") ||
    readDotenvValue("GOOGLE_MAPS_API_KEY") ||
    "";
  const googleMapsIosApiKey =
    process.env.GOOGLE_MAPS_IOS_API_KEY ||
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY ||
    googleMapsApiKey ||
    readDotenvValue("GOOGLE_MAPS_IOS_API_KEY") ||
    readDotenvValue("EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY") ||
    "";

  return {
    ...appJson,
    expo: {
      ...expoConfig,
      android: {
        ...androidConfig,
        ...(googleMapsApiKey
          ? {
              config: {
                ...(androidConfig.config || {}),
                googleMaps: {
                  apiKey: googleMapsApiKey,
                },
              },
            }
          : {}),
      },
      ios: {
        ...iosConfig,
        ...(googleMapsIosApiKey
          ? {
              config: {
                ...(iosConfig.config || {}),
                googleMapsApiKey: googleMapsIosApiKey,
              },
            }
          : {}),
      },
      extra: {
        ...(expoConfig.extra || {}),
        googleMapsConfigured: Boolean(googleMapsApiKey),
        googleMapsIosConfigured: Boolean(googleMapsIosApiKey),
      },
    },
  };
};
