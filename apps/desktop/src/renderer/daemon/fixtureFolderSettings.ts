import { fail, type Outcome, ok } from './fixtureOutcome';

import type { FolderSettings, Project } from '@clowdy/protocol';
import type { CommandInput } from './transport';

type FolderSettingsPatch = Extract<CommandInput, { type: 'project.updateFolder' }>['settings'];

/** A file the setup may copy, as far as the fixture checks it: relative to the folder, with no `..` and no `\`. The daemon's own rules are stricter (`domain/folderSettings.ts`). */
const isInside = (file: string) =>
    !/^([/\\]|[a-z]:)/i.test(file) &&
    !file.includes('\\') &&
    !file.split('/').some(part => part === '' || part === '.' || part === '..');

/**
 * What the daemon does for `project.updateFolder` on a fixture project: a field left out stays, `null` clears it, a setup with no files and no command is none, and a
 * folder with nothing left has no `settings`. The folder is changed in place. Answers `{ project }`, or the refusal.
 */
export function applyFolderSettings(
    project: Project | undefined,
    folderId: string,
    patch: FolderSettingsPatch
): Outcome {
    if (!project) return fail('not_found', 'No such project');

    if (project.personal) return fail('conflict', 'The personal space has no worktrees to set up');

    const folder = project.folders.find(candidate => candidate.id === folderId);

    if (!folder) return fail('not_found', `Folder ${folderId} does not exist`);

    const settings: FolderSettings = { ...folder.settings };

    if (patch.baseBranch === null) {
        delete settings.baseBranch;
    } else if (patch.baseBranch !== undefined) {
        if (!patch.baseBranch.trim()) return fail('invalid', 'The base branch is empty');

        settings.baseBranch = patch.baseBranch.trim();
    }

    if (patch.setup !== undefined) {
        const files = (patch.setup?.files ?? []).map(file => file.trim());
        const command = patch.setup?.command?.trim();
        const outside = files.find(file => !file || !isInside(file));

        if (outside !== undefined)
            return fail('invalid', `The file ${JSON.stringify(outside)} must be relative to the folder`);

        if (files.length > 0 || command) {
            settings.setup = { files, ...(command && { command }) };
        } else {
            delete settings.setup;
        }
    }

    if (Object.keys(settings).length > 0) {
        folder.settings = settings;
    } else {
        delete folder.settings;
    }

    return ok({ project: structuredClone(project) });
}
