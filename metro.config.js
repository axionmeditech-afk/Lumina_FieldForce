const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const enableNativeMappls = process.env.EXPO_PUBLIC_ENABLE_MAPPLS_NATIVE === "true";

config.resolver = config.resolver || {};
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "expo-keep-awake": path.resolve(__dirname, "shims/expo-keep-awake.js"),
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
