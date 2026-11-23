import type { GitHubRepo } from '@clowdy/protocol';

const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const NAME = /^[\w.-]+$/;

/** GitHub takes ssh on port 443 at this name; the repository is the one of `github.com`. */
const SSH_OVER_HTTPS_HOST = 'ssh.github.com';

/** The repository a path of two parts names (`/owner/repo.git`, `owner/repo/`). */
function repoAt(host: string, path: string): GitHubRepo | undefined {
    const parts = path.replace(/^\/+|\/+$/g, '').split('/');
    const [owner, last] = parts;

    if (parts.length !== 2 || owner === undefined || last === undefined) return undefined;

    const name = last.replace(/\.git$/i, '');
    const lower = host.toLowerCase();

    if (!HOST.test(lower) || !NAME.test(owner) || !NAME.test(name) || /^\.+$/.test(owner) || /^\.+$/.test(name))
        return undefined;

    return { host: lower === SSH_OVER_HTTPS_HOST ? 'github.com' : lower, owner, name };
}

/**
 * The repository a git remote's address names, as `host/owner/name`, or nothing for an address that is not that (a path on the disk, a bare name, a path of more or fewer
 * than two parts). The forms are `https://[user[:token]@]host[:port]/owner/repo[.git]` (and `http`), `ssh://[user@]host[:port]/owner/repo[.git]` (and `git`), and the
 * short ssh form `[user@]host:owner/repo[.git]`. Nothing but the host, the owner and the name is kept: a credential in the address, or a port of ssh, goes no further than
 * this function, so none can reach a log, an answer, an error or a key. A port is kept for `http` and `https`, where it is the server's own.
 */
export function parseRemote(address: string): GitHubRepo | undefined {
    const text = address.trim();

    // eslint-disable-next-line no-control-regex
    if (text === '' || /[\s\x00-\x1f\x7f\\?#]/.test(text)) return undefined;

    const url = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)\/(.*)$/i.exec(text);

    if (url) {
        const scheme = url[1]!.toLowerCase();

        if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(scheme)) return undefined;

        const authority = url[2]!;
        const hostAndPort = /^([^:]+)(?::(\d+))?$/.exec(authority.slice(authority.lastIndexOf('@') + 1));

        if (!hostAndPort) return undefined;

        const web = scheme === 'https' || scheme === 'http';
        const repo = repoAt(hostAndPort[1]!, url[3]!);

        return repo && web && hostAndPort[2] !== undefined ? { ...repo, host: `${repo.host}:${hostAndPort[2]}` } : repo;
    }

    // `[user@]host:owner/repo`: the host has no slash, and a single letter before the colon is a drive of Windows.
    const short = /^(?:[^@/:]+@)?([^@/:]{2,}):(?!\/)(.+)$/.exec(text);

    return short ? repoAt(short[1]!, short[2]!) : undefined;
}
