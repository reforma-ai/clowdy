import { transform } from '@svgr/core';
import { transform as esbuildTransform } from 'esbuild';
import { promises as fs } from 'fs';
import { minimatch } from 'minimatch';
import path from 'path';
import { optimize } from 'svgo';
import { fileURLToPath } from 'url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const rawDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');
const packageJsonPath = path.join(rootDir, 'package.json');

const svgoConfig = {
    multipass: true,
    plugins: [
        {
            name: 'preset-default',
            params: {
                overrides: {
                    // Only override plugins that are actually in preset-default
                    removeViewBox: false, // Keep viewBox for flexibility
                },
            },
        },
        {
            name: 'removeAttrs',
            params: {
                attrs: ['svg:width', 'svg:height', 'fill', 'clip-path'],
            },
        },
        'removeDimensions', // Remove width/height attributes (not in preset-default)
        'removeScriptElement', // Remove script elements (not in preset-default)
        'removeStyleElement', // Remove style elements (not in preset-default)
        'removeXMLNS', // Remove xmlns attribute (not in preset-default)
    ],
};

async function loadIconsMetadata() {
    const metadataPath = path.join(rawDir, 'icons-metadata.json');

    try {
        const content = await fs.readFile(metadataPath, 'utf8');

        return JSON.parse(content);
    } catch {
        // If metadata file doesn't exist, return empty structure
        return { packs: {}, icons: {} };
    }
}

async function getSvgrConfig(iconContext) {
    const svgrTemplateModule = await import('./svgr-template.js');
    const svgrTemplate = svgrTemplateModule.default;

    // Only use JSX plugin - SVGO optimization is done manually before passing to SVGR
    // This avoids double optimization and gives us full control over SVGO config
    const plugins = ['@svgr/plugin-jsx'];

    return {
        typescript: true,
        icon: true,
        dimensions: false,
        expandProps: 'end',
        plugins,
        svgoConfig: {}, // No SVGO config needed since we optimize manually
        template: (variables, options) => svgrTemplate(variables, options, iconContext),
    };
}

function pascalCase(value) {
    return value
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

/** Extract dimensions from SVG: width/height attributes first, then viewBox. Returns { viewBox, width, height }. */
function extractDimensions(svgString) {
    const attrNum = name => {
        const m = svgString.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));

        if (!m) {
            return null;
        }

        const n = Number(m[1]);

        return Number.isNaN(n) ? null : n;
    };

    const viewBoxMatch = svgString.match(/viewBox\s*=\s*["']([^"']+)["']/i);
    const viewBox = viewBoxMatch ? viewBoxMatch[1].trim() : '0 0 16 16';
    const vbParts = viewBox.split(/\s+/).map(Number);
    const vbWidth = vbParts[2] ?? 16;
    const vbHeight = vbParts[3] ?? 16;

    const width = attrNum('width') ?? vbWidth;
    const height = attrNum('height') ?? vbHeight;

    return { viewBox, width, height };
}

async function getPacks() {
    const entries = await fs.readdir(rawDir, { withFileTypes: true });

    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
}

async function existingPackComponents(packDistDir) {
    try {
        const files = await fs.readdir(packDistDir);

        return files.filter(file => file.endsWith('.js') && file !== 'index.js').map(file => file.slice(0, -3));
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

async function buildPack(pack, metadata) {
    const packRawDir = path.join(rawDir, pack);
    const packDistDir = path.join(distDir, pack);

    await fs.mkdir(packDistDir, { recursive: true });

    const files = await fs.readdir(packRawDir);
    const svgFiles = files.filter(file => file.endsWith('.svg')).sort();

    const icons = [];
    const seenComponentNames = new Set();
    const packDefaultSize = metadata.packs?.[pack]?.defaultSize ?? parseInt(pack, 10);
    const excludePatterns = metadata.packs?.[pack]?.excludeFromOptimization ?? [];
    const exclusionSuffix = metadata.optimization?.excludeFromOptimizationSuffix;

    const matchesExclude = iconName => {
        return excludePatterns.some(pattern => minimatch(iconName, pattern));
    };

    for (const file of svgFiles) {
        const sourceIconName = file.replace(/\.svg$/, '');
        const hasOptimizationExclusionSuffix = Boolean(exclusionSuffix && sourceIconName.endsWith(exclusionSuffix));
        const iconName = hasOptimizationExclusionSuffix
            ? sourceIconName.slice(0, -exclusionSuffix.length)
            : sourceIconName;
        const componentName = pascalCase(iconName);

        if (seenComponentNames.has(componentName)) {
            continue;
        }

        seenComponentNames.add(componentName);
        const svgPath = path.join(packRawDir, file);

        const shouldExcludeIcon = hasOptimizationExclusionSuffix || matchesExclude(iconName);
        const rawSvg = await fs.readFile(svgPath, 'utf8');
        const { width: vbWidth, height: vbHeight } = extractDimensions(rawSvg);
        const effectiveSize = Number.isNaN(packDefaultSize) ? null : packDefaultSize;
        const iconContext = {
            defaultWidth: metadata.icons?.[componentName]?.defaultWidth ?? effectiveSize ?? vbWidth,
            defaultHeight: metadata.icons?.[componentName]?.defaultHeight ?? effectiveSize ?? vbHeight,
        };
        const svgrConfig = await getSvgrConfig(iconContext);

        const svgToTransform = shouldExcludeIcon
            ? rawSvg
            : optimize(rawSvg, {
                  path: svgPath,
                  ...svgoConfig,
              }).data;

        // Transform to React component
        let componentCode = await transform(svgToTransform, svgrConfig, {
            componentName,
        });

        // Minify the generated code
        const minifiedResult = await esbuildTransform(componentCode, {
            loader: 'tsx',
            minify: true,
            format: 'esm',
            target: 'esnext',
        });

        componentCode = minifiedResult.code;

        // Write component file (as .js since esbuild transforms TSX to JS)
        const componentPath = path.join(packDistDir, `${componentName}.js`);

        await fs.writeFile(componentPath, componentCode, 'utf8');

        const declContent = `import type { IconProps } from '../IconBase.js';\nexport declare const ${componentName}: (props: IconProps) => import('react').ReactElement;\n`;

        await fs.writeFile(path.join(packDistDir, `${componentName}.d.ts`), declContent, 'utf8');

        icons.push({ componentName, iconName });
    }

    for (const componentName of await existingPackComponents(packDistDir)) {
        if (seenComponentNames.has(componentName)) {
            continue;
        }

        seenComponentNames.add(componentName);
        icons.push({ componentName, iconName: componentName });
    }

    // Pack barrel: JS + d.ts (icons themselves are already .js)
    const uniqueExports = [...new Map(icons.map(i => [i.componentName, i])).values()];
    const indexLines = uniqueExports.map(
        ({ componentName }) => `export { ${componentName} } from './${componentName}.js';`
    );
    const indexContent = `/* AUTO-GENERATED FILE. DO NOT EDIT. */\n${indexLines.join('\n')}\n`;

    await fs.writeFile(path.join(packDistDir, 'index.js'), indexContent, 'utf8');
    await fs.writeFile(path.join(packDistDir, 'index.d.ts'), indexContent, 'utf8');
    await fs.rm(path.join(packDistDir, 'index.ts'), { force: true });

    return icons;
}

function getPackLabel(pack) {
    if (/^\d+$/.test(pack)) {
        return `${pack}px`;
    }

    return pack.charAt(0).toUpperCase() + pack.slice(1);
}

async function writeRegistry(allExports) {
    const lines = [
        '/* AUTO-GENERATED FILE. DO NOT EDIT. */',
        '',
        ...allExports.map(({ pack }) => {
            const safeVar = `p${pack.replace(/\W/g, '_')}`;

            return `import * as ${safeVar} from './${pack}/index.js';`;
        }),
        '',
        'export const ICON_PACKS = {',
        ...allExports.map(({ pack }) => {
            const safeVar = `p${pack.replace(/\W/g, '_')}`;

            return `    '${pack}': ${safeVar},`;
        }),
        '};',
        '',
        'export const PACK_LABELS = {',
        ...allExports.map(({ pack }) => `    '${pack}': '${getPackLabel(pack)}',`),
        '};',
        '',
    ];
    const source = lines.join('\n');

    await fs.writeFile(path.join(distDir, 'registry.js'), source, 'utf8');
    await fs.writeFile(path.join(distDir, 'registry.d.ts'), source, 'utf8');
    await fs.rm(path.join(distDir, 'registry.ts'), { force: true });
}

async function writeIconBase() {
    const iconBaseSrc = path.join(rootDir, 'src', 'IconBase.tsx');
    const source = await fs.readFile(iconBaseSrc, 'utf8');
    const minified = await esbuildTransform(source, {
        loader: 'tsx',
        minify: true,
        format: 'esm',
        target: 'esnext',
    });

    await fs.writeFile(path.join(distDir, 'IconBase.js'), minified.code, 'utf8');
    await fs.writeFile(
        path.join(distDir, 'IconBase.d.ts'),
        `import type * as React from 'react';

export type IconProps = React.SVGProps<SVGSVGElement> & {
    title?: string;
    size?: string | number;
    width?: string | number;
    height?: string | number;
};

export type IconWrapperProps = IconProps & {
    children: React.ReactElement;
};

export declare function IconWrapper(props: IconWrapperProps): React.ReactElement;
`,
        'utf8'
    );
    await fs.rm(path.join(distDir, 'IconBase.tsx'), { force: true });
}

async function updatePackageJson(allExports) {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    // Build exports object
    const exports = {
        // Main entry (all icons)
        '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
            styles: './dist/styles.css',
            default: './dist/index.js',
        },
        // Styles
        './styles.css': './dist/styles.css',
        './css': './dist/styles.css',
    };

    // Add pack exports (barrel files)
    // Modern bundlers (Vite, Rollup, Webpack 5) can tree-shake barrel files with named exports
    for (const { pack } of allExports) {
        exports[`./${pack}`] = {
            types: `./dist/${pack}/index.d.ts`,
            import: `./dist/${pack}/index.js`,
            default: `./dist/${pack}/index.js`,
        };
    }

    exports['./registry'] = {
        types: './dist/registry.d.ts',
        import: './dist/registry.js',
        default: './dist/registry.js',
    };

    packageJson.exports = exports;

    await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 4)}\n`, 'utf8');
}

async function build() {
    await fs.mkdir(distDir, { recursive: true });

    await writeIconBase();

    // Load icons metadata
    const metadata = await loadIconsMetadata();

    const packs = await getPacks();
    const allExports = [];

    // Build each pack
    for (const pack of packs) {
        const icons = await buildPack(pack, metadata);

        allExports.push({ pack, icons });
    }

    const mainIndexJs = `/* AUTO-GENERATED FILE. DO NOT EDIT. */
export { IconWrapper } from './IconBase.js';
${allExports.map(({ pack }) => `export * from './${pack}/index.js';`).join('\n')}
`;
    const mainIndexDts = `/* AUTO-GENERATED FILE. DO NOT EDIT. */
export { IconWrapper, type IconProps, type IconWrapperProps } from './IconBase.js';
${allExports.map(({ pack }) => `export * from './${pack}/index.js';`).join('\n')}
`;

    await fs.writeFile(path.join(distDir, 'index.js'), mainIndexJs, 'utf8');
    await fs.writeFile(path.join(distDir, 'index.d.ts'), mainIndexDts, 'utf8');
    await fs.rm(path.join(distDir, 'index.ts'), { force: true });

    // Copy styles.css
    const stylesPath = path.join(rootDir, 'src', 'styles.css');

    try {
        await fs.copyFile(stylesPath, path.join(distDir, 'styles.css'));
    } catch {
        // Styles might not exist, that's okay
    }

    // Generate registry for consumers (e.g. Storybook) to discover all packs without hardcoding
    await writeRegistry(allExports);

    // Update package.json with generated exports
    await updatePackageJson(allExports);

    const totalIcons = allExports.reduce((sum, { icons }) => sum + icons.length, 0);

    // eslint-disable-next-line no-console
    console.log(`✅ Built ${packs.length} packs with ${totalIcons} icons`);
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
