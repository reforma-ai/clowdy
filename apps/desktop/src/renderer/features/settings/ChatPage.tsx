import { Switch } from '@clowdy/components/Switch';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { LAST_USED, type QueuedMessageMode } from '@clowdy/protocol';

import { hotkeys } from '../../hotkeys/registry';
import { chatListPreferences, type ChatSort } from '../agents/chatListPreferences';
import { busyEnter } from '../chats/busyEnter';
import { newChatDefaults } from '../chats/newChatDefaults';
import { modeOf, NewChatChoices } from './NewChatChoices';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

const LABEL = 'Send a message while the agent is working';

/** The other way of sending, which the row's description names: Cmd+Enter on macOS, Ctrl+Enter elsewhere. */
const OTHER_KEY = hotkeys.platform === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter';

const CHOICES: ReadonlyArray<{ id: QueuedMessageMode; label: string; tip: string }> = [
    { id: 'steer', label: 'Steer', tip: 'Steer sends your message as soon as the agent can receive it' },
    { id: 'queue', label: 'Queue', tip: 'Waits until the agent finishes its current turn' },
];

const SORTS: ReadonlyArray<{ id: ChatSort; label: string; tip: string }> = [
    { id: 'activity', label: 'Last activity', tip: 'A chat that gets a message goes to the top' },
    { id: 'created', label: 'Created', tip: 'Newest chats first, whatever happens in them' },
];

const SORT_LABEL = 'Sort chats by';
const FINISHED_LABEL = 'Finished threads';

/** Settings > Chat: how the message box sends, what a new chat starts with where its project follows the app, and how the Agents list looks, on this computer. */
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
                </SettingsCard>
            </SettingsSection>

            <NewChatChoices
                engine={ newChatDefaults.engine ?? LAST_USED }
                mode={ newChatDefaults.mode ?? LAST_USED }
                onEngineChange={ next => newChatDefaults.setEngine(next === LAST_USED ? undefined : next) }
                onModeChange={ next => newChatDefaults.setMode(modeOf(next)) }
            />

            <SettingsSection title="Agents list">
                <SettingsCard divided>
                    <SettingsRow title={ SORT_LABEL } description="The order of the chats in the Agents list, in every project">
                        <ToggleButtonGroup
                            aria-label={ SORT_LABEL }
                            size="sm"
                            selectedKeys={ [chatListPreferences.sort] }
                            onSelectionChange={ (keys) => {
                                const next = SORTS.find(choice => keys.has(choice.id));

                                if (next) chatListPreferences.setSort(next.id);
                            } }
                        >
                            { SORTS.map(choice => (
                                <ToggleButtonGroupItem key={ choice.id } value={ choice.id } tooltip={ choice.tip }>
                                    { choice.label }
                                </ToggleButtonGroupItem>
                            )) }
                        </ToggleButtonGroup>
                    </SettingsRow>

                    <SettingsRow title={ FINISHED_LABEL } description="List the threads whose run is over, below the chat that started them">
                        <Switch
                            size="sm"
                            aria-label={ FINISHED_LABEL }
                            isSelected={ chatListPreferences.showFinishedThreads }
                            onChange={ show => chatListPreferences.setShowFinishedThreads(show) }
                        />
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
