import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WasmPathOptions {
  isPackaged?: boolean
  resourcesPath?: string
}

/**
 * Resolves the filesystem path to taglib-wasi.wasm for TagLib WASI initialization.
 * In development, resolves the exported root entry because taglib-wasm@2.5.1
 * does not export ./dist/taglib-wasi.wasm in package.json exports.
 */
export function resolveTaglibWasmPath(options: WasmPathOptions = {}): string {
  if (options.isPackaged) {
    if (!options.resourcesPath) {
      throw new Error('resourcesPath is required when resolving packaged WASI binary')
    }
    return path.join(
      options.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'taglib-wasm',
      'dist',
      'taglib-wasi.wasm'
    )
  }

  const rootEntryPath = fileURLToPath(import.meta.resolve('taglib-wasm'))
  return path.join(path.dirname(rootEntryPath), 'taglib-wasi.wasm')
}
