const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const enableNativeMappls = process.env.EXPO_PUBLIC_ENABLE_MAPPLS_NATIVE === "true";

config.resolver = config.resolver || {};
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "@": __dirname,
  "expo-keep-awake": path.resolve(__dirname, "shims/expo-keep-awake.js"),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@/")) {
    return context.resolveRequest(context, path.join(__dirname, moduleName.slice(2)), platform);
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

if (!enableNativeMappls) {
  config.resolver.extraNodeModules = {
    ...(config.resolver.extraNodeModules || {}),
    "mappls-map-react-native": path.resolve(__dirname, "shims/mappls-map-react-native.js"),
    "mappls-tracking-react-native": path.resolve(
      __dirname,
      "shims/mappls-tracking-react-native.js"
    ),
  };
}

module.exports = config;
