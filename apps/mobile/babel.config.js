module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      require.resolve("babel-preset-expo", {
        paths: [require.resolve("expo/package.json")],
      }),
    ],
  };
};
