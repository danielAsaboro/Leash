import assert from "node:assert/strict";
import { qvacServeOpenAiUrl } from "../apps/web/lib/leash/serve-endpoint.ts";

assert.equal(qvacServeOpenAiUrl({}), "http://127.0.0.1:11435/v1");
assert.equal(
  qvacServeOpenAiUrl({ QVAC_OPENAI_URL: "http://127.0.0.1:11436/v1" }),
  "http://127.0.0.1:11435/v1",
  "the chat broker must never become the managed serve endpoint",
);
assert.equal(
  qvacServeOpenAiUrl({ LEASH_BROKER_UPSTREAM: "http://127.0.0.1:22435" }),
  "http://127.0.0.1:22435/v1",
);
assert.equal(
  qvacServeOpenAiUrl({ QVAC_SERVE_URL: "http://127.0.0.1:33435/v1/" }),
  "http://127.0.0.1:33435/v1",
);

console.log("PASS serve endpoint remains direct when chat routes through the broker");
