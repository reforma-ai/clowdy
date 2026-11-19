import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';

import { hotkeys } from '../../hotkeys/registry';
import { busyEnter } from '../chats/busyEnter';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { QueuedMessageMode } from '@clowdy/protocol';

const LABEL = 'Send a message while the agent is working';

/** The other way of sending, which each choice's tip names: Cmd+Enter on macOS, Ctrl+Enter elsewhere. */
const OTHER_KEY = hotkeys.platform === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter';

const CHOICES: ReadonlyArray<{ id: QueuedMessageMode; label: string; tip: string }> = [
    { id: 'steer', label: 'Steer', tip: `Steer sends your message as soon as the agent can receive it. Press ${ OTHER_KEY } to add to the queue.` },
    { id: 'queue', label: 'Queue', tip: `Waits until the agent finishes its current turn. Press ${ OTHER_KEY } to steer.` },
];

/** Settings > Chat: how the message box sends on this computer. */
export function ChatPage() {
    return (
        <SettingsPage title="Chat" description="Choose how chats look and behave">
            <SettingsSection title="Messages">
                <SettingsCard>
                    <SettingsRow title={ LABEL } description="Steer it into the current turn, or queue it for the next one">
                        <ToggleButtonGroup
                            aria-label={ LABEL }
                            size="sm"
                            selectedKeys={ [busyEnter.mode] }
                            onSelectionChange={ (keys) => {
                                const next = CHOICES.find(choice => keys.has(choice.id));

                                if (next) busyEnter.setMode(next.id);
                            } }
                        >
                            { CHOICES.map(choice => (
                                <ToggleButtonGroupItem key={ choice.id } value={ choice.id } tooltip={ choice.tip }>
                                    { choice.label }
                                </ToggleButtonGroupItem>
                            )) }
                        </ToggleButtonGroup>
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
