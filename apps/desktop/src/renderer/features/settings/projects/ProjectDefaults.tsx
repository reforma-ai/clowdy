import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';

import { useAgents, useRootStore } from '../../../stores';
import { providerAgents } from '../providers/providerView';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsRow } from '../ui/SettingsRow';
import { SettingsSection } from '../ui/SettingsSection';
import { setProjectDefaults } from './projectActions';

import type { ChatMode, Project } from '@clowdy/protocol';

/** The key of "Default": no agent chosen, so the daemon picks. It cannot be an agent's id, which never starts with `~`. */
const DEFAULT_AGENT = '~default';

const MODES: ReadonlyArray<{ id: ChatMode; label: string }> = [
    { id: 'autopilot', label: 'Autopilot' },
    { id: 'semi', label: 'Semi-manual' },
];

/** What a new chat in this project starts with: the agent that answers it and how much it decides alone. A chat can still choose for itself. */
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
                <SettingsRow title="Agent" description="The agent a new chat starts with. Default leaves the choice to Clowdy." stacked>
                    <ToggleButtonGroup
                        aria-label="Agent for new chats"
                        size="sm"
                        selectedKeys={ [engine ?? DEFAULT_AGENT] }
                        onSelectionChange={ (keys) => {
                            const next = [...keys][0];

                            if (typeof next !== 'string' || next === (engine ?? DEFAULT_AGENT)) return;

                            void setProjectDefaults(root, project, { engine: next === DEFAULT_AGENT ? null : next });
                        } }
                    >
                        <ToggleButtonGroupItem value={ DEFAULT_AGENT }>Default</ToggleButtonGroupItem>
                        { providers.map(agent => (
                            <ToggleButtonGroupItem key={ agent.id } value={ agent.id } isDisabled={ agent.status !== 'ready' && agent.id !== engine }>{ agent.name }</ToggleButtonGroupItem>
                        )) }
                        { unlisted && <ToggleButtonGroupItem value={ unlisted }>{ unlisted }</ToggleButtonGroupItem> }
                    </ToggleButtonGroup>
                </SettingsRow>

                <SettingsRow title="Mode" description="Autopilot decides alone. Semi-manual asks you before a significant fork." stacked>
                    <ToggleButtonGroup
                        aria-label="Mode for new chats"
                        size="sm"
                        selectedKeys={ [project.settings.chatMode ?? 'autopilot'] }
                        onSelectionChange={ (keys) => {
                            const next = MODES.find(mode => keys.has(mode.id));

                            if (next && next.id !== (project.settings.chatMode ?? 'autopilot')) void setProjectDefaults(root, project, { chatMode: next.id });
                        } }
                    >
                        { MODES.map(mode => <ToggleButtonGroupItem key={ mode.id } value={ mode.id }>{ mode.label }</ToggleButtonGroupItem>) }
                    </ToggleButtonGroup>
                </SettingsRow>
            </SettingsCard>
        </SettingsSection>
    );
}
