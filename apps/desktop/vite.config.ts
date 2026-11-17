// The renderer. `scripts/dev.ts` serves it for HMR; `scripts/build.ts` builds it into the packaged app.
import react from '@vitejs/plugin-react';
import observingComponentsPlugin from 'babel-plugin-observing-components';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path, { resolve } from 'node:path';
import UnoCSS from 'unocss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import babel from 'vite-plugin-babel';
import svgr from 'vite-plugin-svgr';

import { pinCssLayerOrderPlugin } from '../../packages/styles/layer-order.ts';

const require = createRequire(import.meta.url);
const isProd = process.env.NODE_ENV === 'production';
const desktopRoot = resolve(import.meta.dirname);
const monorepoRoot = searchForWorkspaceRoot(desktopRoot);

export default defineConfig({
    root: resolve(desktopRoot, 'src/renderer'),
    // The dependency cache lives beside the app, not under the renderer folder.
    // `CLOWDY_VITE_CACHE_DIR` gives each of several concurrent dev servers its own.
    cacheDir: process.env.CLOWDY_VITE_CACHE_DIR ?? resolve(desktopRoot, 'node_modules/.vite'),
    css: {
        // The root `postcss.config.mjs`: `@ruleset` expansion, nesting, declaration order.
        postcss: monorepoRoot,
        modules: {
            localsConvention: 'camelCase',
            generateScopedName: isProd ? '[hash:base64:6]' : (name, filename) => {
                const file = path.basename(filename).replace(/\.module\.\w+$/, '');
                const hash = createHash('md5')
                    .update(filename + name)
                    .digest('base64')
                    .replace(/[/+=]/g, '')
                    .slice(0, 6);

                return `${ file }__${ name }__${ hash }`;
            },
        },
    },
    build: {
        reportCompressedSize: false,
        target: 'esnext',
        outDir: resolve(desktopRoot, 'dist/renderer'),
        sourcemap: false,
        // Vite's CSS order is not import order, and the design system's layers depend on it.
        cssCodeSplit: false,
    },
    plugins: [
        pinCssLayerOrderPlugin(),
        babel({
            include: /\.(ts|tsx)$/,
            babelConfig: {
                babelrc: false,
                configFile: false,
                presets: [
                    ['@babel/preset-typescript', { onlyRemoveTypeImports: true, allowDeclareFields: true }],
                ],
                plugins: [
                    observingComponentsPlugin({ importPath: 'mobx-react-lite' }),
                    ['@babel/plugin-proposal-decorators', { version: '2023-05' }],
                ],
            },
        }),
        UnoCSS({
            configFile: require.resolve('@clowdy/styles/uno'),
            inspector: false,
        }),
        svgr(),
        react(),
    ],
    server: {
        host: '127.0.0.1',
        port: Number(process.env.CLOWDY_RENDERER_PORT ?? 5273),
        strictPort: true,
        open: false,
        // Workspace packages resolve through node_modules/@clowdy/* symlinks to their real paths under packages/,
        // which Vite serves and watches like the app's own files.
        fs: {
            allow: [desktopRoot, monorepoRoot],
        },
    },
});
