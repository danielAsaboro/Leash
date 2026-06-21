const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withGradleProperties, withMainApplication } = require("@expo/config-plugins");

const THIRD_PARTY_JSC_PROPERTY = "useThirdPartyJSC";

function setGradleProperty(items, key, value) {
  const next = { type: "property", key, value };
  const index = items.findIndex((item) => item.type === "property" && item.key === key);
  if (index === -1) items.push(next);
  else items.splice(index, 1, next);
}

function addImport(source, statement) {
  if (source.includes(statement)) return source;
  const anchor = "import com.facebook.react.ReactHost\n";
  if (!source.includes(anchor)) throw new Error("Android JSC plugin could not find the ReactHost import");
  return source.replace(anchor, `${anchor}${statement}\n`);
}

function patchKotlinMainApplication(source) {
  let next = source;
  for (const statement of [
    "import com.facebook.react.bridge.JavaScriptExecutorFactory",
    "import com.facebook.react.modules.systeminfo.AndroidInfoHelpers",
    "import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost",
    "import io.github.reactnativecommunity.javascriptcore.JSCExecutorFactory",
    "import io.github.reactnativecommunity.javascriptcore.JSCRuntimeFactory",
  ]) {
    next = addImport(next, statement);
  }

  if (!next.includes("override fun getJavaScriptExecutorFactory()")) {
    const anchor = "          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG\n";
    if (!next.includes(anchor)) throw new Error("Android JSC plugin could not find getUseDeveloperSupport");
    next = next.replace(
      anchor,
      `${anchor}\n          override fun getJavaScriptExecutorFactory(): JavaScriptExecutorFactory =\n            JSCExecutorFactory(packageName, AndroidInfoHelpers.getFriendlyDeviceName())\n`,
    );
  }

  const expoHost = "    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)";
  const jscHost = "    get() = getDefaultReactHost(applicationContext, reactNativeHost, JSCRuntimeFactory())";
  if (next.includes(expoHost)) next = next.replace(expoHost, jscHost);
  if (!next.includes(jscHost)) throw new Error("Android JSC plugin could not configure the JSC ReactHost");

  return next;
}

function patchBareKitJscArrayBuffer(source) {
  const before = `    auto buffer = std::make_shared<BareKitBuffer>(len);

    std::copy(data, data + len, buffer->data());

    return ArrayBuffer(rt, buffer);`;
  const after = `    // React Native's JavaScriptCore runtime throws "Not implemented" for
    // Runtime::createArrayBuffer(MutableBuffer). Allocate through the JS ArrayBuffer constructor
    // instead, then copy the IPC frame into storage that every supported runtime can expose.
    auto array_buffer = rt.global()
      .getPropertyAsFunction(rt, "ArrayBuffer")
      .callAsConstructor(rt, double(len))
      .getObject(rt)
      .getArrayBuffer(rt);

    std::copy(data, data + len, array_buffer.data(rt));

    return array_buffer;`;

  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error("Android JSC plugin could not find BareKit's native ArrayBuffer read path");
  return source.replace(before, after);
}

module.exports = function withAndroidJsc(config) {
  config = withGradleProperties(config, (mod) => {
    setGradleProperty(mod.modResults, THIRD_PARTY_JSC_PROPERTY, "true");
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    if (mod.modResults.language !== "kt") {
      throw new Error(`Android JSC plugin expected Kotlin MainApplication, got ${mod.modResults.language}`);
    }
    mod.modResults.contents = patchKotlinMainApplication(mod.modResults.contents);
    return mod;
  });

  return withDangerousMod(config, ["android", async (mod) => {
    const bareKitSource = path.join(
      mod.modRequest.projectRoot,
      "node_modules/react-native-bare-kit/shared/BareKitModule.cc",
    );
    const source = fs.readFileSync(bareKitSource, "utf8");
    fs.writeFileSync(bareKitSource, patchBareKitJscArrayBuffer(source));
    return mod;
  }]);
};

module.exports.patchKotlinMainApplication = patchKotlinMainApplication;
module.exports.patchBareKitJscArrayBuffer = patchBareKitJscArrayBuffer;
