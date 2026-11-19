import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';

import { hotkeys } from '../../hotkeys/registry';
import { busyEnter } from '../chats/busyEnter';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { QueuedMessageMode } from '@clowdy/protocol';

const CHOICES: ReadonlyArray<{ id: QueuedMessageMode; label: string }> = [
    { id: 'steer', label: 'Steer the current turn' },
    { id: 'queue', label: 'Queue for the next turn' },
];

/** Settings > Chat: how the message box sends on this computer. */
export function ChatPage() {
    return (
        <SettingsPage title="Chat" description="How the message box works on this computer">
            <SettingsSection title="Messages while the agent works">
                <SettingsCard>
                    <SettingsRow
                        title="Enter while the agent works"
                        description={ `A steer reaches the agent during its turn, when the agent can take one; a queued message waits until the turn ends. ${ hotkeys.platform === 'darwin' ? 'Cmd' : 'Ctrl' }+Enter does the other.` }
                        stacked
                    >
                        <ToggleButtonGroup
                            aria-label="Enter while the agent works"
                            size="sm"
                            selectedKeys={ [busyEnter.mode] }
                            onSelectionChange={ (keys) => {
                                const next = CHOICES.find(choice => keys.has(choice.id));

                                if (next) busyEnter.setMode(next.id);
                            } }
                        >
                            { CHOICES.map(choice => <ToggleButtonGroupItem key={ choice.id } value={ choice.id }>{ choice.label }</ToggleButtonGroupItem>) }
                        </ToggleButtonGroup>
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
