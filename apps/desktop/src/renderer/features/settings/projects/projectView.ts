import type { Project, ProjectInfo } from '@clowdy/protocol';

export interface RemoteLink {
    /** The address as a person reads it, without the credentials it may carry. */
    text: string;
    /** Where a click goes: only for a repository on a web host, reached over https. */
    href?: string;
}

/** `host/owner/repo` on the web, for a host that has a dot in its name (a bare host name is more likely to be a machine than a site). */
function webAddress(host: string, path: string): RemoteLink | undefined {
    const repository = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');

    if (!host.includes('.') || !repository || /\s/.test(repository)) return undefined;

    return { text: `${ host }/${ repository }`, href: `https://${ host }/${ repository }` };
}

/**
 * A git remote as a person reads it, with a link when it names a repository on a web host: `git@github.com:acme/app.git`, `ssh://git@host/acme/app.git`
 * and `https://host/acme/app.git` all become `https://host/acme/app`. Credentials in the address (`https://user:token@host/…`) are never shown or linked.
 * An address of another kind (a path, `file://`, plain `http`) is shown as it is, without a link.
 */
export function remoteLink(remote: string | undefined): RemoteLink | undefined {
    const raw = remote?.trim();

    if (!raw) return undefined;

    if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
        try {
            const url = new URL(raw);

            if (url.protocol === 'https:') return webAddress(url.host, url.pathname) ?? { text: `${ url.host }${ url.pathname }` };

            if (url.protocol === 'ssh:' || url.protocol === 'git:') return webAddress(url.hostname, url.pathname) ?? { text: `${ url.hostname }${ url.pathname }` };

            return { text: `${ url.protocol }//${ url.host }${ url.pathname }` };
        }
        catch {
            // An address that does not parse (a bad port, a space in the host) is shown as written, less the part before an `@` that may be a password.
            return { text: raw.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]*@/i, '$1') };
        }
    }

    // `[user@]host:path`, but not a Windows drive (`C:\repo`).
    const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)([^\\].*)$/.exec(raw);

    if (scp) return webAddress(scp[1], scp[2]) ?? { text: `${ scp[1] }:${ scp[2] }` };

    return { text: raw };
}

const plural = (count: number, one: string) => `${ count } ${ count === 1 ? one : `${ one }s` }`;

/** What a project holds, for its row: `12 chats · 5 tasks`. */
export function holdingsLine(info: Pick<ProjectInfo, 'chats' | 'tasks'> | undefined): string | undefined {
    if (!info) return undefined;

    if (info.chats === 0 && info.tasks === 0) return 'No chats or tasks yet';

    return [plural(info.chats, 'chat'), plural(info.tasks, 'task')].join(' · ');
}

const PERSONAL_NOTE = 'Your personal space is for chats that belong to no repository. It lives in Clowdy\'s own folder, and it cannot be renamed, moved or removed.';

/** The line under the title of a project's page: what the personal space is, or what any other project holds. */
export function projectNote(project: Pick<Project, 'personal'>, info: Pick<ProjectInfo, 'chats' | 'tasks'> | undefined): string | undefined {
    return project.personal ? PERSONAL_NOTE : holdingsLine(info);
}

/** What removing a project deletes, for its confirmation. */
export function removalMessage(name: string, path: string, info: Pick<ProjectInfo, 'chats' | 'tasks'> | undefined): string {
    const holds = info && (info.chats > 0 || info.tasks > 0) ? `its ${ [plural(info.chats, 'chat'), plural(info.tasks, 'task')].join(' and ') }, ` : 'its chats and tasks, ';

    return `"${ name }" leaves Clowdy together with ${ holds }and the work of its agents, for good. The folder ${ path } and everything in it stay on your computer.`;
}
