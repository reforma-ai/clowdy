/**
 * The daemon as JavaScript for a Bun shipped beside it: `main.js`, `mcp-stdio.js` and `clowdy.js` side by side in one folder, with every
 * dependency inlined. The MCP bridge starts `mcp-stdio.js` from the folder `main.js` runs in (`engine/acp/bridge.ts`), and the `clowdy` command the
 * daemon writes at start runs `clowdy.js` from there (`cli/shim.ts`).
 * `version` is the bundle's (`apps/desktop/scripts/bundle.ts`); the daemon reports it as `Health.version`.
 *
 *   bun scripts/bundle.ts <outdir> [version]
 */
import path from 'node:path';

export async function bundleDaemon(outdir: string, version: string): Promise<void> {
    const src = path.resolve(import.meta.dir, '../src');
    const result = await Bun.build({
        entrypoints: [path.join(src, 'main.ts'), path.join(src, 'engine/acp/mcp-stdio.ts'), path.join(src, 'cli/clowdy.ts')],
        outdir,
        // Flat: the bridge finds `mcp-stdio.js`, and the shim `clowdy.js`, next to `main.js`.
        naming: '[name].[ext]',
        target: 'bun',
        define: { __CLOWDY_BUNDLE_VERSION__: JSON.stringify(version) },
    });

    if (!result.success) throw new AggregateError(result.logs, 'The daemon failed to bundle');
}

if (import.meta.main) {
    const [outdir, version] = process.argv.slice(2);

    if (!outdir) {
        console.error('Usage: bun scripts/bundle.ts <outdir> [version]');
        process.exit(1);
    }

    const pkg = await Bun.file(path.resolve(import.meta.dir, '../package.json')).json() as { version: string };

    await bundleDaemon(path.resolve(outdir), version ?? pkg.version);
    console.log(`Bundled the daemon into ${ path.resolve(outdir) }`);
}
