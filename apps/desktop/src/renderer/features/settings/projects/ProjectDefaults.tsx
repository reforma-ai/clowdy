import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';

import { useAgents, useRootStore } from '../../../stores';
import { providerAgents } from '../providers/providerView';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsRow } from '../ui/SettingsRow';
import { SettingsSection } from '../ui/SettingsSection';
import { setProjectDefaults } from './projectActions';

import type { ChatMode, Project } from '@clowdy/protocol';

/** The key of "Last used", for the agent and for the mode: nothing chosen, so a new chat starts where the last one left off. It cannot be an agent's id, which never starts with `~`. */
const LAST_USED = '~last-used';

const MODES: ReadonlyArray<{ id: ChatMode; label: string }> = [
    { id: 'autopilot', label: 'Hands-off' },
    { id: 'semi', label: 'Hands-on' },
];

/**
 * What a new chat in this project starts with: the agent that answers it and how much it decides alone. "Last used" (nothing saved) starts
 * it where the last chat left off, on this machine; a chat can still choose for itself.
 */
export function ProjectDefaults({ project }: { project: Project }) {
    const root = useRootStore();
    const { agents } = useAgents();
    const providers = providerAgents(agents);
    const engine = project.settings.engine;
    // An agent the daemon runs that has no card on the Providers page (or is gone) still shows, so what is saved is never hidden.
    const unlisted = engine && !providers.some(agent => agent.id === engine) ? engine : undefined;

    return (
        <SettingsSection title="New chats">
            <SettingsCard divided>
                <SettingsRow title="Agent" description="The agent a new chat starts with. Last used keeps the one you picked in your previous chat." stacked>
                    <ToggleButtonGroup
                        aria-label="Agent for new chats"
                        size="sm"
                        selectedKeys={ [engine ?? LAST_USED] }
                        onSelectionChange={ (keys) => {
                            const next = [...keys][0];

                            if (typeof next !== 'string' || next === (engine ?? LAST_USED)) return;

                            void setProjectDefaults(root, project, { engine: next === LAST_USED ? null : next });
                        } }
                    >
                        <ToggleButtonGroupItem value={ LAST_USED }>Last used</ToggleButtonGroupItem>
                        { providers.map(agent => (
                            <ToggleButtonGroupItem key={ agent.id } value={ agent.id } isDisabled={ agent.status !== 'ready' && agent.id !== engine }>{ agent.name }</ToggleButtonGroupItem>
                        )) }
                        { unlisted && <ToggleButtonGroupItem value={ unlisted }>{ unlisted }</ToggleButtonGroupItem> }
                    </ToggleButtonGroup>
                </SettingsRow>

                <SettingsRow title="Mode" description="How much a new chat decides on its own. Last used keeps the mode of your previous chat." stacked>
                    <ToggleButtonGroup
                        aria-label="Mode for new chats"
                        size="sm"
                        selectedKeys={ [project.settings.chatMode ?? LAST_USED] }
                        onSelectionChange={ (keys) => {
                            const next = [...keys][0];

                            if (typeof next !== 'string' || next === (project.settings.chatMode ?? LAST_USED)) return;

                            const mode = MODES.find(candidate => candidate.id === next);

                            void setProjectDefaults(root, project, { chatMode: mode?.id ?? null });
                        } }
                    >
                        <ToggleButtonGroupItem value={ LAST_USED }>Last used</ToggleButtonGroupItem>
                        { MODES.map(mode => <ToggleButtonGroupItem key={ mode.id } value={ mode.id }>{ mode.label }</ToggleButtonGroupItem>) }
                    </ToggleButtonGroup>
                </SettingsRow>
            </SettingsCard>
        </SettingsSection>
    );
}
