import { Button } from '@clowdy/components/Button';
import { tooltipWithHotkey } from '@clowdy/components/Hotkey';
import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { Textarea } from '@clowdy/components/Textarea';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Clip } from '@clowdy/icons/14';
import { SendBold } from '@clowdy/icons/16';
import { useState, type ReactNode } from 'react';

import { useRootStore } from '../../stores';
import { perform } from './commands';
import styles from './Composer.module.css';
import { isSendKey } from './composerKeys';

import type { Chat, ChatId, ChatMode } from '@clowdy/protocol';

const MODES: ReadonlyArray<{ id: ChatMode; name: string }> = [
    { id: 'autopilot', name: 'Autopilot' },
    { id: 'semi', name: 'Semi-manual' },
];

/** What was typed and not sent, so that moving to another chat and back does not lose it. */
const drafts = new Map<ChatId, string>();

export interface ComposerProps {
    chat: Chat;
    /** The orchestrator is working: the mode of a started cycle stays as it is. */
    modeLocked: boolean;
}

/** The message box: attach (not built yet), the text, the mode, and send. Enter sends, Shift+Enter starts a new line. */
export function Composer({ chat, modeLocked }: ComposerProps) {
    const root = useRootStore();
    const [text, setText] = useState(() => drafts.get(chat.id) ?? '');
    const message = text.trim();

    const edit = (next: string) => {
        setText(next);
        drafts.set(chat.id, next);
    };

    const send = async () => {
        if (!message) return;

        edit('');

        // The daemon decides what a message to a working orchestrator means, so there is no case to handle here.
        const result = await perform(root, { type: 'chat.send', chatId: chat.id, text: message });

        // Give the words back, unless the person has already started something new.
        if (!result.ok && !drafts.get(chat.id)) edit(message);
    };

    return (
        <div className={ styles.composer }>
            <Unavailable label="Attach a file" hint="Attachments are not available yet">
                <Button variant="filling" color="secondary" size="sm" iconOnly isDisabled aria-hidden>
                    <Clip />
                </Button>
            </Unavailable>

            <Textarea
                variant="inline"
                autoResize
                autoFocus={ !chat.orchestratorRunId }
                className={ styles.field }
                textareaClassName={ styles.input }
                aria-label="Message"
                placeholder="Write a message…"
                value={ text }
                onChange={ edit }
                onKeyDown={ (event) => {
                    if (!isSendKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) return;

                    event.preventDefault();
                    void send();
                } }
            />

            <Unavailable label="Mode" hint={ modeLocked ? 'The mode stays as it is while the orchestrator works' : undefined }>
                <Select
                    aria-label="Mode"
                    size="sm"
                    variant="transparent"
                    placement="top"
                    className={ styles.mode }
                    items={ MODES }
                    isDisabled={ modeLocked }
                    selectedKey={ chat.mode }
                    onSelectionChange={ (key: unknown) => void perform(root, { type: 'chat.setMode', chatId: chat.id, mode: key as ChatMode }) }
                >
                    { mode => <ListBoxItem id={ mode.id } text={ mode.name } /> }
                </Select>
            </Unavailable>

            <Button
                color="primary"
                size="sm"
                iconOnly
                rounded
                isDisabled={ !message }
                aria-label="Send"
                tooltip={ tooltipWithHotkey('Send', 'enter') }
                onPress={ () => void send() }
            >
                <SendBold />
            </Button>
        </div>
    );
}

/**
 * A disabled control that still says why. A disabled button gets no pointer events, so the tooltip sits on a
 * focusable stand-in that does; without a hint the control is shown as it is.
 */
function Unavailable({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    if (!hint) return children;

    return (
        <Tooltip content={ hint } placement="top">
            <span className={ styles.unavailable } role="button" tabIndex={ 0 } aria-disabled aria-label={ label }>{ children }</span>
        </Tooltip>
    );
}
