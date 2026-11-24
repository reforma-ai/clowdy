import { Attachments, PreviewableAttachment } from '@clowdy/components/Attachment';
import { Button } from '@clowdy/components/Button';
import { ListBoxItem } from '@clowdy/components/List';
import { type ComposerDoc, emptyComposerDoc, RichInput, type RichInputHandle } from '@clowdy/components/RichInput';
import { Clip } from '@clowdy/icons/14';
import { type MouseEvent, type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

import { Unavailable } from '../../shared/Unavailable';
import { useAgents, useProjectState, useRootStore } from '../../stores';
import { folderById } from '../agents/agentTree';
import { chatPlace } from '../sidePanel/currentPlace';
import { branchPrefix } from './branchPrefix';
import { busyEnter, sendMode } from './busyEnter';
import { ChatControls } from './ChatControls';
import styles from './Composer.module.css';
import { ComposerQueue } from './ComposerQueue';
import { ComposerSend } from './ComposerSend';
import { ContextRing } from './ContextRing';
import { readRememberedMode, startingMode, writeRememberedMode } from './chatModeMemory';
import { isRunActive, isRunBusy } from './chatRun';
import { perform } from './commands';
import { useRegisterComposer } from './composerBridge';
import {
    draftOf,
    messageOf,
    newChatDraftKey,
    quotedMessage,
    saveDraft,
    withQuoteLast,
    withTextFirst,
} from './composerDrafts';
import { type DraftFile, filesOf, releaseFiles, restoreFiles, takeFiles } from './composerFiles';
import { serializeMention } from './composerMentions';
import { dropReplyQuote, restoreReplyQuote, setReplyQuote, takeReplyQuote, useReplyQuote } from './composerQuotes';
import { MentionChip } from './MentionChip';
import { ModelPicker, ModelPickerOff } from './ModelPicker';
import { ModePicker } from './ModePicker';
import { pasteFiles } from './pastedFiles';
import { ReplyCard } from './ReplyCard';
import { useComposerFiles } from './useComposerFiles';
import { useMentionTriggers } from './useMentionTriggers';
import { NO_PROVIDER_HINT, useModelChoice } from './useModelChoice';

import type {
    Chat,
    ChatId,
    ChatMode,
    ChatWorkspace,
    ChatWorkspaceChoice,
    CommandResult,
    FolderId,
    ProjectId,
    QueuedMessage,
    Run,
} from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { ReplyMessage } from '../../stream/MessageActions';

/** What a press on the card's empty parts must leave alone: the controls, which take the press themselves. */
const CONTROLS = 'button, [role="button"], [role="combobox"], [contenteditable="true"], a, input';

/** The height of one line of the field in px, as the card sets it (`--spacing-20`): the field's own minimum is counted in px. */
const LINE_HEIGHT = 20;

/** What a page around the composer may ask of it. */
export interface ComposerHandle {
    /** Adds files to the message, as if they were picked with the attach button. */
    addFiles: (files: readonly File[]) => void;
    /** Takes files pasted on the page: the ones that are in the project's folders become chips, and the rest are added as `addFiles` does. */
    pasteFiles: (files: readonly File[]) => void;
    /** Reply to a whole message: it becomes the card above the field (instead of the one that is there), sent as a quote in front of the words, and the field takes the focus. */
    reply: (message: ReplyMessage) => void;
    /** Quote words selected inside a message: adds `text` to the end of the draft as a quote, and puts the caret on the line below it. */
    quote: (text: string) => void;
}

/**
 * The box of an `Editing message` frame: the message box of a message the person sent, which is being edited in place. It is the same box with its
 * own words and files (`draftKey`, so it never shares the chat's draft with the box at the bottom), without what belongs to the chat as a whole (the
 * queue, the mode, the model and the context reading), and what it sends is not a new message: Enter and Cmd/Ctrl+Enter both give the edited words to
 * `onSubmit`, whatever Settings > Chat says of a busy agent, and Escape stops editing. The words and the files stay in the box until the session
 * that opened it ends, so a refused edit is still all there.
 */
export interface EditMode {
    /** The key of the session's words and files (`editDraftKey`): `composerDrafts` and `composerFiles` keep both under it, apart from the chat's own. */
    draftKey: string;
    /** The edited message: its words and the ids of its files. Not called for an empty message, while a file is uploading or has failed, or while the agent works. */
    onSubmit: (message: { text: string; attachmentIds: string[] }) => void;
    /** Escape: stop editing, with nothing sent. */
    onCancel: () => void;
    /** The edit is on its way: Send spins and takes no press. */
    isPending?: boolean;
}

export interface ComposerProps {
    /** The chat to write to. Absent on the new-chat page, where the first message makes the chat (see `start`). */
    chat: Chat | undefined;
    /** The chat's orchestrator, once the first message started one. While it works the mode stays as it is. */
    run: Run | undefined;
    /**
     * For the new-chat page: the project the chat is made in, the folder of it the chat works in (none: the main folder) and where in that folder (`workspace`: a
     * worktree the chat makes or one that exists; none: the folder's own checkout), what to do once its first message is sent, and what the project asks a new chat to
     * start with (its agent and its mode; what it leaves out starts where the last chat left off). `waiting` is why the first message cannot be sent yet, when what it is sent
     * with is not known until an answer comes (the folder's worktrees are being read): the chat is not made, and Send says why. `workspaceRow` is the daemon's row of the
     * worktree `workspace` names when it exists and the page has asked for it (`ProjectUi.draftWorkspaceRow`): the place the box reads for `@`, as the chat will, since the
     * first message makes the chat in that same row.
     */
    start?: {
        projectId: ProjectId;
        folderId?: FolderId;
        workspace?: ChatWorkspaceChoice;
        workspaceRow?: ChatWorkspace;
        /**
         * Wraps the making of the chat (`chat.create`) when the page has something to say of it as it runs: a choice of the folder's own branch is switched by the daemon first, which may take a
         * while and be refused. The wrapper runs `create` and hands back its result, and may show it as it goes; a refusal gives the message back to the box as for any other command.
         */
        around?: (create: () => Promise<CommandResult>) => Promise<CommandResult>;
        waiting?: string;
        onStarted: (chatId: ChatId) => void;
        defaults?: { engine?: string; mode?: ChatMode };
    };
    /** How many lines the empty field is tall (it still grows with the text). One by default. */
    minLines?: number;
    /** The box of an edit frame (see `EditMode`) in place of the chat's message box. */
    editMode?: EditMode;
    /** What the line under the box holds at its start (where the chat works); the mode stands at its end. An edit frame has no line. */
    controls?: ReactNode;
    ref?: Ref<ComposerHandle>;
}

/**
 * The message box: the messages waiting for the orchestrator, the files picked for the message and the text, below them attach, the model and its
 * reasoning level and send, and under the card a line with `controls` at its start and the mode at its end. Enter sends, Shift+Enter starts a new line, `@` mentions a task, document or file and `/` asks for a skill.
 * While the orchestrator works a message waits for it in the chat's queue: Enter steers the running turn or queues the message for the next turn,
 * as Settings > Chat says, and Cmd/Ctrl+Enter does the other; the send button sends the way Enter does, and stops the orchestrator while nothing
 * is typed. Without a chat the first message makes one, on the model the picker holds, so opening the new-chat page again and again leaves no
 * empty chats behind; if the message then fails the chat stays, and the retry goes to it.
 */
export function Composer({ chat, run, start, minLines, editMode, controls, ref }: ComposerProps) {
    const root = useRootStore();
    const field = useRef<RichInputHandle>(null);
    const box = useRef<HTMLDivElement>(null);
    // The words and the files of a message box live under one key: the chat's id, the new-chat page of this project, or the edit session of a message.
    const key = editMode?.draftKey ?? chat?.id ?? newChatDraftKey(start?.projectId);
    // The new-chat page of another project is this same composer drawn again, with words of its own: the state holds the draft last
    // edited, with its key, and any other key is read from the store (which every edit writes first).
    const [shown, setShown] = useState({ key, doc: draftOf(key) });
    const doc = shown.key === key ? shown.doc : draftOf(key);
    const [isStopping, setIsStopping] = useState(false);
    // The mode a new chat starts in: what was picked on this page for this project, else where the project and the last pick say it starts.
    const [rememberedMode, setRememberedMode] = useState(readRememberedMode);
    const [pickedMode, setPickedMode] = useState<{ projectId: ProjectId | undefined; mode: ChatMode }>();
    const draftMode =
        pickedMode && pickedMode.projectId === start?.projectId
            ? pickedMode.mode
            : startingMode(start?.defaults?.mode, rememberedMode);
    // The chat a first message made, when sending the message then failed. It belongs to the project, the folder and the place in it (`where`: its worktree is fixed from
    // the start) it was made for: the page of another project, folder or place (the same composer, drawn again) starts its own chat, and a model picked there is not picked for this one.
    const where = JSON.stringify(start?.workspace ?? null);
    const [madeIn, setMade] = useState<{ chat: Chat; where: string }>();
    const made =
        madeIn?.chat.projectId === start?.projectId &&
        madeIn?.chat.folderId === start?.folderId &&
        madeIn?.where === where
            ? madeIn?.chat
            : undefined;
    const target = chat ?? made;
    const running = isRunActive(run);
    // A message to a busy orchestrator waits in the queue; the box says so, and Send now on a queued message steers.
    const busy = isRunBusy(run);
    const model = useModelChoice({ chat, made, run, preferredEngine: start?.defaults?.engine });
    const attach = useComposerFiles(key, chat?.projectId ?? start?.projectId);
    const { folders } = useProjectState().project;
    // Where the message is read: the chat's folder and its worktree, or the folder of the new chat and the worktree it chose when that exists (a new worktree is made by the first
    // message, so there is none to name before). The `@` menu lists that place's files and documents, and a path in the message is the one the agent reads from its working directory there.
    const place = target
        ? chatPlace(folders, target)
        : {
              folder: folderById(folders, start?.folderId),
              ...(start?.workspaceRow && { workspace: start.workspaceRow }),
          };
    const triggers = useMentionTriggers(box, place);
    // The message the box replies to, shown as a card above the field. The box of an edit frame has none.
    const replyTo = useReplyQuote(key);
    const { agents } = useAgents();
    const agentName = agents.find(agent => agent.id === model.choice?.engine)?.name ?? 'Assistant';
    const picker = useRef<HTMLInputElement>(null);
    const hasMessage = messageOf(doc) !== '' || attach.files.length > 0;
    // A file still going up, or one that failed, holds the message back until the person has dealt with it.
    const uploadHint = attach.uploading
        ? 'Wait until the files are uploaded'
        : attach.failed
          ? 'Retry or remove the file that did not upload'
          : undefined;
    // An edit rewrites the chat from its message, which the daemon does only at rest (the Edit button says so): if the agent starts working while the frame is open,
    // Submit waits for it to stop, as it waits for a file, rather than sending what is refused.
    const blocked = editMode
        ? running
            ? 'Stop the agent to edit'
            : uploadHint
        : model.noProvider
          ? NO_PROVIDER_HINT
          : (uploadHint ?? (target ? undefined : start?.waiting));

    const edit = (next: ComposerDoc) => {
        saveDraft(key, next);
        setShown({ key, doc: next });
    };

    // Reply focuses the field once it holds the quote. The field takes a new draft in its own layout effect, which runs before this one, and the caret that
    // replacing the text leaves is at its end (ProseMirror maps the selection to the end of what replaced it), where `focus` puts it: under the quote.
    const focusAfterQuote = useRef(false);

    useLayoutEffect(() => {
        if (!focusAfterQuote.current) return;

        focusAfterQuote.current = false;
        field.current?.focus();
    });

    const quote = (text: string) => {
        const draft = draftOf(key);
        const next = withQuoteLast(draft, text);

        if (next === draft) return;

        focusAfterQuote.current = true;
        edit(next);
    };

    const reply = (message: ReplyMessage) => {
        setReplyQuote(key, message);
        field.current?.focus();
    };

    const pasted = (files: readonly File[]) =>
        void pasteFiles(files, {
            folders,
            place,
            mention: chip => field.current?.insertMention(chip),
            attach: attach.add,
        });

    useImperativeHandle(ref, () => ({ addFiles: attach.add, pasteFiles: pasted, reply, quote }), [
        attach.add,
        pasted,
        reply,
        quote,
    ]);
    // The side panel's Add to chat quotes code into this box (`composerBridge`); the box of an edit frame is not the one it means.
    useRegisterComposer(editMode ? undefined : quote);

    /** Sends the message; `mod` (Cmd/Ctrl+Enter) sends it the other way than Enter while the orchestrator works. */
    const send = async (from: ComposerDoc, mod = false) => {
        const message = messageOf(from);
        const held = filesOf(key);

        if (
            (!message && held.length === 0) ||
            held.some(file => file.status !== 'ready') ||
            model.noProvider ||
            (!target && start?.waiting !== undefined)
        )
            return;

        edit(emptyComposerDoc());

        const files = takeFiles(key);
        const replied = takeReplyQuote(key);
        // Give the words, the files and the quote back, unless the person has already started something new.
        const giveBack = () => {
            if (!messageOf(draftOf(key))) edit(from);

            restoreFiles(key, files);

            if (replied) restoreReplyQuote(key, replied);
        };
        let chatId = target?.id;

        if (!chatId) {
            if (!start) {
                giveBack();

                return;
            }

            const { choice } = model;
            // The chat starts on what the picker holds: the provider, its model and the level of that model.
            const create = () =>
                perform(root, {
                    type: 'chat.create',
                    projectId: start.projectId,
                    ...(start.folderId && { folderId: start.folderId }),
                    // A copy of the choice (the store keeps the one it holds, and the command is what the transport sends on), with the app's branch prefix for a new worktree.
                    ...(start.workspace && { workspace: branchPrefix.withPrefix(start.workspace) }),
                    mode: draftMode,
                    ...(choice && {
                        engine: choice.engine,
                        ...(choice.model && { model: choice.model }),
                        ...(choice.effort && { effort: choice.effort }),
                    }),
                });
            const created = await (start.around ? start.around(create) : create());
            const fresh = (created.ok ? created.data : {}) as { chat?: Chat };

            if (!fresh.chat) {
                giveBack();

                return;
            }

            setMade({ chat: fresh.chat, where });
            chatId = fresh.chat.id;
        }

        // The daemon decides whether the orchestrator takes the message now or it waits; the mode says how it waits, so it goes with every message.
        const attachmentIds = files.flatMap(file => (file.attachment ? [file.attachment.id] : []));
        const result = await perform(root, {
            type: 'chat.send',
            chatId,
            // The message replied to goes first, as a quote, then a blank line and what was typed.
            text: replied ? quotedMessage(replied.text, message) : message,
            ...(attachmentIds.length > 0 && { attachmentIds }),
            mode: sendMode(busyEnter.mode, mod),
        });

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

    /** Enter in an edit frame: the edited words and files go to the page, which sends them; nothing here is cleared, so a refused edit finds them in the box. */
    const submitEdit = (from: ComposerDoc) => {
        const message = messageOf(from);
        const held = filesOf(key);

        if (
            !editMode ||
            editMode.isPending ||
            running ||
            (!message && held.length === 0) ||
            held.some(file => file.status !== 'ready')
        )
            return;

        editMode.onSubmit({
            text: message,
            attachmentIds: held.flatMap(file => (file.attachment ? [file.attachment.id] : [])),
        });
    };

    /** Edit on a queued message: it has left the queue, and its words go in front of the draft and its files back into the box, uploaded already. */
    const editQueued = (item: QueuedMessage) => {
        edit(withTextFirst(draftOf(key), item.text));

        const files = (item.attachments ?? []).map(
            (attachment): DraftFile => ({
                key: crypto.randomUUID(),
                name: attachment.name,
                mediaType: attachment.mediaType,
                size: attachment.size,
                status: 'ready',
                attachment,
            })
        );

        if (files.length > 0) restoreFiles(key, files);

        field.current?.focus();
    };

    const stop = async () => {
        if (!run) return;

        setIsStopping(true);
        await perform(root, { type: 'run.cancel', runId: run.id });
        setIsStopping(false);
    };

    // A press on the card's own space puts the caret in the text, as in any input; the controls keep their presses.
    // A press inside the model list bubbles here through its portal without being on the card: it is the list's own.
    const focusField = (event: MouseEvent) => {
        const target = event.target as HTMLElement;

        if (!event.currentTarget.contains(target) || target.closest(CONTROLS)) return;

        event.preventDefault();
        field.current?.focus();
    };

    return (
        <>
            <div ref={box} className={styles.surface}>
                {chat && !editMode && <ComposerQueue chat={chat} busy={busy} running={running} onEdit={editQueued} />}

                {/* The field is the keyboard way in; this only gives the mouse the whole card. */}
                <div className={styles.main} onMouseDown={focusField}>
                    {replyTo && !editMode && (
                        <ReplyCard
                            message={replyTo}
                            who={replyTo.role === 'user' ? 'You' : agentName}
                            onRemove={() => {
                                dropReplyQuote(key);
                                field.current?.focus();
                            }}
                        />
                    )}

                    {attach.files.length > 0 && (
                        <Attachments size="sm" className={styles.files}>
                            {attach.files.map(file => (
                                <PreviewableAttachment
                                    key={file.key}
                                    data={{
                                        id: file.key,
                                        filename: file.name,
                                        mediaType: file.mediaType,
                                        size: file.size,
                                        preview: file.preview,
                                    }}
                                    loading={file.status === 'uploading'}
                                    error={file.status === 'error'}
                                    onRetry={() => attach.retry(file.key)}
                                    onRemove={() => attach.remove(file.key)}
                                />
                            ))}
                        </Attachments>
                    )}

                    <RichInput
                        ref={field}
                        value={doc}
                        onChange={edit}
                        triggers={triggers}
                        renderMention={MentionChip}
                        serializeMention={serializeMention}
                        autoFocus={editMode !== undefined || !chat?.orchestratorRunId}
                        className={styles.field}
                        minHeight={minLines ? minLines * LINE_HEIGHT : undefined}
                        aria-label={editMode ? 'Edit message' : 'Message'}
                        placeholder={editMode ? 'Edit message' : busy ? 'Queue another message…' : 'Write a message…'}
                        submitOnEnter
                        onSubmit={(next, origin) =>
                            editMode ? submitEdit(next) : void send(next, origin?.mod === true)
                        }
                        onEscape={editMode?.onCancel}
                        // Files before text, as the zone around the page does: a file copied in Finder also puts its name on the clipboard as text.
                        onPasteFiles={pasted}
                    />

                    <div className={styles.row}>
                        <div className={styles.start}>
                            <Button
                                variant="filling"
                                color="secondary"
                                size="sm"
                                iconOnly
                                aria-label="Attach files"
                                tooltip="Attach files"
                                onPress={() => picker.current?.click()}
                            >
                                <Clip />
                            </Button>
                        </div>
                        <input
                            ref={picker}
                            type="file"
                            multiple
                            hidden
                            aria-hidden
                            tabIndex={-1}
                            onChange={event => {
                                attach.add(Array.from(event.currentTarget.files ?? []));
                                // The same file may be picked again.
                                event.currentTarget.value = '';
                                field.current?.focus();
                            }}
                        />

                        <div className={styles.end}>
                            {/* The model and the context belong to the chat, not to a message that is sent again: an edit frame has neither. */}
                            {!editMode && (
                                <>
                                    <ContextRing chat={chat} run={run} />

                                    {model.noProvider ? (
                                        <Unavailable label="Model" hint={NO_PROVIDER_HINT}>
                                            <ModelPickerOff />
                                        </Unavailable>
                                    ) : (
                                        <ModelPicker
                                            choice={model.choice}
                                            providers={model.providers}
                                            running={running}
                                            onPick={model.pick}
                                        />
                                    )}
                                </>
                            )}

                            <Unavailable
                                label={editMode ? 'Submit edit' : 'Send'}
                                hint={hasMessage ? blocked : undefined}
                            >
                                <ComposerSend
                                    label={editMode ? 'Submit edit' : undefined}
                                    canSend={hasMessage}
                                    blocked={blocked !== undefined}
                                    isPending={editMode?.isPending}
                                    running={running && !editMode}
                                    waits={busy && !editMode ? busyEnter.mode : undefined}
                                    isStopping={isStopping}
                                    onSend={() => {
                                        if (editMode) {
                                            submitEdit(doc);

                                            return;
                                        }

                                        void send(doc);
                                        // The button is off once the text is gone; the caret goes back to the field.
                                        field.current?.focus();
                                    }}
                                    onStop={() => void stop()}
                                />
                            </Unavailable>
                        </div>
                    </div>
                </div>
            </div>

            {/* The mode stands at the end of the line under the card, where the chat's other starting controls are. It belongs to the chat, not to a message that is sent again: an edit frame has no line. */}
            {!editMode && (
                <ChatControls
                    end={
                        <Unavailable
                            label="Mode"
                            hint={running ? 'The mode stays as it is while the orchestrator works' : undefined}
                        >
                            <ModePicker
                                mode={target?.mode ?? draftMode}
                                // A chat made by a first message that failed keeps the mode it was made with.
                                isDisabled={running || (!chat && made !== undefined)}
                                onPick={picked => {
                                    if (chat)
                                        void perform(root, { type: 'chat.setMode', chatId: chat.id, mode: picked });
                                    else setPickedMode({ projectId: start?.projectId, mode: picked });

                                    // Every pick is remembered, as the model's is, for the next new chat that has no mode of its project's.
                                    setRememberedMode(picked);
                                    writeRememberedMode(picked);
                                }}
                            />
                        </Unavailable>
                    }
                >
                    {controls}
                </ChatControls>
            )}
        </>
    );
}
