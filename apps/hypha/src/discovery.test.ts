import assert from "node:assert/strict";
import test from "node:test";
import { parseDnsSdCellBrowseLine, parseDnsSdCellResolve } from "./discovery.ts";

test("macOS DNS-SD browser parser accepts only bounded added cell instances", () => {
  assert.equal(
    parseDnsSdCellBrowseLine("18:24:13.616  Add        3  19 local. _hyphacell._tcp. cell-e285cdde"),
    "cell-e285cdde",
  );
  assert.equal(parseDnsSdCellBrowseLine("18:24:13.616  Rmv        3  19 local. _hyphacell._tcp. cell-e285cdde"), null);
  assert.equal(parseDnsSdCellBrowseLine("18:24:13.616  Add 3 19 local. _hypha._tcp. private-device"), null);
  assert.equal(parseDnsSdCellBrowseLine(`18:24 Add 3 19 local. _hyphacell._tcp. ${"x".repeat(201)}`), null);
});

test("macOS DNS-SD resolver parser validates cell and 32-byte feed identity", () => {
  const feed = "e285cdde1e47d2a45a472b45c64b43638520a214e95eb098d1d569291ca0ecc4";
  const output = `cell-e285cdde._hyphacell._tcp.local. can be reached at provider.local.:11438\n cell=qvac-edge-public feed=${feed}\n`;
  assert.equal(parseDnsSdCellResolve(output, "qvac-edge-public"), feed);
  assert.equal(parseDnsSdCellResolve(output, "another-cell"), null);
  assert.equal(parseDnsSdCellResolve(output.replace(feed, "abcd"), "qvac-edge-public"), null);
});
