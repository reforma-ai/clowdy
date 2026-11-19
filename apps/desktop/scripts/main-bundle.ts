import path from 'node:path';

/**
 * Bundles the main process and the preload into `outdir/main/index.cjs` and `outdir/preload/index.cjs`.
 * Electron's sandboxed preload and its main process load CommonJS; everything else is inlined.
 * `Bun.build` inlines `__dirname` as the source directory, so build paths from `app.getAppPath()`.
 * `define` bakes in a release build's constants (`src/main/releaseConfig.ts`); a development bundle has none.
 */
export async function buildMain(outdir: string, define: Record<string, string> = {}): Promise<void> {
    const src = path.resolve(import.meta.dir, '../src');
    const result = await Bun.build({
        entrypoints: [path.join(src, 'main/index.ts'), path.join(src, 'preload/index.ts')],
        root: src,
        outdir,
        naming: '[dir]/[name].cjs',
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        minify: false,
        define,
    });

    if (!result.success) throw new AggregateError(result.logs, 'Main or preload failed to bundle');
}
