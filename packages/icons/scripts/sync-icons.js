import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getFigmaAuthHeaders } from './figma-auth.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(packageDir, 'src');
const metadataPath = path.join(sourceDir, 'icons-metadata.json');
const manifestPath = path.join(sourceDir, 'figma-icons-manifest.json');
const figmaApiUrl = 'https://api.figma.com/v1';
const exportBatchSize = 100;
const downloadBatchSize = 16;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ignoredAbsoluteGeometry = new Set(['absoluteBoundingBox', 'absoluteRenderBounds', 'absoluteTransform']);

export class IconSyncError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'IconSyncError';
        this.status = details.status;
    }
}

function createStatus(output) {
    const interactive = Boolean(output.isTTY);
    let frame = 0;
    let message = '';
    let timer;

    const render = () => {
        output.write(`\r\x1b[2K${spinnerFrames[frame++ % spinnerFrames.length]} ${message}`);
    };
    const stop = () => {
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }

        if (interactive) {
            output.write('\r\x1b[2K');
        }
    };

    return {
        done(nextMessage) {
            stop();
            output.write(`✓ ${nextMessage}\n`);
        },
        stop,
        update(nextMessage) {
            message = nextMessage;

            if (!interactive) {
                output.write(`${message}\n`);

                return;
            }

            if (!timer) {
                render();
                timer = setInterval(render, 80);
                timer.unref();
            }
        },
    };
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function stableValue(value, isRoot = false) {
    if (Array.isArray(value)) {
        return value.map(child => stableValue(child));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !ignoredAbsoluteGeometry.has(key) && (!isRoot || key !== 'relativeTransform'))
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, stableValue(child)])
        );
    }

    return value;
}

export function fingerprintNode(node) {
    return hash(JSON.stringify(stableValue(node, true)));
}

function containsInstance(node) {
    return node.type === 'INSTANCE' || (node.children ?? []).some(containsInstance);
}

export function parseFigmaSourceUrl(sourceUrl) {
    let url;

    try {
        url = new URL(sourceUrl);
    } catch {
        throw new IconSyncError('INVALID_CONFIG', 'Figma source must be a valid node URL.');
    }

    const match = url.pathname.match(/^\/(?:design|file)\/([^/]+)/);
    const urlNodeId = url.searchParams.get('node-id');

    if (!match || !urlNodeId) {
        throw new IconSyncError(
            'INVALID_CONFIG',
            'Figma source URL must point to the root icons frame and contain node-id.'
        );
    }

    return {
        fileKey: match[1],
        nodeId: urlNodeId.includes(':') ? urlNodeId : urlNodeId.replaceAll('-', ':'),
    };
}

export function parseIconName(variantName) {
    const properties = variantName.split(',').map(property => property.trim());
    const nameProperties = properties.filter(property => property.startsWith('name='));

    if (nameProperties.length !== 1) {
        throw new IconSyncError(
            'INVALID_FIGMA_STRUCTURE',
            `Variant "${variantName}" must contain exactly one name=<icon> property.`
        );
    }

    const value = nameProperties[0]
        .slice('name='.length)
        .trim()
        .replace(/\.svg$/i, '');
    const hasControlCharacter = [...value].some(character => {
        const codePoint = character.codePointAt(0);

        return codePoint < 32 || codePoint === 127;
    });

    if (!value || value === '.' || value === '..' || /[<>:"/\\|?*]/.test(value) || hasControlCharacter) {
        throw new IconSyncError('INVALID_FIGMA_STRUCTURE', `Variant "${variantName}" has an unsafe icon name.`);
    }

    return value;
}

function assertPackName(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(name) || /[.]$/.test(name)) {
        throw new IconSyncError('INVALID_FIGMA_STRUCTURE', `Pack frame "${name}" is not a safe directory name.`);
    }
}

export function discoverPacks(rootNode, optimizationExclusionSuffix, syncExclusionSuffix, excludedPackNames = []) {
    if (rootNode.type !== 'FRAME' || !rootNode.layoutMode || rootNode.layoutMode === 'NONE') {
        throw new IconSyncError('INVALID_FIGMA_STRUCTURE', 'The root icons node must be an auto-layout FRAME.');
    }

    const excludedPacks = new Set();
    const packFrames = (rootNode.children ?? [])
        .filter(child => child.type === 'FRAME' && child.layoutMode && child.layoutMode !== 'NONE')
        .filter(frame => {
            const name = frame.name.trim();

            if (syncExclusionSuffix && name.endsWith(syncExclusionSuffix)) {
                const packName = name.slice(0, -syncExclusionSuffix.length);
                const hasOptimizationSuffix = Boolean(
                    optimizationExclusionSuffix && packName.endsWith(optimizationExclusionSuffix)
                );
                const normalizedName = hasOptimizationSuffix
                    ? packName.slice(0, -optimizationExclusionSuffix.length)
                    : packName;

                excludedPacks.add(normalizedName);

                return false;
            }

            const packName =
                optimizationExclusionSuffix && name.endsWith(optimizationExclusionSuffix)
                    ? name.slice(0, -optimizationExclusionSuffix.length)
                    : name;

            if (excludedPackNames.includes(packName)) {
                excludedPacks.add(packName);

                return false;
            }

            return true;
        });
    const names = new Set();

    if (packFrames.length === 0) {
        throw new IconSyncError(
            'INVALID_FIGMA_STRUCTURE',
            'The root icons frame does not contain any direct auto-layout pack frames.'
        );
    }

    const packs = packFrames.map(frame => {
        const sourceName = frame.name.trim();
        const excludesOptimization = Boolean(
            optimizationExclusionSuffix && sourceName.endsWith(optimizationExclusionSuffix)
        );
        const name = excludesOptimization ? sourceName.slice(0, -optimizationExclusionSuffix.length) : sourceName;

        assertPackName(name);

        if (names.has(name)) {
            throw new IconSyncError(
                'INVALID_FIGMA_STRUCTURE',
                `Root frame contains more than one pack named "${name}".`
            );
        }

        names.add(name);

        const componentSets = (frame.children ?? []).filter(child => child.type === 'COMPONENT_SET');

        if (componentSets.length !== 1) {
            throw new IconSyncError(
                'INVALID_FIGMA_STRUCTURE',
                `Pack "${name}" must contain exactly one direct COMPONENT_SET; found ${componentSets.length}.`
            );
        }

        const icons = (componentSets[0].children ?? [])
            .filter(child => child.type === 'COMPONENT')
            .map(node => ({
                fingerprint: fingerprintNode(node),
                hasInstances: containsInstance(node),
                name: parseIconName(node.name),
                nodeId: node.id,
            }));
        const iconNames = new Set();

        if (icons.length === 0) {
            throw new IconSyncError('INVALID_FIGMA_STRUCTURE', `Pack "${name}" does not contain any icon components.`);
        }

        for (const icon of icons) {
            if (iconNames.has(icon.name)) {
                throw new IconSyncError(
                    'INVALID_FIGMA_STRUCTURE',
                    `Pack "${name}" contains duplicate icon name "${icon.name}".`
                );
            }

            iconNames.add(icon.name);
        }

        return {
            excludesOptimization,
            icons,
            name,
            nodeId: frame.id,
        };
    });

    return { excludedPacks, packs };
}

async function readJson(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return fallback;
        }

        throw error;
    }
}

async function writeFileAtomic(filePath, content) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;

    try {
        await fs.writeFile(temporaryPath, content, 'utf8');
        await fs.rename(temporaryPath, filePath);
    } finally {
        await fs.rm(temporaryPath, { force: true });
    }
}

async function figmaJson(pathname, authHeaders) {
    let response;

    try {
        response = await fetch(`${figmaApiUrl}${pathname}`, {
            headers: authHeaders,
        });
    } catch (error) {
        throw new IconSyncError('FIGMA_REQUEST_FAILED', `Figma request failed: ${error.message}`);
    }

    if (!response.ok) {
        const details = await response.text();

        throw new IconSyncError(
            'FIGMA_REQUEST_FAILED',
            `Figma API ${response.status}: ${details || response.statusText}`,
            { status: response.status }
        );
    }

    return response.json();
}

async function getRootNode(fileKey, nodeId, authHeaders) {
    const query = new URLSearchParams({
        geometry: 'paths',
        ids: nodeId,
    });
    const response = await figmaJson(`/files/${encodeURIComponent(fileKey)}/nodes?${query}`, authHeaders);
    const rootNode = response.nodes?.[nodeId]?.document;

    if (!rootNode) {
        throw new IconSyncError(
            'INVALID_FIGMA_STRUCTURE',
            `Figma root node "${nodeId}" was not found or is not accessible.`
        );
    }

    return rootNode;
}

async function getExportUrls(fileKey, nodeIds, authHeaders, onProgress) {
    const urls = new Map();

    for (let index = 0; index < nodeIds.length; index += exportBatchSize) {
        const batch = nodeIds.slice(index, index + exportBatchSize);
        const query = new URLSearchParams({
            format: 'svg',
            ids: batch.join(','),
            svg_include_id: 'false',
        });
        const response = await figmaJson(`/images/${encodeURIComponent(fileKey)}?${query}`, authHeaders);

        for (const nodeId of batch) {
            const url = response.images?.[nodeId];

            if (!url) {
                throw new IconSyncError(
                    'FIGMA_REQUEST_FAILED',
                    `Figma did not return an SVG export URL for node "${nodeId}".`
                );
            }

            urls.set(nodeId, url);
        }

        onProgress?.(Math.min(index + batch.length, nodeIds.length), nodeIds.length);
    }

    return urls;
}

async function downloadSvgs(exportUrls, onProgress) {
    const result = new Map();
    const entries = [...exportUrls.entries()];

    for (let index = 0; index < entries.length; index += downloadBatchSize) {
        const batch = entries.slice(index, index + downloadBatchSize);
        const downloads = await Promise.all(
            batch.map(async ([nodeId, url]) => {
                let response;

                try {
                    response = await fetch(url);
                } catch (error) {
                    throw new IconSyncError(
                        'FIGMA_REQUEST_FAILED',
                        `SVG download failed for node "${nodeId}": ${error.message}.`
                    );
                }

                if (!response.ok) {
                    throw new IconSyncError(
                        'FIGMA_REQUEST_FAILED',
                        `SVG download failed for node "${nodeId}": ${response.status}.`
                    );
                }

                const svg = await response.text();

                if (!/<svg(?:\s|>)/i.test(svg)) {
                    throw new IconSyncError(
                        'FIGMA_REQUEST_FAILED',
                        `Figma returned invalid SVG content for node "${nodeId}".`
                    );
                }

                return [nodeId, svg];
            })
        );

        for (const [nodeId, svg] of downloads) {
            result.set(nodeId, svg);
        }

        onProgress?.(Math.min(index + batch.length, entries.length), entries.length);
    }

    return result;
}

async function fileHash(filePath) {
    try {
        return hash(await fs.readFile(filePath));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

async function resolveFileName(packDir, iconName, previousFile, exclusionSuffix) {
    if (previousFile && path.basename(previousFile) === previousFile) {
        return previousFile;
    }

    const markedFile =
        exclusionSuffix && !iconName.endsWith(exclusionSuffix) ? `${iconName}${exclusionSuffix}.svg` : null;

    if (markedFile && (await fileHash(path.join(packDir, markedFile)))) {
        return markedFile;
    }

    return `${iconName}.svg`;
}

function emptyManifest(fileKey, rootNodeId) {
    return {
        fileKey,
        packs: {},
        rootNodeId,
        version: 1,
    };
}

export async function loadManifest(fileKey, rootNodeId, filePath = manifestPath) {
    const manifest = await readJson(filePath, emptyManifest(fileKey, rootNodeId));

    if (manifest.version !== 1) {
        throw new IconSyncError('MANIFEST_INVALID', `Unsupported Figma icons manifest version "${manifest.version}".`);
    }

    if (manifest.fileKey !== fileKey || manifest.rootNodeId !== rootNodeId) {
        throw new IconSyncError(
            'MANIFEST_SOURCE_MISMATCH',
            'The icons manifest belongs to another Figma source. Remove it only after reviewing managed files.'
        );
    }

    return manifest;
}

async function planPack(pack, previousPack, exclusionSuffix, sourceDirectory) {
    const packDir = path.join(sourceDirectory, pack.name);
    const excludesOptimization = Boolean(pack.excludesOptimization);
    const previousIcons = previousPack?.icons ?? {};
    const currentNodeIds = new Set(pack.icons.map(icon => icon.nodeId));
    const plannedIcons = {};
    const exports = [];
    const removals = new Set();

    for (const icon of pack.icons) {
        const previous = previousIcons[icon.nodeId];
        const previousFile = previous?.name === icon.name ? previous.file : null;
        const hasOptimizationSuffix = Boolean(exclusionSuffix && icon.name.endsWith(exclusionSuffix));
        const shouldAddOptimizationSuffix = Boolean(exclusionSuffix && !hasOptimizationSuffix);
        const markedName = shouldAddOptimizationSuffix ? `${icon.name}${exclusionSuffix}` : icon.name;
        const file = excludesOptimization
            ? `${markedName}.svg`
            : await resolveFileName(
                  packDir,
                  icon.name,
                  previousPack?.excludesOptimization ? null : previousFile,
                  previousPack?.excludesOptimization ? null : exclusionSuffix
              );
        const targetPath = path.join(packDir, file);
        const currentHash = await fileHash(targetPath);
        const unchanged =
            !icon.hasInstances && previous?.fingerprint === icon.fingerprint && previous?.sourceHash === currentHash;

        plannedIcons[icon.nodeId] = {
            file,
            fingerprint: icon.fingerprint,
            name: icon.name,
            sourceHash: currentHash,
        };

        if (!unchanged) {
            exports.push({
                ...icon,
                added: currentHash === null,
                file,
                pack: pack.name,
                targetPath,
            });
        }

        if (previous?.file && path.basename(previous.file) === previous.file && previous.file !== file) {
            removals.add(path.join(packDir, previous.file));
        }
    }

    for (const [nodeId, previous] of Object.entries(previousIcons)) {
        if (!currentNodeIds.has(nodeId) && previous.file && path.basename(previous.file) === previous.file) {
            removals.add(path.join(packDir, previous.file));
        }
    }

    const currentFiles = new Set(Object.values(plannedIcons).map(icon => path.join(packDir, icon.file)));

    return {
        exports,
        manifest: {
            ...(excludesOptimization ? { excludesOptimization: true } : {}),
            icons: plannedIcons,
            nodeId: pack.nodeId,
        },
        removals: [...removals].filter(file => !currentFiles.has(file)),
    };
}

function planRemovedPack(packName, previousPack, sourceDirectory) {
    assertPackName(packName);

    const packDir = path.join(sourceDirectory, packName);

    return Object.values(previousPack.icons ?? {})
        .filter(icon => icon.file && path.basename(icon.file) === icon.file)
        .map(icon => path.join(packDir, icon.file));
}

export async function createSyncPlan({
    discoveredPacks,
    excludedPacks = new Set(),
    exclusionSuffix,
    onCompare,
    previousManifest,
    requestedPacks,
    sourceDirectory = sourceDir,
}) {
    const availablePacks = new Map(discoveredPacks.map(pack => [pack.name, pack]));
    const selectedNames = resolveSelectedNames(discoveredPacks, requestedPacks);

    const nextManifest = structuredClone(previousManifest);
    const plan = {
        exports: [],
        manifest: nextManifest,
        removals: [],
    };

    for (const [index, packName] of selectedNames.entries()) {
        onCompare?.(packName, index + 1, selectedNames.length);

        const packPlan = await planPack(
            availablePacks.get(packName),
            previousManifest.packs[packName],
            exclusionSuffix,
            sourceDirectory
        );

        nextManifest.packs[packName] = packPlan.manifest;
        plan.exports.push(...packPlan.exports);
        plan.removals.push(...packPlan.removals);
    }

    if (requestedPacks.length === 0) {
        for (const [packName, previousPack] of Object.entries(previousManifest.packs)) {
            if (!availablePacks.has(packName) && !excludedPacks.has(packName)) {
                plan.removals.push(...planRemovedPack(packName, previousPack, sourceDirectory));
                delete nextManifest.packs[packName];
            }
        }
    }

    const totalIcons = selectedNames.reduce((count, packName) => count + availablePacks.get(packName).icons.length, 0);

    return {
        ...plan,
        selectedNames,
        skipped: totalIcons - plan.exports.length,
        totalIcons,
    };
}

async function applyPlan(plan, downloadedSvgs) {
    const addedFiles = [];
    const changedFiles = [];
    const removedFiles = [];
    let changed = 0;
    let pruned = 0;
    let removed = 0;

    for (const icon of plan.exports) {
        const svg = downloadedSvgs.get(icon.nodeId);
        const svgHash = hash(svg);
        const currentHash = await fileHash(icon.targetPath);

        plan.manifest.packs[icon.pack].icons[icon.nodeId].sourceHash = svgHash;

        if (currentHash !== svgHash) {
            await fs.mkdir(path.dirname(icon.targetPath), { recursive: true });
            await writeFileAtomic(icon.targetPath, svg);
            changed++;
            (icon.added ? addedFiles : changedFiles).push(`${icon.pack}/${icon.file}`);
        }
    }

    for (const file of plan.removals) {
        try {
            await fs.unlink(file);
            removed++;
            removedFiles.push(`${path.basename(path.dirname(file))}/${path.basename(file)}`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    for (const packDir of new Set(plan.removals.map(file => path.dirname(file)))) {
        try {
            await fs.rmdir(packDir);
            pruned++;
        } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) {
                throw error;
            }
        }
    }

    return { addedFiles, changed, changedFiles, pruned, removed, removedFiles };
}

async function buildIcons(machineOutput) {
    await new Promise((resolve, reject) => {
        const child = spawn('bun', ['run', '--cwd', packageDir, 'build'], {
            cwd: path.resolve(packageDir, '../..'),
            stdio: machineOutput ? ['ignore', process.stderr, process.stderr] : 'inherit',
        });

        child.on('error', error => reject(new IconSyncError('BUILD_FAILED', error.message)));
        child.on('exit', code =>
            code === 0 ? resolve() : reject(new IconSyncError('BUILD_FAILED', `Icons build exited with code ${code}.`))
        );
    });
}

async function writeManifestIfChanged(manifest) {
    const content = `${JSON.stringify(manifest, null, 4)}\n`;
    let currentContent;

    try {
        currentContent = await fs.readFile(manifestPath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    if (currentContent !== content) {
        await writeFileAtomic(manifestPath, content);
    }
}

function packResults(discoveredPacks) {
    return discoveredPacks.map(pack => ({
        iconCount: pack.icons.length,
        name: pack.name,
        nodeId: pack.nodeId,
    }));
}

function resolveSelectedNames(discoveredPacks, requestedPacks) {
    const availablePackNames = discoveredPacks.map(pack => pack.name);
    const availablePacks = new Set(availablePackNames);
    const selectedNames = requestedPacks.length > 0 ? [...new Set(requestedPacks)] : availablePackNames;

    for (const packName of selectedNames) {
        if (!availablePacks.has(packName)) {
            throw new IconSyncError(
                'PACK_NOT_FOUND',
                `Pack "${packName}" was not found. Available packs: ${availablePackNames.join(', ')}.`,
                { availablePacks: availablePackNames }
            );
        }
    }

    return selectedNames;
}

export async function syncIcons(requestedPacks = [], { authorize = false, json = false, list = false } = {}) {
    const metadata = await readJson(metadataPath, {});
    const sourceUrl = process.env.FIGMA_ICONS_SOURCE_URL ?? metadata.figma?.iconsSourceUrl;
    const output = json ? process.stderr : process.stdout;
    const status = createStatus(output);

    if (!sourceUrl) {
        throw new IconSyncError(
            'INVALID_CONFIG',
            'Missing icons source. Set figma.iconsSourceUrl in packages/icons/src/icons-metadata.json.'
        );
    }

    const { fileKey, nodeId: rootNodeId } = parseFigmaSourceUrl(sourceUrl);

    if (authorize) {
        output.write(
            process.env.FIGMA_ACCESS_TOKEN ? 'Validating FIGMA_ACCESS_TOKEN.\n' : 'Starting Figma authorization.\n'
        );
    }

    try {
        let authHeaders = await getFigmaAuthHeaders({
            force: authorize && !process.env.FIGMA_ACCESS_TOKEN,
            output,
        });
        let rootNode;

        try {
            status.update('Reading the icon structure from Figma');
            rootNode = await getRootNode(fileKey, rootNodeId, authHeaders);
        } catch (error) {
            status.stop();

            if (process.env.FIGMA_ACCESS_TOKEN || ![401, 403].includes(error.status)) {
                throw error;
            }

            output.write('The stored Figma token is invalid or expired. Authorization is required again.\n');
            authHeaders = await getFigmaAuthHeaders({ force: true, output });
            status.update('Reading the icon structure from Figma');
            rootNode = await getRootNode(fileKey, rootNodeId, authHeaders);
        }

        if (authorize) {
            status.done('Figma authorization verified');

            return {
                authorized: true,
                operation: 'auth',
                resource: 'icons',
                schemaVersion: 1,
            };
        }

        const exclusionSuffix = metadata.optimization?.excludeFromOptimizationSuffix;
        const { excludedPacks, packs: discoveredPacks } = discoverPacks(
            rootNode,
            exclusionSuffix,
            metadata.figma?.excludeFromSyncSuffix,
            metadata.figma?.excludePacks
        );
        const packs = packResults(discoveredPacks);

        if (list) {
            status.done(
                `Found ${packs.length} packs with ${packs.reduce((sum, pack) => sum + pack.iconCount, 0)} icons`
            );

            return {
                operation: 'list',
                packs,
                resource: 'icons',
                schemaVersion: 1,
            };
        }

        const selectedNames = resolveSelectedNames(discoveredPacks, requestedPacks);
        const totalIcons = discoveredPacks
            .filter(pack => selectedNames.includes(pack.name))
            .reduce((sum, pack) => sum + pack.icons.length, 0);

        status.done(`Found ${selectedNames.length} packs with ${totalIcons} icons`);

        const previousManifest = await loadManifest(fileKey, rootNodeId);
        const plan = await createSyncPlan({
            discoveredPacks,
            excludedPacks,
            exclusionSuffix,
            onCompare: (packName, completed, total) => {
                status.update(`Comparing pack ${packName} (${completed}/${total})`);
            },
            previousManifest,
            requestedPacks,
        });

        status.done(`Comparison complete: ${plan.exports.length} to export, ${plan.skipped} unchanged`);

        let exportUrls = new Map();
        let downloadedSvgs = new Map();

        if (plan.exports.length > 0) {
            status.update(`Getting SVG URLs: 0/${plan.exports.length}`);
            exportUrls = await getExportUrls(
                fileKey,
                plan.exports.map(icon => icon.nodeId),
                authHeaders,
                (completed, total) => status.update(`Getting SVG URLs: ${completed}/${total}`)
            );
            status.done(`SVG URLs received: ${plan.exports.length}/${plan.exports.length}`);

            status.update(`Downloading SVGs: 0/${plan.exports.length}`);
            downloadedSvgs = await downloadSvgs(exportUrls, (completed, total) =>
                status.update(`Downloading SVGs: ${completed}/${total}`)
            );
            status.done(`SVGs downloaded: ${plan.exports.length}/${plan.exports.length}`);
        }

        status.update('Updating local files');
        const { addedFiles, changed, changedFiles, pruned, removed, removedFiles } = await applyPlan(
            plan,
            downloadedSvgs
        );

        status.done(`Files updated: ${changed} changed, ${removed} removed`);

        const built = changed > 0 || removed > 0 || pruned > 0;

        if (built) {
            status.done('Starting the @clowdy/icons build');
            await buildIcons(json);
        }

        await writeManifestIfChanged(plan.manifest);

        return {
            addedFiles,
            built,
            changed,
            changedFiles,
            exported: plan.exports.length,
            operation: 'sync',
            packs: plan.selectedNames,
            pruned,
            removed,
            removedFiles,
            resource: 'icons',
            schemaVersion: 1,
            skipped: plan.skipped,
        };
    } finally {
        status.stop();
    }
}

function parseArgs(args) {
    const json = args.includes('--json');
    const help = args.includes('--help') || args.includes('-h');
    const allowedOptions = new Set(['--', '--help', '-h', '--json', '--list']);
    const unknownOption = args.find(arg => arg.startsWith('-') && !allowedOptions.has(arg));

    if (unknownOption) {
        throw new IconSyncError('INVALID_ARGUMENT', `Unknown option "${unknownOption}".`);
    }

    if (help && json) {
        throw new IconSyncError('INVALID_ARGUMENT', 'Use --help without --json.');
    }

    const values = args.filter(arg => arg !== '--' && !arg.startsWith('-'));
    const authorize = values[0] === 'auth';
    const requestedPacks = authorize ? [] : values;
    const list = args.includes('--list');

    if (authorize && values.length > 1) {
        throw new IconSyncError('INVALID_ARGUMENT', 'auth does not accept pack names.');
    }

    if (list && (authorize || requestedPacks.length > 0)) {
        throw new IconSyncError('INVALID_ARGUMENT', '--list does not accept pack names.');
    }

    return {
        authorize,
        help,
        json,
        list,
        requestedPacks,
    };
}

function errorResult(error) {
    let code = 'ICON_SYNC_FAILED';
    let details = {};

    if (error instanceof IconSyncError || error.code === 'AUTH_REQUIRED') {
        code = error.code;
        details = error.details ?? {};
    } else if (error.code) {
        code = 'LOCAL_WRITE_CONFLICT';
    }

    return {
        error: {
            code,
            message: error.message,
            ...details,
        },
        operation: 'error',
        resource: 'icons',
        schemaVersion: 1,
    };
}

function printResult(result, json) {
    if (json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);

        return;
    }

    if (result.operation === 'list') {
        process.stdout.write(
            `${result.packs.map(pack => `${pack.name}: ${pack.iconCount} icons (${pack.nodeId})`).join('\n')}\n`
        );

        return;
    }

    if (result.operation === 'auth') {
        process.stdout.write('Figma authorization completed and verified.\n');

        return;
    }

    process.stdout.write(
        `Icons synced: ${result.changed} changed, ${result.removed} removed, ` +
            `${result.pruned} packs removed, ${result.skipped} skipped, ${result.exported} exported.\n`
    );
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);

    if (options.help) {
        process.stdout.write(
            `${[
                'Usage: ./clowdy sync icons [options] [pack ...]',
                '       ./clowdy sync icons auth [--json]',
                '',
                '  auth           Replace and verify the saved Figma token',
                '  --list         List available Figma icon packs without changing local files',
                '  --json         Print one versioned JSON result to stdout',
            ].join('\n')}\n`
        );

        return;
    }

    const result = await syncIcons(options.requestedPacks, options);

    printResult(result, options.json);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    main().catch(error => {
        const json = process.argv.includes('--json');
        const result = errorResult(error);

        if (json) {
            process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
            process.stderr.write(`Icon sync failed [${result.error.code}]: ${result.error.message}\n`);
        }

        process.exitCode = 1;
    });
}
