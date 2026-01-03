module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // expo-router/babel is now included in babel-preset-expo for SDK 50+
  };
};
