// @vitest-environment happy-dom
import { emptyComposerDoc, plainTextToDoc } from '@clowdy/components/RichInput';
import { toast } from '@clowdy/components/Toast';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '@clowdy/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { draftOf, messageOf, newChatDraftKey, saveDraft } from './composerDrafts';
import { filesOf, setFiles, type DraftFile } from './composerFiles';
import { handoffFileName, handoffSentence, startHandoff, transcriptOf, turnsOf } from './handoff';

import type { Chat, StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() } }));

const items = (...bodies: StreamItemBody[]): StreamItem[] => bodies.map((body, index) => ({ id: `i-${ index + 1 }`, runId: 'r-1', seq: index + 1, at: 0, body }));
const chat: Chat = { id: 'c-1', projectId: 'p', title: 'Simplify booking', mode: 'autopilot', engine: 'claude', model: 'claude-sonnet', orchestratorRunId: 'r-1', createdAt: 0, updatedAt: 0 };
const file = (name: string) => ({ id: name, name, mediaType: 'text/plain', size: 1 });
/** The new-chat page of the fixture project: where the hand-off writes its sentence and looks at the files. */
const NEW_CHAT_KEY = newChatDraftKey(FIXTURE_PROJECT_ID);
/** A file the new-chat box already holds, uploaded and waiting for its message. */
const held = (name: string, size = 1): DraftFile => ({ key: name, name, mediaType: 'text/plain', size, status: 'ready' });

describe('turnsOf', () => {
    it('keeps the person\'s words and the assistant\'s text, in order, and nothing else', () => {
        const turns = turnsOf(items(
            { kind: 'user', text: 'Simplify the booking flow' },
            { kind: 'assistant', text: 'I will read the form first.', done: true },
            { kind: 'tool', toolCallId: 't-1', name: 'Read', input: { file_path: 'src/form.tsx' }, state: 'done', output: 'SECRET TOOL OUTPUT' },
            { kind: 'note', text: 'Background command finished: bun test' },
            { kind: 'error', text: 'The agent stopped and was started again' },
            { kind: 'user', text: 'Thanks, go on' }
        ));

        expect(turns).toEqual([
            { role: 'person', text: 'Simplify the booking flow' },
            { role: 'assistant', text: 'I will read the form first.' },
            { role: 'person', text: 'Thanks, go on' },
        ]);
    });

    it('joins the assistant\'s text that the tool calls only separated into one turn', () => {
        const turns = turnsOf(items(
            { kind: 'assistant', text: 'First part.', done: true },
            { kind: 'tool', toolCallId: 't-1', name: 'Read', input: {}, state: 'done' },
            { kind: 'assistant', text: 'Second part.', done: true }
        ));

        expect(turns).toEqual([{ role: 'assistant', text: 'First part.\n\nSecond part.' }]);
    });

    it('names the files of a message, and only names them', () => {
        const turns = turnsOf(items(
            { kind: 'user', text: 'See these', attachments: [file('sketch.svg'), file('error.log')] },
            { kind: 'user', text: '', attachments: [file('only-a-file.png')] }
        ));

        expect(turns).toEqual([{ role: 'person', text: 'See these\n\nAttached: sketch.svg, error.log\n\nAttached: only-a-file.png' }]);
    });

    it('includes a question that was answered, as the assistant asking and the person answering', () => {
        const options = [{ id: 'smtp', label: 'Plain SMTP', consequence: 'No dependency' }];
        const turns = turnsOf(items(
            { kind: 'question', questionId: 'q-1', text: 'Which mail provider?', options, answer: 'Plain SMTP' },
            { kind: 'question', questionId: 'q-2', text: 'Which database?', options }
        ));

        expect(turns).toEqual([
            { role: 'assistant', text: 'Asked: Which mail provider?' },
            { role: 'person', text: 'Answered: Plain SMTP' },
        ]);
    });

    it('puts items in the order of their sequence and drops empty text', () => {
        const [first, second, third] = items({ kind: 'user', text: 'one' }, { kind: 'assistant', text: 'two', done: true }, { kind: 'assistant', text: '  \n ', done: true });

        expect(turnsOf([third!, second!, first!]).map(turn => turn.text)).toEqual(['one', 'two']);
        expect(turnsOf([])).toEqual([]);
    });
});

describe('transcriptOf', () => {
    const conversation = items(
        { kind: 'user', text: 'Simplify the booking flow', attachments: [file('sketch.svg')] },
        { kind: 'assistant', text: 'Done with the **form**.', done: true },
        { kind: 'tool', toolCallId: 't-1', name: 'Read', input: {}, state: 'done', output: 'TOOL OUTPUT' }
    );
    const turns = turnsOf(conversation);
    const size = (text: string) => new TextEncoder().encode(text).length;
    const headings = (text: string) => text.split('\n').filter(line => /^#{1,6} /.test(line));
    const turn = (role: 'person' | 'assistant', text: string) => ({ role, text });

    it('is a Markdown file with the title, where it ran, and each turn under who spoke, as a quote', () => {
        expect(transcriptOf(chat, turns, { provider: 'Claude Code' })).toBe([
            '# Conversation from Clowdy',
            '',
            'Chat: Simplify booking',
            'Ran on: Claude Code, claude-sonnet',
            '',
            '## Person',
            '',
            '> Simplify the booking flow',
            '>',
            '> Attached: sketch.svg',
            '',
            '## Assistant',
            '',
            '> Done with the **form**.',
            '',
        ].join('\n'));
    });

    it('leaves tool output out', () => {
        expect(transcriptOf(chat, turns)).not.toContain('TOOL OUTPUT');
    });

    it('falls back to the chat\'s own engine and model, and to nothing for a chat that has none', () => {
        expect(transcriptOf(chat, turns)).toContain('Ran on: claude, claude-sonnet');
        expect(transcriptOf({ ...chat, engine: undefined, model: undefined }, turns)).not.toContain('Ran on');
    });

    it('keeps what a message holds inside its turn: its headings, a fence that never closes, a line that reads like a turn', () => {
        const hostile = [
            '## Assistant',
            '',
            '```ts',
            'const x = 1;',
            '````',
            '# A heading of its own',
            '---',
            '<!-- not a comment of the file -->',
            '```',
            'a fence that never closes',
        ].join('\r\n');
        const text = transcriptOf(chat, [turn('person', hostile), turn('assistant', 'Thanks, noted.')]);

        // Only the file's own headings are headings of the file: everything of the message is a line of its quote.
        expect(headings(text)).toEqual(['# Conversation from Clowdy', '## Person', '## Assistant']);
        expect(text).not.toContain('\r');

        const person = text.slice(text.indexOf('## Person'), text.lastIndexOf('## Assistant'));

        for (const line of person.split('\n').slice(2).filter(Boolean)) expect(line.startsWith('>')).toBe(true);

        expect(text.endsWith('## Assistant\n\n> Thanks, noted.\n')).toBe(true);
    });

    it('puts a title or a model with a line break in it on one line', () => {
        const text = transcriptOf({ ...chat, title: 'Fix\n## Person\n\nthe price' }, turns, { provider: 'Claude\nCode' });

        expect(headings(text)).toEqual(['# Conversation from Clowdy', '## Person', '## Assistant']);
        expect(text).toContain('Chat: Fix ## Person the price\n');
        expect(text).toContain('Ran on: Claude Code, claude-sonnet\n');
    });

    describe('when the conversation is longer than a file may be', () => {
        const long = Array.from({ length: 12 }, (_, index) => turn(index % 2 === 0 ? 'person' : 'assistant', `turn ${ String(index + 1).padStart(2, '0') } ${ 'word '.repeat(40) }`));
        const whole = transcriptOf(chat, long);

        it('is left whole at exactly the limit, and cut one byte under it', () => {
            expect(transcriptOf(chat, long, {}, size(whole))).toBe(whole);
            expect(transcriptOf(chat, long, {}, size(whole) - 1)).not.toBe(whole);
        });

        it('keeps the newest turns, drops the oldest, and says how many were left out', () => {
            const text = transcriptOf(chat, long, {}, 1500);

            expect(size(text)).toBeLessThanOrEqual(1500);
            expect(text).toMatch(/_Turns left out: the oldest (\d+) of 12, because the conversation is too long for one file\._/);
            expect(text).toContain('turn 12');
            expect(text).not.toContain('turn 01');

            // What is kept is the newest run of turns, none missing from its middle, and the count is the number that is gone.
            const kept = [...text.matchAll(/turn (\d\d) /g)].map(([, number]) => Number(number));
            const omitted = Number(/oldest (\d+) of/.exec(text)![1]);

            expect(kept).toEqual(Array.from({ length: 12 - omitted }, (_, index) => omitted + index + 1));
            expect(omitted).toBeGreaterThan(0);
        });

        it('stays within the limit, counted in bytes, whatever the limit and the script', () => {
            const russian = Array.from({ length: 30 }, (_, index) => turn(index % 2 === 0 ? 'person' : 'assistant', `Сообщение ${ index } ${ 'слово 😀 '.repeat(20) }`));

            for (const limit of [180, 200, 333, 500, 777, 1024, 2048]) {
                const text = transcriptOf(chat, russian, {}, limit);

                expect(size(text)).toBeLessThanOrEqual(limit);
                // A cut never ends inside a character.
                expect(text).not.toContain('�');
            }
        });

        it('cuts the start of the newest turn, and says so, when that turn alone does not fit', () => {
            const text = transcriptOf(chat, [turn('person', 'old question'), turn('assistant', `start ${ 'x'.repeat(5000) }`)], {}, 600);

            expect(size(text)).toBeLessThanOrEqual(600);
            expect(text).toContain('_Turns left out: the oldest 1 of 2');
            expect(text).toContain('> start xxx');
            expect(text).toContain('_The rest of this turn is left out: it is too long for one file._');
            expect(text).not.toContain('old question');
        });

        it('says nothing about omitted turns for a single turn that is cut', () => {
            const text = transcriptOf(chat, [turn('assistant', 'y'.repeat(5000))], {}, 400);

            expect(size(text)).toBeLessThanOrEqual(400);
            expect(text).not.toContain('Turns left out');
            expect(text).toContain('_The rest of this turn is left out');
        });

        it('holds to the largest attachment the daemon takes by default', () => {
            const big = Array.from({ length: 5 }, (_, index) => turn(index % 2 === 0 ? 'person' : 'assistant', `turn ${ index } ${ 'z'.repeat(6 * 1024 * 1024) }`));
            const text = transcriptOf(chat, big);

            expect(size(text)).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
            expect(text).toContain('Turns left out');
            expect(text).toContain('turn 4 ');
            expect(text).not.toContain('turn 0 ');
        });
    });
});

describe('handoffFileName', () => {
    it('is the title in kebab case, then -conversation.md', () => {
        expect(handoffFileName('Simplify booking')).toBe('simplify-booking-conversation.md');
        expect(handoffFileName('  Fix: the "price" bug (v2)!  ')).toBe('fix-the-price-bug-v2-conversation.md');
    });

    it('keeps the letters of other scripts, and has a name for a title with none', () => {
        expect(handoffFileName('Упростить бронирование')).toBe('упростить-бронирование-conversation.md');
        expect(handoffFileName('???')).toBe('chat-conversation.md');
    });

    it('keeps the vowel signs and other marks of scripts that write them apart from the letter', () => {
        expect(handoffFileName('हिन्दी में बुकिंग')).toBe('हिन्दी-में-बुकिंग-conversation.md');
        expect(handoffFileName('จองห้องพัก')).toBe('จองห้องพัก-conversation.md');
    });

    it('keeps a long title short, without a dash left at the cut', () => {
        const name = handoffFileName(`${ 'word '.repeat(30) }end`);

        expect(name.endsWith('-conversation.md')).toBe(true);
        expect(name.length).toBeLessThanOrEqual(60 + '-conversation.md'.length);
        expect(name).not.toContain('--');
    });

    it('never cuts a character in two, and stays a name the daemon keeps whole', () => {
        // Letters outside the basic plane take two UTF-16 units and four bytes each; a letter in front moves where a cut by unit would fall.
        for (const title of ['𝐇'.repeat(80), `a${ '𝐇'.repeat(80) }`, `ab${ '𝐇'.repeat(80) }`]) {
            const name = handoffFileName(title);

            expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
            expect(() => encodeURIComponent(name)).not.toThrow();
            // The daemon cuts a name over 240 bytes or 120 characters, and then the draft would name a file that is not there.
            expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(240);
            expect([...name].length).toBeLessThanOrEqual(120);
            expect(name.endsWith('-conversation.md')).toBe(true);
        }

        expect(handoffFileName('日本語のタイトル'.repeat(20))).toMatch(/^日本語のタイトル/);
    });
});

describe('handoffSentence', () => {
    it('asks to continue the work and names the file', () => {
        expect(handoffSentence('Simplify  booking', 'simplify-booking-conversation.md'))
            .toBe('Continue the work from the chat "Simplify booking". The conversation so far is attached as simplify-booking-conversation.md.');
    });

    it('keeps a title with a line break in it on one line', () => {
        expect(handoffSentence('Fix\n\nthe price', 'fix-conversation.md')).toBe('Continue the work from the chat "Fix the price". The conversation so far is attached as fix-conversation.md.');
    });
});

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

describe('startHandoff', () => {
    let data: FixtureData;
    let transport: FixtureTransport;
    let root: RootStore;

    const ui = () => root.ui.forProject(FIXTURE_PROJECT_ID);
    const chatOf = (id: string) => root.selectedProject!.chats.get(id)!;
    const handOff = (id: string) => startHandoff({ root, ui: ui(), chat: chatOf(id), run: root.selectedProject!.runs.get(chatOf(id).orchestratorRunId ?? '') });

    beforeEach(async () => {
        vi.mocked(toast.error).mockClear();
        saveDraft(NEW_CHAT_KEY, emptyComposerDoc());
        data = createFixtureData();
        transport = new FixtureTransport({ data });
        root = new RootStore(transport, { storage: memoryStorage() });
        await root.load();
        await root.refreshAgents();
    });

    afterEach(() => {
        root.dispose();
        setFiles(NEW_CHAT_KEY, []);
    });

    it('opens the new-chat page with the conversation attached as a Markdown file and the draft filled', async () => {
        expect(await handOff('c-1')).toBe(true);

        expect(ui().draft).toBe(true);
        expect(ui().section).toBe('agents');

        const [attached, ...others] = ui().pendingFiles;

        expect(others).toEqual([]);
        expect(attached!.name).toBe('simplify-booking-conversation.md');
        expect(attached!.type).toBe('text/markdown');

        const transcript = await attached!.text();

        expect(transcript).toContain('Chat: Simplify booking');
        expect(transcript).toContain('Ran on: Claude Code, claude-sonnet');
        expect(transcript).toContain('Simplify the booking flow: one form instead of three steps');
        expect(transcript).toContain('A sub-agent is on the form');
        expect(transcript).toContain('Attached: booking-sketch.svg, booking-error.log');
        // The tools, the notes and the errors are not part of it.
        expect(transcript).not.toContain('src/booking/steps.tsx:12');
        expect(transcript).not.toContain('Background command finished');
        expect(transcript).not.toContain('The agent stopped and was started again');

        expect(messageOf(draftOf(NEW_CHAT_KEY)))
            .toBe('Continue the work from the chat "Simplify booking". The conversation so far is attached as simplify-booking-conversation.md.');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('follows words already in the new-chat draft after a blank line, and keeps them', async () => {
        saveDraft(NEW_CHAT_KEY, plainTextToDoc('Also check the footer'));

        expect(await handOff('c-1')).toBe(true);

        expect(messageOf(draftOf(NEW_CHAT_KEY))).toBe('Also check the footer\n\nContinue the work from the chat "Simplify booking". The conversation so far is attached as simplify-booking-conversation.md.');
    });

    it('does not leave a second blank line after a draft that ends in an empty paragraph', async () => {
        saveDraft(NEW_CHAT_KEY, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Also check the footer' }] }, { type: 'paragraph' }] });

        await handOff('c-1');

        expect(messageOf(draftOf(NEW_CHAT_KEY)).startsWith('Also check the footer\n\nContinue')).toBe(true);
    });

    it('waits for a conversation that is still being fetched, and fetches one that is not', async () => {
        const fetching = root.streams.of('r-orch-3').load();

        expect(await handOff('c-3')).toBe(true);
        await fetching;
        expect(await ui().pendingFiles[0]!.text()).toContain('Chat: Architecture questions');

        expect(root.streams.of('r-orch-2').status).toBe('idle');
        expect(await handOff('c-2')).toBe(true);
        expect(root.streams.of('r-orch-2').status).toBe('ready');
    });

    it('says so and stays where it is for a chat that has no messages at all', async () => {
        expect(await handOff('c-4')).toBe(false);

        expect(toast.error).toHaveBeenCalledWith({ message: 'There is nothing to hand off yet: the chat has no messages' });
        expect(ui().draft).toBe(false);
        expect(ui().pendingFiles).toEqual([]);
        expect(messageOf(draftOf(NEW_CHAT_KEY))).toBe('');
    });

    it('says so for a chat whose stream holds only tool calls and notes', async () => {
        data.items['r-orch-2'] = items({ kind: 'note', text: 'started' }, { kind: 'tool', toolCallId: 't-1', name: 'Read', input: {}, state: 'done' });

        expect(await handOff('c-2')).toBe(false);

        expect(toast.error).toHaveBeenCalledWith({ message: 'There is nothing to hand off yet: the chat has no messages' });
        expect(ui().draft).toBe(false);
    });

    it('says so and stays where it is when the conversation cannot be loaded', async () => {
        vi.spyOn(transport, 'getItems').mockRejectedValue(new Error('The daemon cannot be reached'));

        expect(await handOff('c-1')).toBe(false);

        expect(toast.error).toHaveBeenCalledWith({ message: 'The conversation could not be loaded: The daemon cannot be reached' });
        expect(ui().draft).toBe(false);
        expect(ui().pendingFiles).toEqual([]);
        expect(messageOf(draftOf(NEW_CHAT_KEY))).toBe('');
    });

    it('takes the engine\'s own name from the orchestrator for a chat that does not record one', async () => {
        const legacy = { ...chatOf('c-1'), engine: undefined, model: undefined };

        await startHandoff({ root, ui: ui(), chat: legacy, run: root.selectedProject!.runs.get('r-orch-1') });

        expect(await ui().pendingFiles[0]!.text()).toContain('Ran on: Claude Code, claude-sonnet');
    });

    it('does the hand-off once when the button is pressed twice', async () => {
        const [first, second] = await Promise.all([handOff('c-1'), handOff('c-1')]);

        expect([first, second]).toEqual([true, false]);
        expect(ui().pendingFiles).toHaveLength(1);
        expect(messageOf(draftOf(NEW_CHAT_KEY)).match(/Continue the work/g)).toHaveLength(1);

        // Once it is over, the chat can be handed off again.
        expect(await handOff('c-1')).toBe(true);
    });

    it('does not put the sentence in the draft twice when the same chat is handed off again', async () => {
        await handOff('c-1');
        await handOff('c-1');

        expect(messageOf(draftOf(NEW_CHAT_KEY)).match(/Continue the work/g)).toHaveLength(1);
    });

    it('does not take the person to the new-chat page when they have left the chat while it loaded', async () => {
        let open = true;
        const loading = vi.spyOn(transport, 'getItems');

        loading.mockImplementationOnce(async (...args) => {
            const result = await FixtureTransport.prototype.getItems.apply(transport, args);

            // Gone to another chat (or project) before the answer came.
            open = false;

            return result;
        });

        const chatId = 'c-1';
        const handed = await startHandoff({ root, ui: ui(), chat: chatOf(chatId), run: root.selectedProject!.runs.get('r-orch-1'), stillOpen: () => open });

        expect(handed).toBe(false);
        expect(ui().draft).toBe(false);
        expect(ui().pendingFiles).toEqual([]);
        expect(messageOf(draftOf(NEW_CHAT_KEY))).toBe('');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('writes into the draft of its own project and leaves the words of another project alone', async () => {
        const other = newChatDraftKey(FIXTURE_EMPTY_PROJECT_ID);

        saveDraft(other, plainTextToDoc('Words of the other project'));
        saveDraft(NEW_CHAT_KEY, plainTextToDoc('Also check the footer'));

        expect(await handOff('c-1')).toBe(true);

        expect(messageOf(draftOf(other))).toBe('Words of the other project');
        expect(messageOf(draftOf(NEW_CHAT_KEY))).toBe(`Also check the footer\n\n${ handoffSentence('Simplify booking', 'simplify-booking-conversation.md') }`);
        saveDraft(other, emptyComposerDoc());
    });

    describe('when the message box of the new chat is full', () => {
        const fill = (count: number, size = 1) => setFiles(NEW_CHAT_KEY, Array.from({ length: count }, (_, index) => held(`file-${ index }.txt`, size)));

        it('says so and changes nothing when it holds the most files a message takes', async () => {
            saveDraft(NEW_CHAT_KEY, plainTextToDoc('Also check the footer'));
            fill(MAX_ATTACHMENTS_PER_MESSAGE);

            expect(await handOff('c-1')).toBe(false);

            expect(toast.error).toHaveBeenCalledTimes(1);
            expect(vi.mocked(toast.error).mock.calls[0]![0]).toMatchObject({
                title: 'The conversation was not handed off',
                message: expect.stringContaining(`a message takes ${ MAX_ATTACHMENTS_PER_MESSAGE } files at most`) as string,
            });
            // Not the page, not the file, and not the sentence: the draft says "attached as ..." only when a file is.
            expect(ui().draft).toBe(false);
            expect(ui().pendingFiles).toEqual([]);
            expect(messageOf(draftOf(NEW_CHAT_KEY))).toBe('Also check the footer');
            expect(filesOf(NEW_CHAT_KEY)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
        });

        it('says so when the files in it leave no room for the conversation by size', async () => {
            // Four files of the most one may weigh come to the most a message may carry.
            fill(4, MAX_ATTACHMENT_BYTES);

            expect(await handOff('c-1')).toBe(false);

            expect(vi.mocked(toast.error).mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining('of files at most') as string });
            expect(ui().draft).toBe(false);
            expect(ui().pendingFiles).toEqual([]);
        });

        it('lets the hand-off through when the box has the conversation already, which is no new file', async () => {
            expect(await handOff('c-1')).toBe(true);

            const [attached] = ui().pendingFiles;

            ui().takePendingFiles();
            setFiles(NEW_CHAT_KEY, [held(attached!.name, attached!.size), ...Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE - 1 }, (_, index) => held(`file-${ index }.txt`))]);
            vi.mocked(toast.error).mockClear();

            expect(await handOff('c-1')).toBe(true);
            expect(toast.error).not.toHaveBeenCalled();
        });

        it('hands off again once there is room', async () => {
            fill(MAX_ATTACHMENTS_PER_MESSAGE);
            expect(await handOff('c-1')).toBe(false);

            fill(MAX_ATTACHMENTS_PER_MESSAGE - 1);

            expect(await handOff('c-1')).toBe(true);
            expect(ui().pendingFiles.map(pending => pending.name)).toEqual(['simplify-booking-conversation.md']);
        });
    });

    it('hands over a conversation of any length as a file the daemon takes', async () => {
        const turn = (index: number): StreamItemBody => (index % 2 === 0
            ? { kind: 'user', text: `question ${ index } ${ 'q'.repeat(5 * 1024 * 1024) }` }
            : { kind: 'assistant', text: `answer ${ index } ${ 'a'.repeat(5 * 1024 * 1024) }`, done: true });

        data.items['r-orch-2'] = items(...Array.from({ length: 7 }, (_, index) => turn(index)));

        expect(await handOff('c-2')).toBe(true);

        const [attached] = ui().pendingFiles;

        // The attachment's limit is on the file: a file over it would be refused at the upload, after the person had moved on.
        expect(attached!.size).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
        expect(attached!.name).toBe('first-version-conversation.md');

        const text = await attached!.text();

        expect(text).toContain('Turns left out');
        expect(text).toContain('question 6 ');
        expect(text).not.toContain('question 0 ');
    });
});
