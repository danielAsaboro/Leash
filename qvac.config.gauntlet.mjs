export default {
  swarmRelays: [],
  loggerConsoleOutput: false,
  serve: {
    models: {
      "qwen3-4b": {
        model: "QWEN3_4B_INST_Q4_K_M",
        preload: true,
        default: true,
        config: {
          tools: true,
          toolsMode: "dynamic",
          ctx_size: 32768,
        },
      },
      embed: {
        model: "GTE_LARGE_FP16",
        preload: true,
      },
      classifier: {
        model: "QWEN3_600M_INST_Q4",
        preload: true,
        config: {
          ctx_size: 8192,
        },
      },
    },
  },
};
