import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { LAST_USED } from '@clowdy/protocol';

import { useAgents } from '../../stores';
import { providerAgents } from './providers/providerView';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { ChatMode } from '@clowdy/protocol';

/** The key of "Default", a project's first choice: it follows the app's own (Settings > Chat) and saves nothing. Like `LAST_USED`, never an agent's id. */
export const FOLLOW_APP = '~default';

const MODES: ReadonlyArray<{ id: ChatMode; label: string }> = [
    { id: 'autopilot', label: 'Hands-off' },
    { id: 'semi', label: 'Hands-on' },
];

export interface NewChatChoicesProps {
    /** What is chosen: an agent's id, `LAST_USED`, or `FOLLOW_APP` where it is offered. */
    engine: string;
    /** A mode, `LAST_USED`, or `FOLLOW_APP` where it is offered. */
    mode: string;
    onEngineChange: (next: string) => void;
    onModeChange: (next: string) => void;
    /** A project's choices: Default comes first and follows the app's. */
    followsApp?: boolean;
}

/**
 * The New chats section, the same on Settings > Chat (the app's choice) and on a project's page (its own, or Default): the agent a new chat starts
 * with and how much it decides alone. "Last used" starts it where the last chat left off on this computer; a chat can still choose for itself.
 */
export function NewChatChoices({ engine, mode, onEngineChange, onModeChange, followsApp = false }: NewChatChoicesProps) {
    const { agents } = useAgents();
    const providers = providerAgents(agents);
    // An agent the daemon runs that has no card on the Providers page (or is gone) still shows, so what is saved is never hidden.
    const unlisted = engine !== FOLLOW_APP && engine !== LAST_USED && !providers.some(agent => agent.id === engine) ? engine : undefined;
    const defaultHint = followsApp ? 'Default follows Settings > Chat, ' : '';

    return (
        <SettingsSection title="New chats">
            <SettingsCard divided>
                <SettingsRow title="Agent" description={ `The agent a new chat starts with. ${ defaultHint }Last used keeps the one you picked in your previous chat.` } stacked>
                    <ToggleButtonGroup
                        aria-label="Agent for new chats"
                        size="sm"
                        selectedKeys={ [engine] }
                        onSelectionChange={ (keys) => {
                            const next = [...keys][0];

                            if (typeof next === 'string' && next !== engine) onEngineChange(next);
                        } }
                    >
                        { followsApp && <ToggleButtonGroupItem value={ FOLLOW_APP }>Default</ToggleButtonGroupItem> }
                        <ToggleButtonGroupItem value={ LAST_USED }>Last used</ToggleButtonGroupItem>
                        { providers.map(agent => (
                            <ToggleButtonGroupItem key={ agent.id } value={ agent.id } isDisabled={ agent.status !== 'ready' && agent.id !== engine }>{ agent.name }</ToggleButtonGroupItem>
                        )) }
                        { unlisted && <ToggleButtonGroupItem value={ unlisted }>{ unlisted }</ToggleButtonGroupItem> }
                    </ToggleButtonGroup>
                </SettingsRow>

                <SettingsRow title="Mode" description={ `How much a new chat decides on its own. ${ defaultHint }Last used keeps the mode of your previous chat.` } stacked>
                    <ToggleButtonGroup
                        aria-label="Mode for new chats"
                        size="sm"
                        selectedKeys={ [mode] }
                        onSelectionChange={ (keys) => {
                            const next = [...keys][0];

                            if (typeof next === 'string' && next !== mode) onModeChange(next);
                        } }
                    >
                        { followsApp && <ToggleButtonGroupItem value={ FOLLOW_APP }>Default</ToggleButtonGroupItem> }
                        <ToggleButtonGroupItem value={ LAST_USED }>Last used</ToggleButtonGroupItem>
                        { MODES.map(choice => <ToggleButtonGroupItem key={ choice.id } value={ choice.id }>{ choice.label }</ToggleButtonGroupItem>) }
                    </ToggleButtonGroup>
                </SettingsRow>
            </SettingsCard>
        </SettingsSection>
    );
}

/** The mode a choice names, or nothing for "Last used" and "Default". */
export function modeOf(key: string): ChatMode | undefined {
    return MODES.find(choice => choice.id === key)?.id;
}
