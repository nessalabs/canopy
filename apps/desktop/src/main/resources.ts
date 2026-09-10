import { join } from 'node:path'

import { app } from 'electron'

/**
 * A file from `apps/desktop/resources`. electron-builder copies that directory to
 * `Contents/Resources/assets` (see `extraResources`); in dev it sits two levels above the
 * built main bundle. Paths, not `?asset` imports, because `nativeImage.createFromPath` finds
 * the `@2x` companion only when both files keep their names side by side.
 */
export const resource = (name: string): string => join(app.isPackaged ? join(process.resourcesPath, 'assets') : join(__dirname, '../../resources'), name)
