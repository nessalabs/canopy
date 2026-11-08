import { extname } from 'node:path'

/**
 * The media types the raw file route can name, by extension. Only the kinds a browser can show
 * on its own are listed: anything else is handed over as plain bytes, which is what it is.
 */
const BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
}

export const contentTypeOf = (path: string): string => BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
