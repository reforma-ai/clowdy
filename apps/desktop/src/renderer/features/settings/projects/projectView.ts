import { folderNames } from '@clowdy/protocol';

import type { Project, ProjectFolder, ProjectInfo } from '@clowdy/protocol';

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

/** One folder as the project's page shows it. */
export interface FolderView {
    folder: ProjectFolder;
    /** Its short name among the project's folders (`folderNames`). */
    name: string;
    /** The first folder, where the agents work. */
    isMain: boolean;
    /** The daemon found it gone. False until the folders have been read. */
    missing: boolean;
    remote?: RemoteLink;
}

/** The folders of a project in its order, each with what the daemon read about it (`ProjectInfo.folders`, matched by id). */
export function folderViews(project: Pick<Project, 'folders'>, info: Pick<ProjectInfo, 'folders'> | undefined): FolderView[] {
    const names = folderNames(project.folders);

    return project.folders.map((folder, index) => {
        const read = info?.folders.find(entry => entry.folderId === folder.id);
        const remote = remoteLink(read?.remoteUrl);

        return { folder, name: names[index] ?? folder.path, isMain: index === 0, missing: read?.exists === false, ...(remote && { remote }) };
    });
}

/** Why a missing folder matters: without the main one the agents cannot work; another is left out of what they get. */
export function missingFolderNote(project: Pick<Project, 'personal'>, isMain: boolean): string {
    if (project.personal) return 'This folder no longer exists. Clowdy makes it again the next time it starts.';

    return isMain
        ? 'This folder no longer exists, so the agents of this project cannot work. If it moved, add its new place and make that the main folder.'
        : 'This folder no longer exists, so the agents leave it out';
}

/**
 * What a new main folder means, for its confirmation: the agents move to `next`, nothing on disk changes, and an agent that worked in the
 * old main folder starts over. `removed` is the old main folder when it leaves the project.
 */
export function newMainMessage(projectName: string, next: string, removed?: string): string {
    const move = removed ? `${ projectName } will work in ${ next } from now on, and ${ removed } leaves the project.` : `${ projectName } will work in ${ next } from now on.`;
    const disk = removed ? 'Nothing is moved, copied or deleted.' : 'Nothing is moved or copied.';

    return `${ move } ${ disk } An agent that worked in the old main folder starts a new conversation, so what it remembered may not carry over.`;
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

/** What removing a project deletes, and that its folders (`paths`) stay, for its confirmation. */
export function removalMessage(name: string, paths: readonly string[], info: Pick<ProjectInfo, 'chats' | 'tasks'> | undefined): string {
    const holds = info && (info.chats > 0 || info.tasks > 0) ? `its ${ [plural(info.chats, 'chat'), plural(info.tasks, 'task')].join(' and ') }, ` : 'its chats and tasks, ';
    const stays = paths.length === 1 ? `The folder ${ paths[0] } and everything in it stay` : `Its ${ paths.length } folders and everything in them stay`;

    return `"${ name }" leaves Clowdy together with ${ holds }and the work of its agents, for good. ${ stays } on your computer.`;
}
