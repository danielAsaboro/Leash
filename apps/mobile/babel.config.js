module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      require.resolve("babel-preset-expo", {
        paths: [require.resolve("expo/package.json")],
      }),
    ],
    // Android's JSC runtime cannot parse native BigInt literals. QVAC's control-layer
    // dependency graph includes real BigInt arithmetic (notably compact-encoding and
    // bare-hrtime), so lower the syntax and operators to JSBI at bundle time.
    overrides: [
      {
        // Never feed JSBI's own implementation back through the lowering plugin.
        test: /node_modules[\\/](?:bare-hrtime|compact-encoding)[\\/]index\.js$/,
        plugins: ["babel-plugin-transform-bigint-to-jsbi"],
      },
    ],
  };
};
