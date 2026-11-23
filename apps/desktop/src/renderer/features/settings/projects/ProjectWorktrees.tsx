import { Button } from '@clowdy/components/Button';

import { useRootStore } from '../../../stores';
import { openManageWorktrees } from '../../worktrees';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsRow } from '../ui/SettingsRow';
import { SettingsSection } from '../ui/SettingsSection';

import type { Project } from '@clowdy/protocol';

/**
 * The Worktrees block of a project's page: one button that opens Manage worktrees for the whole project, every folder's worktrees in one window with the chats that work in
 * each (not a window per folder: the dialog has a group for each folder, and the folder's own settings are the gear in the list above). The window works over Settings; its
 * actions that leave (a new chat, a chat) take the person to the project with Settings shut. The personal space has no worktrees to manage.
 */
export function ProjectWorktrees({ project }: { project: Project }) {
    const root = useRootStore();

    if (project.personal) return null;

    return (
        <SettingsSection title="Worktrees">
            <SettingsCard>
                <SettingsRow title="Worktrees" description="Every worktree of the project's folders, and the chats that work in each">
                    <Button variant="filling" color="secondary" size="sm" onPress={ () => openManageWorktrees({ root, projectId: project.id }) }>Manage worktrees</Button>
                </SettingsRow>
            </SettingsCard>
        </SettingsSection>
    );
}
