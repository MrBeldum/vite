import { describe, expect, it, vi } from 'vitest'
import { BundledDev, MemoryFiles } from '../bundledDev'

function createBundledDev() {
  const notifyPayloadDelivered = vi.fn()
  const compileEntry = vi.fn()
  const environment: any = {
    name: 'client',
    config: { root: '/' },
    logger: { info: vi.fn(), error: vi.fn() },
  }
  const bundledDev: any = new BundledDev(environment)
  bundledDev._devEngine = { notifyPayloadDelivered, compileEntry }
  return { bundledDev, notifyPayloadDelivered, compileEntry }
}

const chunk = (fileName: string, code = `// ${fileName}`) => ({
  type: 'chunk',
  fileName,
  code,
})
const asset = (fileName: string, source = `{"file":"${fileName}"}`) => ({
  type: 'asset',
  fileName,
  source,
})

describe('MemoryFiles', () => {
  it('supports deleting a stored file', () => {
    const memoryFiles = new MemoryFiles()
    memoryFiles.set('a.js', { source: 'a' })
    expect(memoryFiles.has('a.js')).toBe(true)
    memoryFiles.delete('a.js')
    expect(memoryFiles.has('a.js')).toBe(false)
    expect(memoryFiles.size).toBe(0)
  })
})

describe('BundledDev memory eviction (vite#23781)', () => {
  it('evicts stale hashed chunks and maps across rebuilds', () => {
    const { bundledDev } = createBundledDev()
    const memoryFiles: MemoryFiles = bundledDev.memoryFiles

    // initial build
    bundledDev.storeOutputFiles([
      chunk('assets/index.js'),
      chunk('assets/shared-aaaa1111.js'),
      asset('assets/shared-aaaa1111.js.map'),
    ])
    expect(memoryFiles.size).toBe(3)

    // rebuild: the shared chunk's content changed, so its hash changed
    bundledDev.storeOutputFiles([
      chunk('assets/index.js'),
      chunk('assets/shared-bbbb2222.js'),
      asset('assets/shared-bbbb2222.js.map'),
    ])

    // the previous hashed copies are gone instead of accumulating
    expect(memoryFiles.has('assets/shared-aaaa1111.js')).toBe(false)
    expect(memoryFiles.has('assets/shared-aaaa1111.js.map')).toBe(false)
    // unchanged and new files stay
    expect(memoryFiles.has('assets/index.js')).toBe(true)
    expect(memoryFiles.has('assets/shared-bbbb2222.js')).toBe(true)
    expect(memoryFiles.has('assets/shared-bbbb2222.js.map')).toBe(true)
    expect(memoryFiles.size).toBe(3)
  })

  it('does not evict the full build output when storing additional assets', () => {
    const { bundledDev } = createBundledDev()
    const memoryFiles: MemoryFiles = bundledDev.memoryFiles

    bundledDev.storeOutputFiles([chunk('assets/index.js')])
    // assets emitted while generating an HMR patch / lazy chunk
    bundledDev.storeOutputFiles([asset('assets/new-image-abcd1234.png')], false)
    expect(memoryFiles.has('assets/index.js')).toBe(true)
    expect(memoryFiles.has('assets/new-image-abcd1234.png')).toBe(true)

    // the next full rebuild must not drop the additional asset
    bundledDev.storeOutputFiles([chunk('assets/index.js')])
    expect(memoryFiles.has('assets/index.js')).toBe(true)
    expect(memoryFiles.has('assets/new-image-abcd1234.png')).toBe(true)
  })

  it('drops an HMR patch and its source map once the client reports delivery', () => {
    const { bundledDev, notifyPayloadDelivered } = createBundledDev()
    const memoryFiles: MemoryFiles = bundledDev.memoryFiles
    const client = { send: vi.fn() }

    bundledDev.handleHmrOutput(client, ['/src/foo.ts'], {
      type: 'Patch',
      code: '// patch',
      filename: 'hmr_patch_0.js',
      sourcemap: '{"version":3}',
      sourcemapFilename: 'hmr_patch_0.js.map',
      changedIds: ['/src/foo.ts'],
      seq: 0,
    })
    expect(memoryFiles.has('hmr_patch_0.js')).toBe(true)
    expect(memoryFiles.has('hmr_patch_0.js.map')).toBe(true)

    bundledDev.markPayloadDelivered('hmr_patch_0.js')

    expect(memoryFiles.has('hmr_patch_0.js')).toBe(false)
    expect(memoryFiles.has('hmr_patch_0.js.map')).toBe(false)
    expect(notifyPayloadDelivered).toHaveBeenCalledWith('hmr_patch_0.js')
  })

  it('drops a lazy payload and its source map once the client reports delivery', async () => {
    const { bundledDev, compileEntry, notifyPayloadDelivered } =
      createBundledDev()
    const memoryFiles: MemoryFiles = bundledDev.memoryFiles
    compileEntry.mockResolvedValue({
      code: '// lazy chunk',
      filename: 'lazy-chunk-xyz.js',
      sourcemap: '{"version":3}',
      sourcemapFilename: 'lazy-chunk-xyz.js.map',
    })

    await bundledDev.triggerLazyBundling('/src/lazy.ts', 'client-1')
    // the chunk code is served directly by the middleware; only its source
    // map is registered in memoryFiles
    expect(memoryFiles.has('@vite/lazy-chunk-xyz.js.map')).toBe(true)

    bundledDev.markPayloadDelivered('lazy-chunk-xyz.js')

    expect(memoryFiles.has('@vite/lazy-chunk-xyz.js.map')).toBe(false)
    expect(notifyPayloadDelivered).toHaveBeenCalledWith('lazy-chunk-xyz.js')
  })

  it('ignores delivery reports for unknown payloads', () => {
    const { bundledDev, notifyPayloadDelivered } = createBundledDev()
    bundledDev.markPayloadDelivered('hmr_patch_999.js')
    expect(notifyPayloadDelivered).not.toHaveBeenCalled()
  })
})
