import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Switch } from '@clowdy/components/Switch';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { LAST_USED, type QueuedMessageMode } from '@clowdy/protocol';

import { hotkeys } from '../../hotkeys/registry';
import { chatListPreferences } from '../agents/chatListPreferences';
import { busyEnter } from '../chats/busyEnter';
import { composerBannerPreferences } from '../chats/composerBannerPreferences';
import { newChatDefaults } from '../chats/newChatDefaults';
import { swipeToReply } from '../chats/swipeReplyPreference';
import { modeOf, NewChatChoices } from './NewChatChoices';
import { SharedAgentSwitch } from './SharedAgentSwitch';
import { SleepSettings } from './SleepSettings';

/** The other way of sending, which the row's description names: Cmd+Enter on macOS, Ctrl+Enter elsewhere. */
const OTHER_KEY = hotkeys.platform === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter';

const CHOICES: ReadonlyArray<{ id: QueuedMessageMode; label: string; tip: string }> = [
    { id: 'steer', label: 'Steer', tip: 'Steer sends your message as soon as the agent can receive it' },
    { id: 'queue', label: 'Queue', tip: 'Waits until the agent finishes its current turn' },
];

/**
 * Settings > Chat: how the message box sends, whether a swipe over a message replies to it, what a new chat starts with where its project follows the app,
 * how sleep behaves during agent work, and how the Agents list looks, on this computer.
 */
export function ChatPage() {
    return (
        <SettingsLayout.Page description="Choose how chats look and behave">
            <SettingsLayout.Section title="Messages">
                <SettingsLayout.Card>
                    <SharedAgentSwitch
                        id="promptSuggestions"
                        title="Suggest next messages"
                        description="Let supported agents suggest your next message in new sessions"
                    />
                    <SettingsLayout.Row
                        title="Send a message while the agent is working"
                        description={`Steer it into the current turn, or queue it for the next one. Press ${OTHER_KEY} to use the other option.`}
                    >
                        <ToggleButtonGroup
                            size="sm"
                            selectedKeys={[busyEnter.mode]}
                            onSelectionChange={keys => {
                                const next = CHOICES.find(choice => keys.has(choice.id));

                                if (next) busyEnter.setMode(next.id);
                            }}
                        >
                            {CHOICES.map(choice => (
                                <ToggleButtonGroupItem key={choice.id} value={choice.id} tooltip={choice.tip}>
                                    {choice.label}
                                </ToggleButtonGroupItem>
                            ))}
                        </ToggleButtonGroup>
                    </SettingsLayout.Row>

                    <SettingsLayout.Row
                        title="Swipe a message to reply"
                        description="Swipe left over a message and let go to reply to it"
                    >
                        <Switch
                            size="sm"
                            isSelected={swipeToReply.enabled}
                            onChange={enabled => swipeToReply.setEnabled(enabled)}
                        />
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>

            <NewChatChoices
                engine={newChatDefaults.engine ?? LAST_USED}
                mode={newChatDefaults.mode ?? LAST_USED}
                onEngineChange={next => newChatDefaults.setEngine(next === LAST_USED ? undefined : next)}
                onModeChange={next => newChatDefaults.setMode(modeOf(next))}
            />

            <SleepSettings />

            <SettingsLayout.Section title="Above the composer">
                <SettingsLayout.Card>
                    <SettingsLayout.Row
                        title="Show last run changes"
                        description="Show changed files above the message box after the agent finishes"
                    >
                        <Switch
                            size="sm"
                            isSelected={composerBannerPreferences.showChanges}
                            onChange={show => composerBannerPreferences.setShowChanges(show)}
                        />
                    </SettingsLayout.Row>
                    <SettingsLayout.Row
                        title="Show tasks"
                        description="Show the chat's tasks and their progress above the message box"
                    >
                        <Switch
                            size="sm"
                            isSelected={composerBannerPreferences.showTasks}
                            onChange={show => composerBannerPreferences.setShowTasks(show)}
                        />
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>

            <SettingsLayout.Section title="Agents list">
                <SettingsLayout.Card>
                    <SettingsLayout.Row
                        title="Show completed threads"
                        description="Show completed threads below the chat that started them"
                    >
                        <Switch
                            size="sm"
                            isSelected={chatListPreferences.showFinishedThreads}
                            onChange={show => chatListPreferences.setShowFinishedThreads(show)}
                        />
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>
        </SettingsLayout.Page>
    );
}
