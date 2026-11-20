/**
 * Render the Windows installer's brand artwork from the application mark.
 *
 * The installer pages draw a badge and wordmark above the status line, and the
 * uninstaller draws the mark alone on its sidebar; both themes receive the same
 * badge with the wordmark in the ink that reads on it. `prepare-windows-installer.ps1`
 * flattens these committed PNGs onto white or #151517 at packaging time, which is
 * why they are transparent and why only the ink changes between themes.
 *
 * The committed PNGs are the output; rerun `pnpm run render:installer-brand` in
 * `apps/desktop` after the mark changes.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Mark the artwork is built from; the application icons use the same source. */
export const BRAND_MARK = fileURLToPath(new URL('../resources/icon.svg', import.meta.url))

/** Directory the committed installer artwork lives in. */
export const INSTALLER_ASSETS = fileURLToPath(new URL('../installer/assets/', import.meta.url))

/** Wordmark ink on the installer's light page and on its dark page. */
const LIGHT_INK = '#0f1115'
const DARK_INK = '#f9fafb'

/** Banner canvas in 1x units; the 2x PNG is rendered from the same coordinates. */
const BANNER = { width: 600, height: 196 } as const

/** White badge behind the mark, matching the shipped install pages. */
const BADGE = { cx: 300, cy: 80, radius: 59 } as const

/** Mark edge inside the badge, in 1x units. */
const MARK_EDGE = 96

/** Centred wordmark baseline under the badge, in 1x units. */
const WORDMARK = { x: 300, baseline: 187, size: 32 } as const

/** Uninstaller sidebar canvas and the mark on it, in pixels. */
const SIDEBAR = { width: 164, height: 314, background: '#f3f4f6', edge: 104, cx: 82, cy: 152 } as const

/** One committed raster: its file name and the SVG that produces it. */
export interface InstallerAsset {
  readonly file: string
  readonly svg: string
}

/** Strip the source's outer element so its paths can be nested in another SVG. */
export function markPaths(source: string): string {
  const inner = source.replace(/^<svg[^>]*>/u, '').replace(/<\/svg>\s*$/u, '')
  if (inner === source) throw new Error(`installer brand: ${BRAND_MARK} is not one svg element`)
  return inner
}

/** The badge and wordmark shared by both themes. */
function banner(mark: string, ink: string, scale: 1 | 2): string {
  const width = BANNER.width * scale
  const height = BANNER.height * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(BANNER.width)} ${String(BANNER.height)}">
  <defs>
    <linearGradient id="badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f4f5f7"/>
    </linearGradient>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#15171b" flood-opacity="0.18"/>
    </filter>
  </defs>
  <circle cx="${String(BADGE.cx)}" cy="${String(BADGE.cy)}" r="${String(BADGE.radius)}" fill="url(#badge)" stroke="#e7e9ec" stroke-width="1" filter="url(#shadow)"/>
  <svg x="${String(BADGE.cx - MARK_EDGE / 2)}" y="${String(BADGE.cy - MARK_EDGE / 2)}" width="${String(MARK_EDGE)}" height="${String(MARK_EDGE)}" viewBox="0 0 512 512">${mark}</svg>
  <text x="${String(WORDMARK.x)}" y="${String(WORDMARK.baseline)}" text-anchor="middle" font-family="Montserrat, Segoe UI, sans-serif" font-size="${String(WORDMARK.size)}" font-weight="600" letter-spacing="0.2" fill="${ink}">IAM Harness</text>
</svg>`
}

/** The uninstaller's sidebar: the mark alone on the page's own background. */
function sidebar(mark: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SIDEBAR.width)}" height="${String(SIDEBAR.height)}" viewBox="0 0 ${String(SIDEBAR.width)} ${String(SIDEBAR.height)}">
  <rect width="${String(SIDEBAR.width)}" height="${String(SIDEBAR.height)}" fill="${SIDEBAR.background}"/>
  <svg x="${String(SIDEBAR.cx - SIDEBAR.edge / 2)}" y="${String(SIDEBAR.cy - SIDEBAR.edge / 2)}" width="${String(SIDEBAR.edge)}" height="${String(SIDEBAR.edge)}" viewBox="0 0 512 512">${mark}</svg>
</svg>`
}

/** Every committed asset and the document that draws it. */
export function installerAssets(mark: string): readonly InstallerAsset[] {
  return [
    { file: 'brand.png', svg: banner(mark, LIGHT_INK, 1) },
    { file: 'brand-2x.png', svg: banner(mark, LIGHT_INK, 2) },
    { file: 'brand-dark.png', svg: banner(mark, DARK_INK, 1) },
    { file: 'brand-dark-2x.png', svg: banner(mark, DARK_INK, 2) },
    { file: 'uninstaller-sidebar.png', svg: sidebar(mark) },
  ]
}

const mark = markPaths(await readFile(BRAND_MARK, 'utf8'))
for (const asset of installerAssets(mark)) {
  await writeFile(join(INSTALLER_ASSETS, asset.file), await sharp(Buffer.from(asset.svg)).png().toBuffer())
}
