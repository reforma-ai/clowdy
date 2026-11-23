/**
 * Where the daemon keeps its data: `clowdy.db`, `daemon.json`, `daemon.lock`, `daemon.log`.
 *
 * Pure on purpose (no Node imports): the daemon and the desktop app both call it and must get the same folder,
 * so the app finds the daemon's `daemon.json` without asking the daemon.
 */
export interface DataDirInput {
    /** `process.platform`. */
    platform: string;
    /** The user's home folder. */
    home: string;
    env: Record<string, string | undefined>;
}

/** `CLOWDY_DATA_DIR` overrides everything; `CLOWDY_PROFILE=dev` gives a development run its own folder. */
export function daemonDataDir({ platform, home, env }: DataDirInput): string {
    if (env.CLOWDY_DATA_DIR) return env.CLOWDY_DATA_DIR;

    const dev = env.CLOWDY_PROFILE === 'dev';
    const base = trimTrailingSeparators(home);

    if (platform === 'darwin') {
        return [base, 'Library', 'Application Support', dev ? 'Clowdy Dev' : 'Clowdy', 'daemon'].join('/');
    }

    if (platform === 'win32') {
        const local = env.LOCALAPPDATA ? trimTrailingSeparators(env.LOCALAPPDATA) : `${base}\\AppData\\Local`;

        return [local, dev ? 'Clowdy Dev' : 'Clowdy', 'daemon'].join('\\');
    }

    return [base, '.local', 'share', dev ? 'clowdy-dev' : 'clowdy', 'daemon'].join('/');
}

function trimTrailingSeparators(folder: string): string {
    return folder.replace(/[\\/]+$/, '');
}
