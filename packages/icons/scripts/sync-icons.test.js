import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getFigmaAuthHeaders } from './figma-auth.js';
import {
    createSyncPlan,
    discoverPacks,
    fingerprintNode,
    loadManifest,
    parseFigmaSourceUrl,
    parseIconName,
    syncIcons,
} from './sync-icons.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDir = path.resolve(packageDir, '../..');
const manifestPath = path.join(packageDir, 'src/figma-icons-manifest.json');
const originalAccessToken = process.env.FIGMA_ACCESS_TOKEN;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalSourceUrl = process.env.FIGMA_ICONS_SOURCE_URL;
const temporaryDirectories = [];

function restoreEnvironment(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

async function temporaryDirectory() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clowdy-icons-'));

    temporaryDirectories.push(directory);

    return directory;
}

function hash(content) {
    return createHash('sha256').update(content).digest('hex');
}

function readManifest() {
    return fs.readFile(manifestPath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    });
}

function icon({ fingerprint = 'fingerprint', hasInstances = false, name, nodeId }) {
    return { fingerprint, hasInstances, name, nodeId };
}

function pack(name, icons) {
    return { icons, name, nodeId: `pack-${name}` };
}

afterEach(async () => {
    restoreEnvironment('FIGMA_ACCESS_TOKEN', originalAccessToken);
    restoreEnvironment('FIGMA_ICONS_SOURCE_URL', originalSourceUrl);
    restoreEnvironment('XDG_CONFIG_HOME', originalConfigHome);
    vi.unstubAllGlobals();

    await Promise.all(
        temporaryDirectories.splice(0).map(directory =>
            fs.rm(directory, {
                force: true,
                recursive: true,
            })
        )
    );
});

describe('Figma icon sync contract', () => {
    it('uses the environment token for non-interactive runs', async () => {
        process.env.FIGMA_ACCESS_TOKEN = 'figd_test-token-for-ci';

        await expect(getFigmaAuthHeaders()).resolves.toEqual({
            'X-Figma-Token': 'figd_test-token-for-ci',
        });
    });

    it('returns AUTH_REQUIRED without requesting a secret in a non-interactive run', async () => {
        delete process.env.FIGMA_ACCESS_TOKEN;
        process.env.XDG_CONFIG_HOME = await temporaryDirectory();

        await expect(getFigmaAuthHeaders({ output: { isTTY: false, write: vi.fn() } })).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
            message: expect.stringContaining('Do not send the access token through chat'),
        });
    });

    it('does not clear a saved token when replacement cannot prompt', async () => {
        delete process.env.FIGMA_ACCESS_TOKEN;
        process.env.XDG_CONFIG_HOME = await temporaryDirectory();

        const tokenFile = path.join(process.env.XDG_CONFIG_HOME, 'reforma', 'figma-access-token');

        await fs.mkdir(path.dirname(tokenFile), { recursive: true });
        await fs.writeFile(tokenFile, 'figd_saved-token-for-testing\n');

        await expect(
            getFigmaAuthHeaders({ force: true, output: { isTTY: false, write: vi.fn() } })
        ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
        await expect(fs.readFile(tokenFile, 'utf8')).resolves.toBe('figd_saved-token-for-testing\n');
    });

    it('parses a node-specific Figma URL', () => {
        expect(parseFigmaSourceUrl('https://www.figma.com/design/file-key/icons?node-id=123-456')).toEqual({
            fileKey: 'file-key',
            nodeId: '123:456',
        });
    });

    it('extracts the name variant property', () => {
        expect(parseIconName('name=color')).toBe('color');
        expect(parseIconName('name=color.svg')).toBe('color');
        expect(parseIconName('name=google..svg')).toBe('google.');
        expect(parseIconName('size=14, name=arrow-left')).toBe('arrow-left');
    });

    it('rejects icon names that could escape the pack directory', () => {
        expect(() => parseIconName('name=../secret')).toThrow('unsafe icon name');
    });

    it('discovers direct auto-layout pack frames and ignores headings', () => {
        const { packs } = discoverPacks({
            children: [
                {
                    children: [
                        { id: 'heading', name: '14 px', type: 'TEXT' },
                        {
                            children: [
                                {
                                    children: [{ id: 'instance', type: 'INSTANCE' }],
                                    id: 'icon-1',
                                    name: 'name=color',
                                    type: 'COMPONENT',
                                },
                                { id: 'icon-2', name: 'name=arrow-left', type: 'COMPONENT' },
                            ],
                            id: 'set-1',
                            name: 'Icons',
                            type: 'COMPONENT_SET',
                        },
                    ],
                    id: 'pack-1',
                    layoutMode: 'VERTICAL',
                    name: '14',
                    type: 'FRAME',
                },
                { id: 'root-heading', name: 'Icons', type: 'TEXT' },
            ],
            layoutMode: 'VERTICAL',
            type: 'FRAME',
        });

        expect(packs).toHaveLength(1);
        expect(packs[0].name).toBe('14');
        expect(packs[0].icons.map(icon => icon.name)).toEqual(['color', 'arrow-left']);
        expect(packs[0].icons[0].hasInstances).toBe(true);
    });

    it('marks every icon in a pack excluded from optimization', () => {
        const { excludedPacks, packs } = discoverPacks(
            {
                children: [
                    {
                        children: [
                            {
                                children: [{ id: 'logo', name: 'name=logo', type: 'COMPONENT' }],
                                type: 'COMPONENT_SET',
                            },
                        ],
                        id: 'logo-pack',
                        layoutMode: 'VERTICAL',
                        name: 'logo 36.',
                        type: 'FRAME',
                    },
                    {
                        children: [
                            {
                                children: [{ id: 'icon', name: 'name=color', type: 'COMPONENT' }],
                                type: 'COMPONENT_SET',
                            },
                        ],
                        id: 'pack-14',
                        layoutMode: 'VERTICAL',
                        name: '14',
                        type: 'FRAME',
                    },
                ],
                layoutMode: 'VERTICAL',
                type: 'FRAME',
            },
            '.'
        );

        expect(excludedPacks).toEqual(new Set());
        expect(packs.map(pack => [pack.name, pack.excludesOptimization])).toEqual([
            ['logo 36', true],
            ['14', false],
        ]);
    });

    it('ignores pack frames marked with the sync exclusion suffix', () => {
        const { excludedPacks, packs } = discoverPacks(
            {
                children: [
                    {
                        id: 'ignored-pack',
                        layoutMode: 'VERTICAL',
                        name: 'private.~',
                        type: 'FRAME',
                    },
                    {
                        children: [
                            {
                                children: [{ id: 'icon', name: 'name=color', type: 'COMPONENT' }],
                                type: 'COMPONENT_SET',
                            },
                        ],
                        id: 'pack-14',
                        layoutMode: 'VERTICAL',
                        name: '14',
                        type: 'FRAME',
                    },
                ],
                layoutMode: 'VERTICAL',
                type: 'FRAME',
            },
            '.',
            '~'
        );

        expect(excludedPacks).toEqual(new Set(['private']));
        expect(packs.map(pack => pack.name)).toEqual(['14']);
    });

    it('ignores packs named in the exclusion list, with or without the optimization suffix', () => {
        const pack = (id, name) => ({
            children: [
                {
                    children: [{ id: `${id}-icon`, name: 'name=color', type: 'COMPONENT' }],
                    type: 'COMPONENT_SET',
                },
            ],
            id,
            layoutMode: 'VERTICAL',
            name,
            type: 'FRAME',
        });
        const { excludedPacks, packs } = discoverPacks(
            {
                children: [pack('logo-pack', 'logo.'), pack('brand-pack', 'brand'), pack('pack-14', '14')],
                layoutMode: 'VERTICAL',
                type: 'FRAME',
            },
            '.',
            '~',
            ['logo', 'brand']
        );

        expect(excludedPacks).toEqual(new Set(['logo', 'brand']));
        expect(packs.map(item => item.name)).toEqual(['14']);
    });

    it('rejects duplicate icon names inside a pack', () => {
        expect(() =>
            discoverPacks({
                children: [
                    {
                        children: [
                            {
                                children: [
                                    { id: 'icon-1', name: 'name=color', type: 'COMPONENT' },
                                    { id: 'icon-2', name: 'name=color.svg', type: 'COMPONENT' },
                                ],
                                type: 'COMPONENT_SET',
                            },
                        ],
                        id: 'pack-1',
                        layoutMode: 'VERTICAL',
                        name: '14',
                        type: 'FRAME',
                    },
                ],
                layoutMode: 'VERTICAL',
                type: 'FRAME',
            })
        ).toThrow('duplicate icon name');
    });

    it('fingerprints node content independently of JSON key order', () => {
        expect(fingerprintNode({ fills: ['red'], name: 'name=color' })).toBe(
            fingerprintNode({ name: 'name=color', fills: ['red'] })
        );
        expect(fingerprintNode({ fills: ['red'] })).not.toBe(fingerprintNode({ fills: ['blue'] }));
    });

    it('does not re-export an icon only because its pack position changed', () => {
        const icon = {
            absoluteBoundingBox: { height: 16, width: 16, x: 10, y: 20 },
            children: [
                {
                    absoluteTransform: [
                        [1, 0, 10],
                        [0, 1, 20],
                    ],
                    fills: ['red'],
                },
            ],
            relativeTransform: [
                [1, 0, 10],
                [0, 1, 20],
            ],
            size: { x: 16, y: 16 },
        };
        const movedIcon = {
            ...icon,
            absoluteBoundingBox: { height: 16, width: 16, x: 100, y: 200 },
            children: [
                {
                    absoluteTransform: [
                        [1, 0, 100],
                        [0, 1, 200],
                    ],
                    fills: ['red'],
                },
            ],
            relativeTransform: [
                [1, 0, 100],
                [0, 1, 200],
            ],
        };

        expect(fingerprintNode(icon)).toBe(fingerprintNode(movedIcon));
    });

    it('requires the selected root to be an auto-layout frame', () => {
        expect(() => discoverPacks({ children: [], layoutMode: 'NONE', type: 'FRAME' })).toThrow('auto-layout FRAME');
    });

    it('keeps deletion scoped to selected packs and manifest-managed files', async () => {
        const sourceDirectory = await temporaryDirectory();
        const currentSvg = '<svg>current</svg>';
        const previousManifest = {
            fileKey: 'file',
            packs: {
                14: {
                    icons: {
                        current: {
                            file: 'current.svg',
                            fingerprint: 'same',
                            name: 'current',
                            sourceHash: hash(currentSvg),
                        },
                        removed: {
                            file: 'removed.svg',
                            fingerprint: 'old',
                            name: 'removed',
                            sourceHash: hash('removed'),
                        },
                    },
                    nodeId: 'pack-14',
                },
                retired: {
                    icons: {
                        retired: {
                            file: 'retired.svg',
                            fingerprint: 'old',
                            name: 'retired',
                            sourceHash: hash('retired'),
                        },
                    },
                    nodeId: 'pack-retired',
                },
            },
            rootNodeId: 'root',
            version: 1,
        };
        const discoveredPacks = [
            pack('14', [
                icon({
                    fingerprint: 'same',
                    name: 'current',
                    nodeId: 'current',
                }),
            ]),
        ];

        await fs.mkdir(path.join(sourceDirectory, '14'), { recursive: true });
        await fs.writeFile(path.join(sourceDirectory, '14/current.svg'), currentSvg);
        await fs.writeFile(path.join(sourceDirectory, '14/removed.svg'), 'removed');
        await fs.writeFile(path.join(sourceDirectory, '14/unmanaged.svg'), 'unmanaged');

        const partial = await createSyncPlan({
            discoveredPacks,
            previousManifest,
            requestedPacks: ['14'],
            sourceDirectory,
        });

        expect(partial.removals).toEqual([path.join(sourceDirectory, '14/removed.svg')]);
        expect(partial.manifest.packs.retired).toBeDefined();
        expect(partial.removals).not.toContain(path.join(sourceDirectory, '14/unmanaged.svg'));

        const full = await createSyncPlan({
            discoveredPacks,
            previousManifest,
            requestedPacks: [],
            sourceDirectory,
        });

        expect(full.removals).toEqual(
            expect.arrayContaining([
                path.join(sourceDirectory, '14/removed.svg'),
                path.join(sourceDirectory, 'retired/retired.svg'),
            ])
        );
        expect(full.manifest.packs.retired).toBeUndefined();
        expect(full.removals).not.toContain(path.join(sourceDirectory, '14/unmanaged.svg'));
    });

    it('preserves previously managed packs excluded in Figma', async () => {
        const sourceDirectory = await temporaryDirectory();
        const previousManifest = {
            packs: {
                skip: {
                    icons: {
                        ignored: { file: 'ignored.svg', name: 'ignored' },
                    },
                    nodeId: 'pack-skip',
                },
            },
        };
        const plan = await createSyncPlan({
            discoveredPacks: [],
            excludedPacks: new Set(['skip']),
            previousManifest,
            requestedPacks: [],
            sourceDirectory,
        });

        expect(plan.manifest.packs.skip).toEqual(previousManifest.packs.skip);
        expect(plan.removals).toEqual([]);
    });

    it('marks files from optimization-excluded packs and restores them when unmarked', async () => {
        const sourceDirectory = await temporaryDirectory();
        const previousManifest = {
            packs: {
                logo: {
                    excludesOptimization: true,
                    icons: {
                        logo: { file: 'logo..svg', name: 'logo' },
                    },
                    nodeId: 'pack-logo',
                },
            },
        };

        await fs.mkdir(path.join(sourceDirectory, 'logo'), { recursive: true });
        await fs.writeFile(path.join(sourceDirectory, 'logo/logo..svg'), '<svg />');

        const excluded = await createSyncPlan({
            discoveredPacks: [
                { ...pack('logo', [icon({ name: 'logo', nodeId: 'logo' })]), excludesOptimization: true },
            ],
            exclusionSuffix: '.',
            previousManifest: { packs: {} },
            requestedPacks: [],
            sourceDirectory,
        });
        const restored = await createSyncPlan({
            discoveredPacks: [pack('logo', [icon({ name: 'logo', nodeId: 'logo' })])],
            exclusionSuffix: '.',
            previousManifest,
            requestedPacks: [],
            sourceDirectory,
        });

        expect(excluded.manifest.packs.logo).toMatchObject({
            excludesOptimization: true,
            icons: { logo: { file: 'logo..svg' } },
        });
        expect(restored.manifest.packs.logo.icons.logo.file).toBe('logo.svg');
        expect(restored.manifest.packs.logo).not.toHaveProperty('excludesOptimization');
        expect(restored.removals).toEqual([path.join(sourceDirectory, 'logo/logo..svg')]);
    });

    it('re-exports locally divergent icons and icons containing instances', async () => {
        const sourceDirectory = await temporaryDirectory();
        const figmaSvg = '<svg>figma</svg>';
        const previousManifest = {
            fileKey: 'file',
            packs: {
                14: {
                    icons: {
                        divergent: {
                            file: 'divergent.svg',
                            fingerprint: 'same',
                            name: 'divergent',
                            sourceHash: hash(figmaSvg),
                        },
                        instance: {
                            file: 'instance.svg',
                            fingerprint: 'same',
                            name: 'instance',
                            sourceHash: hash(figmaSvg),
                        },
                    },
                    nodeId: 'pack-14',
                },
            },
            rootNodeId: 'root',
            version: 1,
        };

        await fs.mkdir(path.join(sourceDirectory, '14'), { recursive: true });
        await fs.writeFile(path.join(sourceDirectory, '14/divergent.svg'), '<svg>local edit</svg>');
        await fs.writeFile(path.join(sourceDirectory, '14/instance.svg'), figmaSvg);

        const plan = await createSyncPlan({
            discoveredPacks: [
                pack('14', [
                    icon({ fingerprint: 'same', name: 'divergent', nodeId: 'divergent' }),
                    icon({ fingerprint: 'same', hasInstances: true, name: 'instance', nodeId: 'instance' }),
                    icon({ name: 'new', nodeId: 'new' }),
                ]),
            ],
            previousManifest,
            requestedPacks: ['14'],
            sourceDirectory,
        });

        expect(plan.exports.map(item => [item.nodeId, item.added])).toEqual([
            ['divergent', false],
            ['instance', false],
            ['new', true],
        ]);
    });

    it('returns PACK_NOT_FOUND with current exact pack names', async () => {
        await expect(
            createSyncPlan({
                discoveredPacks: [pack('14', [icon({ name: 'color', nodeId: 'color' })])],
                previousManifest: { packs: {} },
                requestedPacks: ['14-pixel'],
            })
        ).rejects.toMatchObject({
            code: 'PACK_NOT_FOUND',
            details: { availablePacks: ['14'] },
        });
    });

    it('rejects a manifest belonging to another Figma source', async () => {
        const directory = await temporaryDirectory();
        const fixturePath = path.join(directory, 'manifest.json');

        await fs.writeFile(
            fixturePath,
            JSON.stringify({
                fileKey: 'other-file',
                packs: {},
                rootNodeId: 'other-root',
                version: 1,
            })
        );

        await expect(loadManifest('file', 'root', fixturePath)).rejects.toMatchObject({
            code: 'MANIFEST_SOURCE_MISMATCH',
        });
    });

    it('lists validated packs without exporting or changing the manifest', async () => {
        const manifestBefore = await readManifest();

        process.env.FIGMA_ACCESS_TOKEN = 'figd_test-token-for-ci';
        process.env.FIGMA_ICONS_SOURCE_URL = 'https://www.figma.com/design/file/icons?node-id=1-2';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                json: async () => ({
                    nodes: {
                        '1:2': {
                            document: {
                                children: [
                                    {
                                        children: [
                                            {
                                                children: [{ id: 'icon', name: 'name=color', type: 'COMPONENT' }],
                                                type: 'COMPONENT_SET',
                                            },
                                        ],
                                        id: 'pack-14',
                                        layoutMode: 'VERTICAL',
                                        name: '14',
                                        type: 'FRAME',
                                    },
                                ],
                                layoutMode: 'VERTICAL',
                                type: 'FRAME',
                            },
                        },
                    },
                }),
                ok: true,
            })
        );

        await expect(syncIcons([], { json: true, list: true })).resolves.toEqual({
            operation: 'list',
            packs: [{ iconCount: 1, name: '14', nodeId: 'pack-14' }],
            resource: 'icons',
            schemaVersion: 1,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        await expect(readManifest()).resolves.toBe(manifestBefore);
    });

    it('validates authorization without discovering packs or changing the manifest', async () => {
        const manifestBefore = await readManifest();

        process.env.FIGMA_ACCESS_TOKEN = 'figd_test-token-for-ci';
        process.env.FIGMA_ICONS_SOURCE_URL = 'https://www.figma.com/design/file/icons?node-id=1-2';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                json: async () => ({
                    nodes: {
                        '1:2': { document: { type: 'RECTANGLE' } },
                    },
                }),
                ok: true,
            })
        );

        await expect(syncIcons([], { authorize: true, json: true })).resolves.toEqual({
            authorized: true,
            operation: 'auth',
            resource: 'icons',
            schemaVersion: 1,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        await expect(readManifest()).resolves.toBe(manifestBefore);
    });

    it('forwards the auth command and returns one JSON auth error on stdout', async () => {
        const configHome = await temporaryDirectory();
        const environment = {
            ...process.env,
            XDG_CONFIG_HOME: configHome,
        };

        delete environment.FIGMA_ACCESS_TOKEN;

        const help = spawnSync(path.join(repositoryDir, 'clowdy'), ['sync', 'icons', '--help'], {
            cwd: repositoryDir,
            encoding: 'utf8',
            env: environment,
        });
        const result = spawnSync(path.join(repositoryDir, 'clowdy'), ['sync', 'icons', 'auth', '--json'], {
            cwd: repositoryDir,
            encoding: 'utf8',
            env: environment,
        });
        const removedOption = spawnSync(
            path.join(repositoryDir, 'clowdy'),
            ['sync', 'icons', '--reauthorize', '--json'],
            { cwd: repositoryDir, encoding: 'utf8', env: environment }
        );

        expect(help.status).toBe(0);
        expect(help.stdout).toContain('Usage: ./clowdy sync icons');
        expect(help.stdout).toContain('auth           Replace and verify');
        expect(help.stdout).not.toContain('--reauthorize');
        expect(result.status).toBe(1);
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            error: { code: 'AUTH_REQUIRED' },
            resource: 'icons',
            schemaVersion: 1,
        });
        expect(JSON.parse(removedOption.stdout)).toMatchObject({
            error: { code: 'INVALID_ARGUMENT' },
        });
    });
});
