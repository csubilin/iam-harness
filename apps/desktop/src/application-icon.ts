/**
 * The icon a shell-owned window asks the platform to draw for it.
 *
 * Unpackaged, the process is `electron.exe`, and Windows draws Electron's atom
 * in the taskbar and Alt-Tab unless the window carries its own icon. Packaged,
 * the exe already carries this artwork, but asking for it again keeps the two
 * launch modes identical. macOS reads the icon from the bundle and ignores the
 * window option, so the caller there asks for nothing.
 */
import { app } from 'electron'
import { join } from 'node:path'

/**
 * Resolve the window icon for the running launch mode.
 * @param platform - operating system hosting Electron.
 * @returns an absolute image path, or undefined where the platform ignores it.
 */
export function windowIconPath(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'darwin') return undefined
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon-windows.png')
}
