// electron-builder drops `node_modules` from `extraResources` copies, but two bundles need their
// node_modules at runtime: the Next standalone server (next/react/@prisma/client/…) and the
// arch-pruned QVAC runtime (@qvac/cli + sdk + engines, run by Electron's Node). Copy both into the
// packed app's Resources after packaging.
const { cpSync, existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir // apps/desktop
  const appName = context.packager.appInfo.productFilename // "Leash"
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')

  const copies = [
    {
      label: 'standalone node_modules',
      src: join(projectDir, '..', 'web', '.next', 'standalone', 'node_modules'),
      dest: join(resources, 'leash', 'node_modules'),
      hint: 'run `next build` for @mycelium/web first',
    },
    // The qvac runtime is downloaded after Setup (stub installer), not bundled here.
  ]

  for (const { label, src, dest, hint } of copies) {
    if (!existsSync(src)) {
      console.warn(`[after-pack] ${label} not found at ${src} — ${hint}`)
      continue
    }
    cpSync(src, dest, { recursive: true })
    console.log(`[after-pack] copied ${label} → ${dest}`)
  }
}
