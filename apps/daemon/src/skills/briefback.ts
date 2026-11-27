import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { conflict, unavailable } from '../errors';
import { parseSkillFile } from './frontmatter';

const exec = promisify(execFile);
const REPOSITORY = 'https://github.com/reforma-ai/briefback.git';
const MAX_FILES = 500;
const MAX_BYTES = 10 * 1024 * 1024;
const METADATA = '.clowdy-briefback.json';
const TREE_ID = /^[a-f0-9]{40}$/;
const API_URL = 'https://api.github.com/repos/reforma-ai/briefback';

export interface BriefbackStatus {
    copies: { exists: boolean; installed: boolean }[];
    fingerprint: string;
}

function maybeStat(path: string) {
    try {
        return lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

/** Paths of the skill's own mode instructions. */
function references(content: string): string[] {
    return [...content.matchAll(/\]\((references\/[a-zA-Z0-9._/-]+)\)/g)].map(match => match[1]!);
}

/** Captures each entry and, for a linked skill directory, its resolved contents without following nested links. */
export function briefbackStatus(roots: readonly string[]): BriefbackStatus {
    const hash = createHash('sha256');
    const copies = roots.map(root => {
        const target = join(root, 'briefback');
        const entry = maybeStat(target);
        hash.update(`${resolve(target)}\0`);
        function walk(path: string, relative: string): void {
            const stat = lstatSync(path);
            hash.update(`${relative}\0${stat.mode}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}\0`);
            if (stat.isDirectory()) {
                for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`);
            }
        }
        let directory = entry?.isDirectory() ? target : undefined;
        if (entry) {
            walk(target, '');
            if (entry.isSymbolicLink()) {
                try {
                    const resolved = realpathSync(target);
                    hash.update(`resolved:${resolved}\0`);
                    const resolvedEntry = lstatSync(resolved);
                    if (resolvedEntry.isDirectory()) {
                        directory = resolved;
                        walk(resolved, 'linked');
                    } else {
                        hash.update('not-directory\0');
                    }
                } catch (error) {
                    if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))
                        throw error;
                    hash.update('unresolved\0');
                }
            }
        } else hash.update('missing\0');
        let installed = false;
        if (directory) {
            const file = join(directory, 'SKILL.md');
            const skillFile = maybeStat(file);
            if (skillFile?.isFile()) {
                const content = readFileSync(file, 'utf8');
                installed =
                    parseSkillFile(content, 'briefback').ok &&
                    references(content).every(reference => {
                        const parts = reference.split('/');
                        if (parts.some(part => part === '..' || part === '.')) return false;
                        let path = directory;
                        return parts.every((part, index) => {
                            path = join(path, part);
                            const stat = maybeStat(path);
                            return index === parts.length - 1 ? !!stat?.isFile() : !!stat?.isDirectory();
                        });
                    });
            }
        }
        return { exists: !!entry, installed };
    });
    return { copies, fingerprint: hash.digest('hex') };
}

/** Read only regular files from the checked-out skill, with bounded size and no symlink traversal. */
function sourceFiles(source: string): { name: string; data: Buffer }[] {
    const result: { name: string; data: Buffer }[] = [];
    let bytes = 0;
    function walk(path: string, relative: string): void {
        const stat = lstatSync(path);
        if (stat.isDirectory()) {
            for (const name of readdirSync(path).sort())
                walk(join(path, name), relative ? `${relative}/${name}` : name);
        } else if (stat.isFile()) {
            bytes += stat.size;
            if (++count > MAX_FILES || bytes > MAX_BYTES) throw new Error('Briefback skill is too large');
            result.push({ name: relative, data: readFileSync(path) });
        } else {
            throw new Error('Briefback skill contains an unsupported file');
        }
    }
    let count = 0;
    walk(source, '');
    const skill = result.find(file => file.name === 'SKILL.md');
    if (
        !skill ||
        !parseSkillFile(skill.data.toString('utf8'), 'briefback').ok ||
        !references(skill.data.toString('utf8')).every(reference => result.some(file => file.name === reference))
    ) {
        throw new Error('Briefback skill is invalid');
    }
    return result;
}

type SkillFile = { name: string; data: Buffer };

function contentHash(files: SkillFile[]): string {
    const hash = createHash('sha256');
    for (const file of files.filter(file => file.name !== METADATA)) {
        hash.update(`${Buffer.byteLength(file.name)}:${file.name}:${file.data.length}:`).update(file.data);
    }
    return hash.digest('hex');
}

type Identity = { tree: string; commit: string };
type Upstream = { tree: string; relationship: 'ahead' | 'identical' | 'behind' | 'diverged' };

function installedIdentity(roots: readonly string[]): Identity | undefined {
    if (!roots.length) return undefined;
    let identity: Identity | undefined;
    for (const root of roots) {
        const folder = join(root, 'briefback');
        const metadataFile = join(folder, METADATA);
        const stat = maybeStat(metadataFile);
        if (!stat?.isFile() || stat.size > 4096) return undefined;
        const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as {
            version?: unknown;
            tree?: unknown;
            commit?: unknown;
            content?: unknown;
        };
        if (
            metadata.version !== 2 ||
            typeof metadata.tree !== 'string' ||
            !TREE_ID.test(metadata.tree) ||
            typeof metadata.commit !== 'string' ||
            !TREE_ID.test(metadata.commit) ||
            typeof metadata.content !== 'string' ||
            metadata.content !== contentHash(sourceFiles(folder))
        )
            return undefined;
        if (identity && (identity.tree !== metadata.tree || identity.commit !== metadata.commit)) return undefined;
        identity = { tree: metadata.tree, commit: metadata.commit };
    }
    return identity;
}

/** Compare with the recorded commit first; a different tree alone could be a rollback. */
async function upstreamTree(commit: string): Promise<Upstream | undefined> {
    try {
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Clowdy' };
        const latest = await fetch(`${API_URL}/commits/main`, { headers, signal: AbortSignal.timeout(8000) });
        if (!latest.ok) return undefined;
        const head = ((await latest.json()) as { sha?: unknown }).sha;
        if (typeof head !== 'string' || !TREE_ID.test(head)) return undefined;
        const response = await fetch(`${API_URL}/compare/${commit}...${head}`, {
            headers,
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return undefined;
        const comparison = (await response.json()) as {
            status?: unknown;
            base_commit?: { sha?: unknown };
            merge_base_commit?: { sha?: unknown };
        };
        const relationship = comparison.status;
        if (
            (relationship !== 'ahead' && relationship !== 'identical') ||
            (relationship === 'identical' && head !== commit) ||
            (relationship === 'ahead' && head === commit) ||
            comparison.base_commit?.sha !== commit ||
            comparison.merge_base_commit?.sha !== commit
        )
            return undefined;
        const contents = await fetch(`${API_URL}/contents/skills?ref=${head}`, {
            headers,
            signal: AbortSignal.timeout(8000),
        });
        if (!contents.ok) return undefined;
        const entries: unknown = await contents.json();
        if (!Array.isArray(entries)) return undefined;
        const entry = entries.find(
            (item: unknown) =>
                typeof item === 'object' && item !== null && 'path' in item && item.path === 'skills/briefback'
        );
        if (!entry || entry.type !== 'dir' || typeof entry.sha !== 'string' || !TREE_ID.test(entry.sha))
            return undefined;
        return { tree: entry.sha, relationship };
    } catch {
        return undefined;
    }
}

/** Unknown covers external, incomplete or edited copies, divergent history and unavailable upstream information. */
export async function checkBriefbackUpdate(
    roots: readonly string[],
    fingerprint: string,
    options: { upstream?: (commit: string) => Promise<Upstream | undefined> } = {}
): Promise<'up-to-date' | 'update-available' | 'unknown'> {
    try {
        if (briefbackStatus(roots).fingerprint !== fingerprint) return 'unknown';
        const identity = installedIdentity(roots);
        if (!identity) return 'unknown';
        const remote = await (options.upstream ?? upstreamTree)(identity.commit);
        const after = installedIdentity(roots);
        if (
            !remote ||
            !TREE_ID.test(remote.tree) ||
            !after ||
            after.tree !== identity.tree ||
            after.commit !== identity.commit ||
            briefbackStatus(roots).fingerprint !== fingerprint
        )
            return 'unknown';
        if (remote.relationship !== 'ahead' && remote.relationship !== 'identical') return 'unknown';
        if (remote.tree === identity.tree) return 'up-to-date';
        return remote.relationship === 'ahead' ? 'update-available' : 'unknown';
    } catch {
        return 'unknown';
    }
}

let queue = Promise.resolve();

/**
 * Installs the skill for each engine. The fingerprint is the state shown to the person when they confirmed
 * replacement (or the empty state immediately before an install); stale confirmations cannot replace a new copy.
 * A local source is injectable for tests, never supplied by the HTTP caller.
 */
export function installBriefback(
    roots: readonly string[],
    fingerprint: string,
    options: { source?: string; treeId?: string; commitId?: string; onCopyInstalled?: (index: number) => void } = {}
): Promise<BriefbackStatus> {
    const run = queue.then(() => install(roots, fingerprint, options));
    queue = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

async function install(
    roots: readonly string[],
    fingerprint: string,
    options: { source?: string; treeId?: string; commitId?: string; onCopyInstalled?: (index: number) => void }
): Promise<BriefbackStatus> {
    if (!roots.length || new Set(roots.map(root => resolve(root))).size !== roots.length) {
        throw new Error('Invalid skill folders');
    }
    const observed = briefbackStatus(roots);
    if (observed.fingerprint !== fingerprint) throw conflict('Skill folders changed; review them again');
    let download: string | undefined;
    const work: {
        root: string;
        temp: string;
        target: string;
        backedUp: boolean;
        created: boolean;
        createdFingerprint?: string;
    }[] = [];
    let complete = false;
    try {
        let source = options.source;
        let treeId = options.treeId;
        let commitId = options.commitId;
        if (!source) {
            download = mkdtempSync(join(tmpdir(), 'clowdy-briefback-download-'));
            const env = {
                PATH: process.env.PATH,
                SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
                WINDIR: process.env.WINDIR,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
                PATHEXT: process.env.PATHEXT,
                ComSpec: process.env.ComSpec ?? process.env.COMSPEC,
                HOME: download,
                USERPROFILE: download,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_TERMINAL_PROMPT: '0',
            };
            await exec(
                'git',
                ['-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--', REPOSITORY, download + '/repo'],
                {
                    env,
                    timeout: 60_000,
                    maxBuffer: 1024 * 1024,
                }
            );
            const tree = await exec('git', ['-C', join(download, 'repo'), 'rev-parse', 'HEAD:skills/briefback'], {
                env,
                timeout: 10_000,
            });
            treeId = tree.stdout.trim();
            const commit = await exec('git', ['-C', join(download, 'repo'), 'rev-parse', 'HEAD'], {
                env,
                timeout: 10_000,
            });
            commitId = commit.stdout.trim();
            if (!TREE_ID.test(treeId)) throw new Error('Could not identify Briefback source');
            source = join(download, 'repo', 'skills', 'briefback');
        }
        const files = sourceFiles(source);
        if (files.some(file => file.name === METADATA)) throw new Error('Briefback source contains reserved metadata');
        if (treeId && commitId) {
            if (!TREE_ID.test(treeId) || !TREE_ID.test(commitId)) throw new Error('Invalid Briefback source identity');
            const metadata = { version: 2, tree: treeId, commit: commitId, content: contentHash(files) };
            files.push({ name: METADATA, data: Buffer.from(JSON.stringify(metadata)) });
        }
        for (const root of roots) {
            mkdirSync(root, { recursive: true });
            if (!statSync(root).isDirectory()) throw new Error('Skill folder is not a directory');
        }
        if (new Set(roots.map(root => realpathSync(root))).size !== roots.length)
            throw new Error('Duplicate skill folders');
        for (const root of roots) {
            const temp = mkdtempSync(join(root, '.briefback-install-'));
            const item: (typeof work)[number] = {
                root,
                temp,
                target: join(root, 'briefback'),
                backedUp: false,
                created: false,
            };
            work.push(item);
            for (const file of files) {
                const dest = join(temp, 'staged', file.name);
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, file.data, { flag: 'wx' });
            }
        }
        const checks = roots.map(root => briefbackStatus([root]).fingerprint);
        if (briefbackStatus(roots).fingerprint !== fingerprint)
            throw conflict('Skill folders changed; review them again');
        for (const [index, item] of work.entries()) {
            if (briefbackStatus([item.root]).fingerprint !== checks[index]) {
                throw conflict('Skill folders changed; review them again');
            }
            if (observed.copies[index]?.exists) {
                renameSync(item.target, join(item.temp, 'backup'));
                item.backedUp = true;
            }
            // mkdir is exclusive: a copy appearing since confirmation is never replaced.
            mkdirSync(item.target);
            item.created = true;
            item.createdFingerprint = briefbackStatus([item.root]).fingerprint;
            for (const name of readdirSync(join(item.temp, 'staged'))) {
                renameSync(join(item.temp, 'staged', name), join(item.target, name));
                item.createdFingerprint = briefbackStatus([item.root]).fingerprint;
            }
            options.onCopyInstalled?.(index);
        }
        const result = briefbackStatus(roots);
        if (!result.copies.every(copy => copy.installed)) throw new Error('Installed skill could not be verified');
        complete = true;
        return result;
    } catch (error) {
        // Move our incomplete copies aside, then restore originals. Never delete a backup if restoration fails.
        const failures: string[] = [];
        for (const item of work.toReversed()) {
            try {
                if (item.created) {
                    if (briefbackStatus([item.root]).fingerprint !== item.createdFingerprint)
                        throw new Error('Installed skill was changed');
                    renameSync(item.target, join(item.temp, 'failed'));
                }
                if (item.backedUp) {
                    if (maybeStat(item.target)) throw new Error('Skill folder is occupied');
                    renameSync(join(item.temp, 'backup'), item.target);
                }
            } catch {
                failures.push(item.temp);
            }
        }
        if (failures.length)
            throw unavailable(`Could not restore skill folders; any backups are kept in ${failures.join(', ')}`);
        throw error;
    } finally {
        if (download) rmSync(download, { recursive: true, force: true });
        // When rollback fails, retain all temporary folders so backups are never lost.
        if (complete || work.every(item => !maybeStat(join(item.temp, 'backup')))) {
            for (const item of work) rmSync(item.temp, { recursive: true, force: true });
        }
    }
}
