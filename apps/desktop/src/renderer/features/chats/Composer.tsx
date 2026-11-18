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

import type { Chat, ChatId, ChatMode, ProjectId, Run } from '@clowdy/protocol';

const MODES: ReadonlyArray<{ id: ChatMode; name: string }> = [
    { id: 'autopilot', name: 'Autopilot' },
    { id: 'semi', name: 'Semi-manual' },
];

/** What a press on the card's empty parts must leave alone: the controls, which take the press themselves. */
const CONTROLS = 'button, [role="button"], [role="combobox"], [contenteditable="true"], a, input';

/** The height of one line of the field in px, as the card sets it (`--spacing-20`): the field's own minimum is counted in px. */
const LINE_HEIGHT = 20;

/** Where the words typed on the new-chat page are kept: there is no chat id to keep them under yet. */
const NEW_CHAT_DRAFT = '@new-chat';

export interface ComposerProps {
    /** The chat to write to. Absent on the new-chat page, where the first message makes the chat (see `start`). */
    chat: Chat | undefined;
    /** The chat's orchestrator, once the first message started one. While it works the mode stays as it is. */
    run: Run | undefined;
    /** For the new-chat page: the project the chat is made in, and what to do once its first message is sent. */
    start?: { projectId: ProjectId; onStarted: (chatId: ChatId) => void };
    /** How many lines the empty field is tall (it still grows with the text). One by default. */
    minLines?: number;
}

/**
 * The message box: the text on top, below it attach (not built yet), the mode and send. Enter sends, Shift+Enter
 * starts a new line, `@` mentions a task, document or file and `/` asks for a skill. While the orchestrator works and
 * nothing is typed, the send button stops it. Without a chat the first message makes one, so opening the new-chat page
 * again and again leaves no empty chats behind; if the message then fails the chat stays, and the retry goes to it.
 */
export function Composer({ chat, run, start, minLines }: ComposerProps) {
    const root = useRootStore();
    const field = useRef<RichInputHandle>(null);
    const box = useRef<HTMLDivElement>(null);
    const triggers = useMentionTriggers(box);
    const key = chat?.id ?? NEW_CHAT_DRAFT;
    const [doc, setDoc] = useState(() => draftOf(key));
    const [isStopping, setIsStopping] = useState(false);
    const [draftMode, setDraftMode] = useState<ChatMode>('autopilot');
    // The chat a first message made, when sending the message then failed.
    const [made, setMade] = useState<Chat>();
    const target = chat ?? made;
    const running = isRunActive(run);

    const edit = (next: ComposerDoc) => {
        setDoc(next);
        saveDraft(key, next);
    };

    const send = async (from: ComposerDoc) => {
        const message = messageOf(from);

        if (!message) return;

        edit(emptyComposerDoc());

        // Give the words back, unless the person has already started something new.
        const giveBack = () => {
            if (!messageOf(draftOf(key))) edit(from);
        };
        let chatId = target?.id;

        if (!chatId) {
            if (!start) return;

            const created = await perform(root, { type: 'chat.create', projectId: start.projectId, mode: draftMode });
            const fresh = (created.ok ? created.data : {}) as { chat?: Chat };

            if (!fresh.chat) {
                giveBack();

                return;
            }

            setMade(fresh.chat);
            chatId = fresh.chat.id;
        }

        // The daemon decides what a message to a working orchestrator means, so there is no case to handle here.
        const result = await perform(root, { type: 'chat.send', chatId, text: message });

        if (!result.ok) giveBack();
        else if (!chat) {
            setMade(undefined);
            start?.onStarted(chatId);
        }
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
                    autoFocus={ !chat?.orchestratorRunId }
                    className={ styles.field }
                    minHeight={ minLines ? minLines * LINE_HEIGHT : undefined }
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
                                // A chat made by a first message that failed keeps the mode it was made with.
                                isDisabled={ running || (!chat && made !== undefined) }
                                selectedKey={ target?.mode ?? draftMode }
                                onSelectionChange={ (picked: unknown) => {
                                    if (chat) void perform(root, { type: 'chat.setMode', chatId: chat.id, mode: picked as ChatMode });
                                    else setDraftMode(picked as ChatMode);
                                } }
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
