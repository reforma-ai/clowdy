import { Attachments, PreviewableAttachment } from '@clowdy/components/Attachment';
import { Button } from '@clowdy/components/Button';
import { ListBoxItem } from '@clowdy/components/List';
import { emptyComposerDoc, RichInput, type ComposerDoc, type RichInputHandle } from '@clowdy/components/RichInput';
import { Clip } from '@clowdy/icons/14';
import { useImperativeHandle, useRef, useState, type MouseEvent, type Ref } from 'react';

import { useRootStore } from '../../stores';
import { isRunActive } from './chatRun';
import { perform } from './commands';
import styles from './Composer.module.css';
import { draftOf, messageOf, newChatDraftKey, saveDraft } from './composerDrafts';
import { filesOf, releaseFiles, restoreFiles, takeFiles } from './composerFiles';
import { serializeMention } from './composerMentions';
import { ComposerSend } from './ComposerSend';
import { ContextRing } from './ContextRing';
import { MentionChip } from './MentionChip';
import { ModelPicker, ModelPickerOff } from './ModelPicker';
import { ModePicker } from './ModePicker';
import { Unavailable } from './Unavailable';
import { useComposerFiles } from './useComposerFiles';
import { useMentionTriggers } from './useMentionTriggers';
import { NO_PROVIDER_HINT, useModelChoice } from './useModelChoice';

import type { Chat, ChatId, ChatMode, ProjectId, Run } from '@clowdy/protocol';

/** What a press on the card's empty parts must leave alone: the controls, which take the press themselves. */
const CONTROLS = 'button, [role="button"], [role="combobox"], [contenteditable="true"], a, input';

/** The height of one line of the field in px, as the card sets it (`--spacing-20`): the field's own minimum is counted in px. */
const LINE_HEIGHT = 20;

/** What a page around the composer may ask of it. */
export interface ComposerHandle {
    /** Adds files to the message, as if they were picked with the attach button. */
    addFiles: (files: readonly File[]) => void;
}

export interface ComposerProps {
    /** The chat to write to. Absent on the new-chat page, where the first message makes the chat (see `start`). */
    chat: Chat | undefined;
    /** The chat's orchestrator, once the first message started one. While it works the mode stays as it is. */
    run: Run | undefined;
    /** For the new-chat page: the project the chat is made in, and what to do once its first message is sent. */
    start?: { projectId: ProjectId; onStarted: (chatId: ChatId) => void };
    /** How many lines the empty field is tall (it still grows with the text). One by default. */
    minLines?: number;
    ref?: Ref<ComposerHandle>;
}

/**
 * The message box: the files picked for the message and the text on top, below them attach, the model and its reasoning level, the
 * mode and send. Enter sends, Shift+Enter starts a new line, `@` mentions a task, document or file and `/` asks for a skill. While the
 * orchestrator works and nothing is typed, the send button stops it. Without a chat the first message makes one, on the model the
 * picker holds, so opening the new-chat page again and again leaves no empty chats behind; if the message then fails the chat
 * stays, and the retry goes to it.
 */
export function Composer({ chat, run, start, minLines, ref }: ComposerProps) {
    const root = useRootStore();
    const field = useRef<RichInputHandle>(null);
    const box = useRef<HTMLDivElement>(null);
    const triggers = useMentionTriggers(box);
    // The words and the files of a message box live under one key: the chat's id, or the new-chat page of this project.
    const key = chat?.id ?? newChatDraftKey(start?.projectId);
    // The new-chat page of another project is this same composer drawn again, with words of its own: the state holds the draft last
    // edited, with its key, and any other key is read from the store (which every edit writes first).
    const [shown, setShown] = useState({ key, doc: draftOf(key) });
    const doc = shown.key === key ? shown.doc : draftOf(key);
    const [isStopping, setIsStopping] = useState(false);
    const [draftMode, setDraftMode] = useState<ChatMode>('autopilot');
    // The chat a first message made, when sending the message then failed. It belongs to the project it was made in: the page of
    // another project (the same composer, drawn again) starts its own chat, and a model picked there is not picked for this one.
    const [madeIn, setMade] = useState<Chat>();
    const made = madeIn?.projectId === start?.projectId ? madeIn : undefined;
    const target = chat ?? made;
    const running = isRunActive(run);
    const model = useModelChoice({ chat, made, run });
    const attach = useComposerFiles(key, chat?.projectId ?? start?.projectId);
    const picker = useRef<HTMLInputElement>(null);
    const hasMessage = messageOf(doc) !== '' || attach.files.length > 0;
    // A file still going up, or one that failed, holds the message back until the person has dealt with it.
    const blocked = model.noProvider
        ? NO_PROVIDER_HINT
        : attach.uploading ? 'Wait until the files are uploaded' : attach.failed ? 'Retry or remove the file that did not upload' : undefined;

    useImperativeHandle(ref, () => ({ addFiles: attach.add }), [attach.add]);

    const edit = (next: ComposerDoc) => {
        saveDraft(key, next);
        setShown({ key, doc: next });
    };

    const send = async (from: ComposerDoc) => {
        const message = messageOf(from);
        const held = filesOf(key);

        if ((!message && held.length === 0) || held.some(file => file.status !== 'ready') || model.noProvider) return;

        edit(emptyComposerDoc());

        const files = takeFiles(key);
        // Give the words and the files back, unless the person has already started something new.
        const giveBack = () => {
            if (!messageOf(draftOf(key))) edit(from);

            restoreFiles(key, files);
        };
        let chatId = target?.id;

        if (!chatId) {
            if (!start) {
                giveBack();

                return;
            }

            const { choice } = model;
            // The chat starts on what the picker holds: the provider, its model and the level of that model.
            const created = await perform(root, {
                type: 'chat.create',
                projectId: start.projectId,
                mode: draftMode,
                ...(choice && { engine: choice.engine, ...(choice.model && { model: choice.model }), ...(choice.effort && { effort: choice.effort }) }),
            });
            const fresh = (created.ok ? created.data : {}) as { chat?: Chat };

            if (!fresh.chat) {
                giveBack();

                return;
            }

            setMade(fresh.chat);
            chatId = fresh.chat.id;
        }

        // The daemon decides what a message to a working orchestrator means, so there is no case to handle here.
        const attachmentIds = files.flatMap(file => (file.attachment ? [file.attachment.id] : []));
        const result = await perform(root, { type: 'chat.send', chatId, text: message, ...(attachmentIds.length > 0 && { attachmentIds }) });

        if (!result.ok) {
            giveBack();

            return;
        }

        // The daemon keeps the files now; the message shows them.
        releaseFiles(files);

        if (!chat) {
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
                { attach.files.length > 0 && (
                    <Attachments size="sm" className={ styles.files }>
                        { attach.files.map(file => (
                            <PreviewableAttachment
                                key={ file.key }
                                data={ { id: file.key, filename: file.name, mediaType: file.mediaType, size: file.size, preview: file.preview } }
                                loading={ file.status === 'uploading' }
                                error={ file.status === 'error' }
                                onRetry={ () => attach.retry(file.key) }
                                onRemove={ () => attach.remove(file.key) }
                            />
                        )) }
                    </Attachments>
                ) }

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
                    // Files before text, as the zone around the page does: a file copied in Finder also puts its name on the clipboard as text.
                    onPasteFiles={ attach.add }
                />

                <div className={ styles.row }>
                    <div className={ styles.start }>
                        <Button variant="filling" color="secondary" size="sm" iconOnly aria-label="Attach files" tooltip="Attach files" onPress={ () => picker.current?.click() }>
                            <Clip />
                        </Button>

                        <Unavailable label="Mode" hint={ running ? 'The mode stays as it is while the orchestrator works' : undefined }>
                            <ModePicker
                                mode={ target?.mode ?? draftMode }
                                // A chat made by a first message that failed keeps the mode it was made with.
                                isDisabled={ running || (!chat && made !== undefined) }
                                onPick={ (picked) => {
                                    if (chat) void perform(root, { type: 'chat.setMode', chatId: chat.id, mode: picked });
                                    else setDraftMode(picked);
                                } }
                            />
                        </Unavailable>
                    </div>
                    <input
                        ref={ picker }
                        type="file"
                        multiple
                        hidden
                        aria-hidden
                        tabIndex={ -1 }
                        onChange={ event => {
                            attach.add(Array.from(event.currentTarget.files ?? []));
                            // The same file may be picked again.
                            event.currentTarget.value = '';
                            field.current?.focus();
                        } }
                    />

                    <div className={ styles.end }>
                        <ContextRing chat={ chat } run={ run } />

                        { model.noProvider
                            ? <Unavailable label="Model" hint={ NO_PROVIDER_HINT }><ModelPickerOff /></Unavailable>
                            : <ModelPicker choice={ model.choice } providers={ model.providers } running={ running } onPick={ model.pick } /> }

                        <Unavailable label="Send" hint={ hasMessage ? blocked : undefined }>
                            <ComposerSend
                                canSend={ hasMessage }
                                blocked={ blocked !== undefined }
                                running={ running }
                                isStopping={ isStopping }
                                onSend={ () => {
                                    void send(doc);
                                    // The button is off once the text is gone; the caret goes back to the field.
                                    field.current?.focus();
                                } }
                                onStop={ () => void stop() }
                            />
                        </Unavailable>
                    </div>
                </div>
            </div>
        </div>
    );
}
