import { plainTextToDoc, type ComposerDoc } from '@clowdy/components/RichInput';
import { toast } from '@clowdy/components/Toast';
import { MAX_ATTACHMENT_BYTES } from '@clowdy/protocol';
import { when } from 'mobx';

import { chatProvider } from './chatProvider';
import { draftOf, messageOf, newChatDraftKey, saveDraft } from './composerDrafts';
import { admitFiles, filesOf } from './composerFiles';

import type { Chat, ChatId, Run, StreamItem } from '@clowdy/protocol';
import type { ProjectUi, RootStore } from '../../stores';

/** What the conversation is made of: who said it, and the words. */
export interface Turn {
    role: 'person' | 'assistant';
    text: string;
}

/**
 * The words of a conversation in order: the person's messages (the names of their files after them) and the assistant's text, with
 * a question the assistant asked and the person answered. Tool calls, notes and errors are left out, and so is a question nobody
 * answered. Text that follows from the same side is one turn.
 */
export function turnsOf(items: readonly StreamItem[]): Turn[] {
    const turns: Turn[] = [];
    const add = (role: Turn['role'], text: string) => {
        const words = text.trim();

        if (!words) return;

        const last = turns.at(-1);

        if (last?.role === role) last.text += `\n\n${ words }`;
        else turns.push({ role, text: words });
    };

    for (const { body } of [...items].sort((a, b) => a.seq - b.seq)) {
        switch (body.kind) {
            case 'user': {
                const files = (body.attachments ?? []).map(file => file.name);

                add('person', [body.text.trim(), files.length > 0 ? `Attached: ${ files.join(', ') }` : ''].filter(Boolean).join('\n\n'));
                break;
            }
            case 'assistant':
                add('assistant', body.text);
                break;
            case 'question':
                if (body.answer !== undefined) {
                    add('assistant', `Asked: ${ body.text }`);
                    add('person', `Answered: ${ body.answer }`);
                }

                break;
            default:
                break;
        }
    }

    return turns;
}

/** What to say about where the chat ran, when it differs from what the chat itself keeps (the agent's name instead of its id). */
export interface TranscriptContext {
    provider?: string;
    model?: string;
}

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

/** A value on one line: a title with a line break in it must not start a line of the file's own. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The text in a block quote, every line. A turn is whatever somebody wrote: a heading, a line that reads `## Person`, a code fence
 * that never closes would otherwise run into the turns after it. Inside a quote they stay inside their turn.
 */
function quoted(text: string): string {
    return text.replace(/\r\n?/g, '\n').split('\n').map(line => (line ? `> ${ line }` : '>')).join('\n');
}

/** The longest start of the text that fits `limit` bytes of UTF-8, never ending inside a character. */
function cutBytes(text: string, limit: number): string {
    const bytes = encoder.encode(text);

    if (bytes.length <= limit) return text;

    let end = Math.max(limit, 0);

    // A byte of the form 10xxxxxx continues the character before it, so the cut goes back to where that character starts.
    while (end > 0 && (bytes[end]! & 0xC0) === 0x80) end -= 1;

    return new TextDecoder().decode(bytes.subarray(0, end));
}

const leftOut = (omitted: number, total: number) => `_Turns left out: the oldest ${ omitted } of ${ total }, because the conversation is too long for one file._\n`;
const CUT_NOTE = '\n\n_The rest of this turn is left out: it is too long for one file._\n';

/**
 * The newest turns that fit `maxBytes` with the file's head and a line saying how many of the oldest were left out. When the newest
 * turn alone does not fit, its start is kept and the cut is said.
 */
function newestThatFit(head: string, sections: readonly string[], maxBytes: number): string {
    const total = sections.length;
    // The line's size with the most digits it can have, so the one that is written never makes the file larger than counted.
    let used = bytesOf(head) + 1 + bytesOf(leftOut(total, total));
    let first = total;

    while (first > 0) {
        const size = bytesOf(sections[first - 1]!) + 1;

        if (used + size > maxBytes) break;

        used += size;
        first -= 1;
    }

    if (first < total) return [head, leftOut(first, total), ...sections.slice(first)].join('\n');

    const intro = total > 1 ? [head, leftOut(total - 1, total)] : [head];
    const room = maxBytes - bytesOf(intro.join('\n')) - 1 - bytesOf(CUT_NOTE);

    return [...intro, `${ cutBytes(sections[total - 1]!, room).trimEnd() }${ CUT_NOTE }`].join('\n');
}

/**
 * The conversation as a Markdown file for another agent to read: the chat's title, what it ran on, then each turn under who spoke,
 * as a quote. Tool output is not in it, only what was said. A file is at most `maxBytes` (the most an attachment may be): a longer
 * conversation keeps its newest turns, and the file says that older ones were left out.
 */
export function transcriptOf(chat: Chat, turns: readonly Turn[], { provider = chat.engine, model = chat.model }: TranscriptContext = {}, maxBytes = MAX_ATTACHMENT_BYTES): string {
    const ranOn = oneLine([provider, model].filter(Boolean).join(', '));
    const head = `${ ['# Conversation from Clowdy', '', `Chat: ${ oneLine(chat.title) }`, ...(ranOn ? [`Ran on: ${ ranOn }`] : [])].join('\n') }\n`;
    const sections = turns.map(({ role, text }) => `${ role === 'person' ? '## Person' : '## Assistant' }\n\n${ quoted(text) }\n`);
    const whole = [head, ...sections].join('\n');

    if (bytesOf(whole) <= maxBytes) return whole;

    // Whatever the maths missed (a limit smaller than the head, say) is cut off the end rather than sent on to be refused.
    return cutBytes(sections.length === 0 ? whole : newestThatFit(head, sections, maxBytes), maxBytes);
}

/** The most characters of a title the file's name keeps, and the most bytes: the daemon cuts a name at 240 bytes, which would leave the draft naming a file that does not exist. */
const NAME_CHARS = 60;
const NAME_BYTES = 200;

/** The file's name: the chat's title in kebab case, then `-conversation.md`. */
export function handoffFileName(title: string): string {
    // Letters, marks (the vowel signs of Hindi or Thai are not letters) and numbers of any script stay; the rest between them is one dash.
    const kebab = title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    let slug = '';
    let bytes = 0;
    let chars = 0;

    // By character, not by UTF-16 unit: a cut between the halves of a surrogate pair leaves a broken character in the name.
    for (const char of kebab) {
        bytes += bytesOf(char);
        chars += 1;

        if (chars > NAME_CHARS || bytes > NAME_BYTES) break;

        slug += char;
    }

    return `${ slug.replace(/-+$/, '') || 'chat' }-conversation.md`;
}

/** The sentence that asks the next agent to carry on, for the message box of the new chat. */
export function handoffSentence(title: string, fileName: string): string {
    return `Continue the work from the chat "${ oneLine(title) }". The conversation so far is attached as ${ fileName }.`;
}

/**
 * The draft with the sentence in it: in an empty one the sentence is all there is, and in one with words it follows them after a
 * blank line. A draft that already has the sentence (the same chat handed off twice before the message was sent) stays as it is.
 */
function withSentence(draft: ComposerDoc, sentence: string): ComposerDoc {
    const words = messageOf(draft);

    if (words === '') return plainTextToDoc(sentence);

    if (words.includes(sentence)) return draft;

    const next = structuredClone(draft);
    const blocks = next.content ?? [];
    const last = blocks.at(-1);

    // A paragraph with nothing in it at the end would leave two blank lines.
    if (last?.type === 'paragraph' && !last.content?.length) blocks.pop();

    blocks.push(...(plainTextToDoc(sentence).content ?? []));
    next.content = blocks;

    return next;
}

export interface Handoff {
    root: RootStore;
    /** The project's window, which goes to the new-chat page. */
    ui: ProjectUi;
    chat: Chat;
    /** The chat's orchestrator, for the provider of a chat that does not record one itself. */
    run: Run | undefined;
    /** Whether the person is still on the chat. Loading the conversation takes a moment: one who went elsewhere meanwhile is not taken to the new-chat page. */
    stillOpen?: () => boolean;
}

/** The chats being handed off, so that a second press (or a second notice for the same chat) does not do it twice. */
const handingOff = new Set<ChatId>();

/**
 * Hands the work of a chat over to a new one: loads the conversation, makes the file, and opens the new-chat page with the file
 * attached and a sentence in the message box. Nothing is sent: the person picks the provider and presses Send. The words go into
 * the new-chat page's draft of this project, which its box reads when it opens; the file waits in `ui.pendingFiles` for the page to
 * attach it, so it is uploaded to the project like a file picked there. Says why and stays where it is when there is nothing to hand
 * over, the conversation cannot be loaded, or the new-chat box has no room for the file. Resolves to whether the new-chat page was opened.
 *
 * A full box (the files of one message are limited in number and in size, and the daemon refuses a message that carries more) does
 * not take the file in anyway: the message could not be sent until the person removed something, and a draft that says "attached
 * as ..." with no file behind it is worse than none. So the person is told plainly, and nothing changes: not the draft, not the page.
 */
export async function startHandoff({ root, ui, chat, run, stillOpen = () => true }: Handoff): Promise<boolean> {
    if (!chat.orchestratorRunId) {
        toast.error({ message: 'There is nothing to hand off yet: the chat has no messages' });

        return false;
    }

    if (handingOff.has(chat.id)) return false;

    handingOff.add(chat.id);

    try {
        const stream = root.streams.of(chat.orchestratorRunId);

        await stream.load();

        // Someone else was loading it: `load` leaves that to them, so wait for the answer.
        if (stream.status === 'loading') await when(() => stream.status !== 'loading');

        if (!stillOpen()) return false;

        if (stream.status !== 'ready') {
            toast.error({ message: `The conversation could not be loaded${ stream.error ? `: ${ stream.error }` : '' }` });

            return false;
        }

        const turns = turnsOf(stream.items);

        if (turns.length === 0) {
            toast.error({ message: 'There is nothing to hand off yet: the chat has no messages' });

            return false;
        }

        const engine = chatProvider(chat, run);
        const provider = root.agents.find(agent => agent.id === engine)?.name ?? engine;
        const fileName = handoffFileName(chat.title);
        const file = new File([transcriptOf(chat, turns, { provider, model: chat.model ?? run?.model })], fileName, { type: 'text/markdown' });

        const draftKey = newChatDraftKey(ui.projectId);
        // A file the box already holds (the same chat handed off twice) is not a refusal: it is attached already.
        const [refusal] = admitFiles(filesOf(draftKey), [file]).refusals;

        if (refusal) {
            toast.error({ title: 'The conversation was not handed off', message: `${ refusal } Make room in the message box of the new chat, then hand off again.` });

            return false;
        }

        saveDraft(draftKey, withSentence(draftOf(draftKey), handoffSentence(chat.title, fileName)));
        ui.openDraft([file]);

        return true;
    }
    finally {
        handingOff.delete(chat.id);
    }
}
