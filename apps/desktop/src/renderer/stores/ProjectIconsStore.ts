import { mainFolder, NO_PROJECT_ICON } from '@clowdy/protocol';
import { makeAutoObservable, runInAction } from 'mobx';

import type { Project, ProjectId } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

/** What the daemon found in a project's main folder: the folder it looked in, and the icon as a `blob:` URL (`null`: it has none). */
interface FoundIcon {
    folder: string;
    url: string | null;
}

/** Whether the project shows a picture the person uploaded (a data URL), which needs no icon from its folder. */
function uploaded(project: Project): boolean {
    const { icon } = project.settings;

    return icon !== undefined && icon !== NO_PROJECT_ICON;
}

/**
 * The icons of the projects: the picture the person uploaded, which comes with the project, else the icon the daemon finds in the main
 * folder, read once per main folder while the app runs (`load`), else none, and the app draws the folder icon.
 */
export class ProjectIconsStore {
    /** By project. Kept while the app runs; a new main folder is read again. */
    private readonly found = new Map<ProjectId, FoundIcon>();
    /** The main folder each project is being read for, so a component asking while a read runs does not start another one. */
    readonly #reading = new Map<ProjectId, string>();

    constructor(private readonly transport: Transport) {
        makeAutoObservable<ProjectIconsStore, 'transport'>(this, { transport: false });
    }

    /**
     * Whether the project needs the icon of its main folder: to show it, and for Settings to offer it back after the person removed the icon.
     * A project with a picture of its own and the personal space do not.
     */
    wantsFound(project: Project): boolean {
        return !project.personal && !uploaded(project);
    }

    /**
     * Reads the icon of the project's main folder, unless it was read for that folder already or is being read. A read that fails leaves
     * nothing, so the next component that asks tries again.
     */
    async load(projectId: ProjectId, folder: string): Promise<void> {
        if (this.found.get(projectId)?.folder === folder) {
            // The project is back on the folder it had: a read for the folder it had in between is out of date.
            this.#reading.delete(projectId);

            return;
        }

        if (this.#reading.get(projectId) === folder) return;

        this.#reading.set(projectId, folder);

        let url: string | null | undefined;

        try {
            const blob = await this.transport.getProjectIcon(projectId);

            url = blob ? URL.createObjectURL(blob) : null;
        }
        catch {
            url = undefined;
        }

        // The main folder changed while this read ran: the newer read keeps the answer.
        if (this.#reading.get(projectId) !== folder) {
            if (url) URL.revokeObjectURL(url);

            return;
        }

        this.#reading.delete(projectId);

        if (url === undefined) return;

        runInAction(() => {
            const before = this.found.get(projectId)?.url;

            if (before) URL.revokeObjectURL(before);

            this.found.set(projectId, { folder, url });
        });
    }

    /** The icon found in the project's main folder: a `blob:` URL, `null` when it has none, `undefined` until the daemon answered for this folder. */
    foundIcon(project: Project): string | null | undefined {
        const found = this.found.get(project.id);

        return found?.folder === mainFolder(project).path ? found.url : undefined;
    }

    /**
     * The picture the project shows: the one the person uploaded, else the one found in its main folder. `undefined` means the folder icon:
     * no picture, one not read yet, an icon the person removed (`NO_PROJECT_ICON`), and the personal space.
     */
    src(project: Project): string | undefined {
        if (project.personal || project.settings.icon === NO_PROJECT_ICON) return undefined;

        return project.settings.icon ?? this.foundIcon(project) ?? undefined;
    }
}
