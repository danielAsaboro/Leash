// Minimal browser `process` shim.
//
// In this monorepo the top-level `node_modules/process` resolves to **bare-process**
// (hoisted from `@qvac/sdk`'s dependency `process@npm:bare-process`). bare-process's
// entry does `require('bare-abort')` → `bare-abort/binding.js`, which calls a native
// addon that does not exist in the browser and throws
// `__webpack_require__(...).addon is not a function` at module-eval time — crashing the
// whole client bundle and breaking React hydration on every page.
//
// next.config aliases `process` to THIS file for the client build, so the Bare runtime
// never enters the browser bundle. Next already inlines `process.env.NODE_ENV` /
// `NEXT_PUBLIC_*` at compile time via DefinePlugin, so this only needs to be a safe,
// inert object for any residual runtime access.
module.exports = {
  env: {},
  browser: true,
  platform: "browser",
  version: "",
  versions: {},
  argv: [],
  argv0: "",
  pid: 0,
  title: "browser",
  nextTick: function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    Promise.resolve().then(function () {
      fn.apply(null, args);
    });
  },
  cwd: function () {
    return "/";
  },
  on: function () {},
  once: function () {},
  off: function () {},
  removeListener: function () {},
  emit: function () {},
};
