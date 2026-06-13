// electron-builder drops `node_modules` from `extraResources` copies, but the Next
// standalone server needs its traced node_modules (next, react, @prisma/client, …)
// to run. Copy them into the packed app's Resources/leash after packaging.
const { cpSync, existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir // apps/desktop
  const src = join(projectDir, '..', 'web', '.next', 'standalone', 'node_modules')
  if (!existsSync(src)) {
    console.warn(`[after-pack] standalone node_modules not found at ${src} — run \`next build\` for @mycelium/web first`)
    return
  }
  const appName = context.packager.appInfo.productFilename // "Leash"
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  const dest = join(resources, 'leash', 'node_modules')
  cpSync(src, dest, { recursive: true })
  console.log(`[after-pack] copied standalone node_modules → ${dest}`)
}
