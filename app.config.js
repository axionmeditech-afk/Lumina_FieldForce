const appJson = require("./app.json");

module.exports = () => {
  const expoConfig = appJson.expo || {};
  const androidConfig = expoConfig.android || {};
  const googleMapsApiKey =
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
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
    },
  };
};
