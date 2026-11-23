import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `git ls-files` prints this much for the biggest repositories; a larger answer is a sign something else is wrong. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

/** Without git, a walk stops here: a project folder with more files than this is not one a person mentions files of. */
const MAX_WALKED = 50_000;
const MAX_DEPTH = 12;
/** The project's own folder holds its documents, which have their own list, so its files are never offered. */
const OWN_FOLDER = '.clowdy';
const NEVER_WALKED = new Set(['.git', 'node_modules', OWN_FOLDER]);

async function git(cwd: string, ...args: string[]): Promise<string[]> {
    const { stdout } = await run('git', ['ls-files', '-z', ...args], {
        cwd,
        maxBuffer: MAX_GIT_OUTPUT,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
    });

    return stdout.split('\0').filter(Boolean);
}

/**
 * Tracked files and new files git does not ignore, less the ones deleted from the folder. A submodule or a repository
 * nested in the folder is one entry, a folder (git prints the second with a trailing `/`, dropped here). Throws when
 * `cwd` is not a repository or git is missing.
 */
async function gitFiles(cwd: string): Promise<string[]> {
    const [present, deleted] = await Promise.all([
        git(cwd, '--cached', '--others', '--exclude-standard'),
        git(cwd, '--deleted'),
    ]);
    const gone = new Set(deleted);

    return present.filter(path => !gone.has(path)).map(path => path.replace(/\/$/, ''));
}

/** Every file below `root`, without following links, for a folder that is not a repository. */
async function walkedFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    let level = [''];

    for (let depth = 0; level.length > 0 && depth <= MAX_DEPTH && files.length < MAX_WALKED; depth++) {
        const next: string[] = [];

        for (const prefix of level) {
            const entries = await readdir(`${root}/${prefix}`, { withFileTypes: true }).catch(() => []);

            for (const entry of entries) {
                if (entry.isDirectory() && !NEVER_WALKED.has(entry.name)) {
                    next.push(`${prefix}${entry.name}/`);
                } else if (entry.isFile()) {
                    files.push(`${prefix}${entry.name}`);
                }
            }
        }

        level = next;
    }

    return files.slice(0, MAX_WALKED);
}

/** A name with a line break or another control character cannot be written into a one-line message as a mention. */
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * The files of a project folder, as paths relative to it with `/` separators: what git tracks and does not ignore,
 * or, outside a repository, what a walk finds. Nothing from the project's own `.clowdy` folder, and no name a
 * message cannot carry.
 */
export async function listProjectFiles(root: string): Promise<string[]> {
    const files = await gitFiles(root).catch(() => walkedFiles(root));

    return files.filter(path => !path.startsWith(`${OWN_FOLDER}/`) && !HAS_CONTROL_CHARACTER.test(path));
}
