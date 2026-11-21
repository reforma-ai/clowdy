import { Switch } from '@clowdy/components/Switch';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { LAST_USED, type QueuedMessageMode } from '@clowdy/protocol';

import { hotkeys } from '../../hotkeys/registry';
import { busyEnter } from '../chats/busyEnter';
import { newChatDefaults } from '../chats/newChatDefaults';
import { swipeToReply } from '../chats/swipeReplyPreference';
import { modeOf, NewChatChoices } from './NewChatChoices';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

const LABEL = 'Send a message while the agent is working';
const SWIPE_LABEL = 'Swipe a message to reply';

/** The other way of sending, which the row's description names: Cmd+Enter on macOS, Ctrl+Enter elsewhere. */
const OTHER_KEY = hotkeys.platform === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter';

const CHOICES: ReadonlyArray<{ id: QueuedMessageMode; label: string; tip: string }> = [
    { id: 'steer', label: 'Steer', tip: 'Steer sends your message as soon as the agent can receive it' },
    { id: 'queue', label: 'Queue', tip: 'Waits until the agent finishes its current turn' },
];

/** Settings > Chat: how the message box sends, whether a swipe over a message replies to it, and what a new chat starts with where its project follows the app, on this computer. */
export function ChatPage() {
    return (
        <SettingsPage title="Chat" description="Choose how chats look and behave">
            <SettingsSection title="Messages">
                <SettingsCard>
                    <SettingsRow title={ LABEL } description={ `Steer it into the current turn, or queue it for the next one. Press ${ OTHER_KEY } to use the other option.` }>
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

                    <SettingsRow title={ SWIPE_LABEL } description="Scroll sideways over a message to reply to it">
                        <Switch size="sm" isSelected={ swipeToReply.enabled } aria-label={ SWIPE_LABEL } onChange={ enabled => swipeToReply.setEnabled(enabled) } />
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>

            <NewChatChoices
                engine={ newChatDefaults.engine ?? LAST_USED }
                mode={ newChatDefaults.mode ?? LAST_USED }
                onEngineChange={ next => newChatDefaults.setEngine(next === LAST_USED ? undefined : next) }
                onModeChange={ next => newChatDefaults.setMode(modeOf(next)) }
            />
        </SettingsPage>
    );
}
