import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CSS_LAYER_ORDER = '@layer reset, rulesets, tokens, base, components, utilities;';

export function pinCssLayerOrder(css: string): string {
    const start = css.trimStart();

    if (start.startsWith('@layer reset,')) {
        return css;
    }

    const charset = css.match(/^(\s*@charset\s+[^;]+;\s*)/i);

    if (charset) {
        return `${charset[1]}${CSS_LAYER_ORDER}\n${css.slice(charset[0].length)}`;
    }

    return `${CSS_LAYER_ORDER}\n${css}`;
}

/** Vite prod CSS order is not import order (https://github.com/vitejs/vite/discussions/23087). `cssCodeSplit: false` still emits `@layer components` first. */
export function pinCssLayerOrderPlugin() {
    return {
        name: 'pin-css-layer-order',
        transformIndexHtml: {
            order: 'pre' as const,
            handler() {
                return [
                    {
                        tag: 'style',
                        children: CSS_LAYER_ORDER,
                        injectTo: 'head-prepend' as const,
                    },
                ];
            },
        },
        writeBundle(options: { dir?: string }, bundle: Record<string, { type: string; fileName: string }>) {
            const dir = options.dir;

            if (!dir) {
                return;
            }

            for (const item of Object.values(bundle)) {
                if (item.type !== 'asset' || !item.fileName.endsWith('.css')) {
                    continue;
                }

                const file = join(dir, item.fileName);
                const css = readFileSync(file, 'utf8');

                if (!css.includes('@layer components')) {
                    continue;
                }

                const next = pinCssLayerOrder(css);

                if (next !== css) {
                    writeFileSync(file, next);
                }
            }
        },
    };
}
