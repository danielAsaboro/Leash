/**
 * Mesh membership metadata must live beside the Corestore directory, not inside it. Corestore owns
 * the directory lifecycle; a sibling survives store recovery/replacement and can be read before the
 * store is reopened on the next app launch.
 */
export function meshMetaPath(storeDir) {
  return `${storeDir}.meta.json`;
}

export function readMeshMeta({ fs, storeDir, decode }) {
  try {
    return JSON.parse(decode(fs.readFileSync(meshMetaPath(storeDir))));
  } catch {
    return {};
  }
}

export function writeMeshMeta({ fs, storeDir, encode, meta, onError }) {
  try {
    fs.writeFileSync(meshMetaPath(storeDir), encode(JSON.stringify(meta)));
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
