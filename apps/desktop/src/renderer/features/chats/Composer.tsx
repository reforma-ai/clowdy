import { Button } from '@clowdy/components/Button';
import { ListBoxItem } from '@clowdy/components/List';
import { emptyComposerDoc, RichInput, type ComposerDoc, type RichInputHandle } from '@clowdy/components/RichInput';
import { Select } from '@clowdy/components/Select';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Clip } from '@clowdy/icons/14';
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { useRootStore } from '../../stores';
import { isRunActive } from './chatRun';
import { perform } from './commands';
import styles from './Composer.module.css';
import { draftOf, messageOf, saveDraft } from './composerDrafts';
import { serializeMention } from './composerMentions';
import { ComposerSend } from './ComposerSend';
import { MentionChip } from './MentionChip';
import { useMentionTriggers } from './useMentionTriggers';

import type { Chat, ChatMode, Run } from '@clowdy/protocol';

const MODES: ReadonlyArray<{ id: ChatMode; name: string }> = [
    { id: 'autopilot', name: 'Autopilot' },
    { id: 'semi', name: 'Semi-manual' },
];

/** What a press on the card's empty parts must leave alone: the controls, which take the press themselves. */
const CONTROLS = 'button, [role="button"], [role="combobox"], [contenteditable="true"], a, input';

export interface ComposerProps {
    chat: Chat;
    /** The chat's orchestrator, once the first message started one. While it works the mode stays as it is. */
    run: Run | undefined;
}

/**
 * The message box: the text on top, below it attach (not built yet), the mode and send. Enter sends, Shift+Enter
 * starts a new line, `@` mentions a task, document or file and `/` asks for a skill. While the orchestrator works and
 * nothing is typed, the send button stops it.
 */
export function Composer({ chat, run }: ComposerProps) {
    const root = useRootStore();
    const field = useRef<RichInputHandle>(null);
    const box = useRef<HTMLDivElement>(null);
    const triggers = useMentionTriggers(box);
    const [doc, setDoc] = useState(() => draftOf(chat.id));
    const [isStopping, setIsStopping] = useState(false);
    const running = isRunActive(run);

    const edit = (next: ComposerDoc) => {
        setDoc(next);
        saveDraft(chat.id, next);
    };

    const send = async (from: ComposerDoc) => {
        const message = messageOf(from);

        if (!message) return;

        edit(emptyComposerDoc());

        // The daemon decides what a message to a working orchestrator means, so there is no case to handle here.
        const result = await perform(root, { type: 'chat.send', chatId: chat.id, text: message });

        // Give the words back, unless the person has already started something new.
        if (!result.ok && !messageOf(draftOf(chat.id))) edit(from);
    };

    const stop = async () => {
        if (!run) return;

        setIsStopping(true);
        await perform(root, { type: 'run.cancel', runId: run.id });
        setIsStopping(false);
    };

    // A press on the card's own space puts the caret in the text, as in any input; the controls keep their presses.
    // A press inside the mode list bubbles here through its portal without being on the card: it is the list's own.
    const focusField = (event: MouseEvent) => {
        const target = event.target as HTMLElement;

        if (!event.currentTarget.contains(target) || target.closest(CONTROLS)) return;

        event.preventDefault();
        field.current?.focus();
    };

    return (
        <div ref={ box } className={ styles.surface }>
            { /* The field is the keyboard way in; this only gives the mouse the whole card. */ }
            <div className={ styles.main } onMouseDown={ focusField }>
                <RichInput
                    ref={ field }
                    value={ doc }
                    onChange={ edit }
                    triggers={ triggers }
                    renderMention={ MentionChip }
                    serializeMention={ serializeMention }
                    autoFocus={ !chat.orchestratorRunId }
                    className={ styles.field }
                    aria-label="Message"
                    placeholder="Write a message…"
                    submitOnEnter
                    onSubmit={ next => void send(next) }
                />

                <div className={ styles.row }>
                    <Unavailable label="Attach a file" hint="Attachments are not available yet">
                        <Button variant="filling" color="secondary" size="sm" iconOnly isDisabled aria-hidden>
                            <Clip />
                        </Button>
                    </Unavailable>

                    <div className={ styles.end }>
                        <Unavailable label="Mode" hint={ running ? 'The mode stays as it is while the orchestrator works' : undefined }>
                            <Select
                                aria-label="Mode"
                                size="sm"
                                variant="transparent"
                                placement="top"
                                className={ styles.mode }
                                items={ MODES }
                                isDisabled={ running }
                                selectedKey={ chat.mode }
                                onSelectionChange={ (key: unknown) => void perform(root, { type: 'chat.setMode', chatId: chat.id, mode: key as ChatMode }) }
                            >
                                { mode => <ListBoxItem id={ mode.id } text={ mode.name } /> }
                            </Select>
                        </Unavailable>

                        <ComposerSend
                            canSend={ messageOf(doc) !== '' }
                            running={ running }
                            isStopping={ isStopping }
                            onSend={ () => {
                                void send(doc);
                                // The button is off once the text is gone; the caret goes back to the field.
                                field.current?.focus();
                            } }
                            onStop={ () => void stop() }
                        />
                    </div>
                </div>
            </div>
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
