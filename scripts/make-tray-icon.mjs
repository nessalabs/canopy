/**
 * Renders the macOS menu-bar template icon into apps/desktop/resources.
 *
 * Template images must be pure black with an alpha channel — macOS recolours them for the
 * light/dark menu bar and for the highlighted state — so the glyph is defined analytically
 * here (discs and capsules on an 18×18 grid) and supersampled into the alpha channel. Run
 * `node scripts/make-tray-icon.mjs` after changing SHAPE; the PNGs are committed.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'resources')

/** Design grid; every coordinate below is in these units regardless of the rendered size. */
const GRID = 18

/** A capsule: the set of points within `w`/2 of the segment (x1,y1)–(x2,y2). */
const capsule = (x1, y1, x2, y2, w) => (x, y) => {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
  const px = x1 + t * dx - x
  const py = y1 + t * dy - y
  return px * px + py * py <= (w / 2) ** 2
}
const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r

/** A trunk forking into two branches, each limb capped with a node: a canopy of worktrees. */
const SHAPE = [
  capsule(9, 14.6, 9, 8.0, 1.8),
  capsule(9, 10.8, 4.4, 6.6, 1.5),
  capsule(9, 10.8, 13.6, 6.6, 1.5),
  disc(9, 5.4, 2.0),
  disc(3.5, 5.4, 1.9),
  disc(14.5, 5.4, 1.9)
]
const inside = (x, y) => SHAPE.some((part) => part(x, y))

/** 8×8 samples per pixel; the coverage becomes the alpha, which is all a template image is. */
function coverage(size) {
  const samples = 8
  const scale = GRID / size
  const alpha = new Uint8Array(size * size)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (inside((px + (sx + 0.5) / samples) * scale, (py + (sy + 0.5) / samples) * scale)) hits++
        }
      }
      alpha[py * size + px] = Math.round((hits / (samples * samples)) * 255)
    }
  }
  return alpha
}

// ---- minimal PNG writer (8-bit RGBA, one IDAT, no filtering) ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(size, alpha) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let at = 0
  for (let y = 0; y < size; y++) {
    raw[at++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      at += 3 // black
      raw[at++] = alpha[y * size + x]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

for (const [size, name] of [[18, 'canopyTemplate.png'], [36, 'canopyTemplate@2x.png']]) {
  const file = join(OUT, name)
  writeFileSync(file, png(size, coverage(size)))
  console.log(`${name}  ${size}×${size}`)
}
