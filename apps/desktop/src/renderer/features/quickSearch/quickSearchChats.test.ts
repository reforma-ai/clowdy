import { describe, expect, it } from 'vitest';

import { foundChats, type ChatsOfProject } from './quickSearchChats';

import type { Chat, ProjectFolder } from '@clowdy/protocol';

const folder = (id: string, path: string) => ({ id, path } as ProjectFolder);
const FOLDERS = [folder('f1', '/work/web'), folder('f2', '/work/api')];

function chatOf(id: string, title: string, extra: Partial<Chat> = {}): Chat {
    return { id, title, updatedAt: 0, createdAt: 0, ...extra } as Chat;
}

function projectWith(chats: Chat[], folders: ProjectFolder[] = [FOLDERS[0]!]): ChatsOfProject {
    return { chats: new Map(chats.map(chat => [chat.id, chat])), runs: new Map(), project: { folders } };
}

const titles = (found: ReturnType<typeof foundChats>) => found.map(({ chat }) => chat.title);

describe('the chats a search finds', () => {
    const project = projectWith([
        chatOf('a', 'Fix the booking form', { updatedAt: 10 }),
        chatOf('b', 'Booking price rules', { updatedAt: 5 }),
        chatOf('c', 'Architecture questions', { updatedAt: 30 }),
        chatOf('d', 'Old booking idea', { updatedAt: 40, archivedAt: 41 }),
        chatOf('e', 'Booking thread', { updatedAt: 50, parentChatId: 'c' }),
    ]);

    it('need every word in the title, ignoring case, threads and the archive included', () => {
        expect(titles(foundChats(project, 'BOOKING'))).toEqual(['Booking thread', 'Booking price rules', 'Fix the booking form', 'Old booking idea']);
        expect(titles(foundChats(project, 'booking price'))).toEqual(['Booking price rules']);
        expect(foundChats(project, 'nothing like it')).toEqual([]);
    });

    it('put the titles that start with the first word first, then the latest, and the archive after the chats in use', () => {
        expect(titles(foundChats(project, 'booking'))).toEqual(['Booking thread', 'Booking price rules', 'Fix the booking form', 'Old booking idea']);
        expect(titles(foundChats(project, 'form'))).toEqual(['Fix the booking form']);
    });

    it('are the latest chats in use that the person made while nothing is typed: not a thread, not one in the archive', () => {
        expect(titles(foundChats(project, ''))).toEqual(['Architecture questions', 'Fix the booking form', 'Booking price rules']);
        expect(titles(foundChats(project, '   '))).toHaveLength(3);
    });

    it('name the folder of a chat, archived or not, only when the project has several', () => {
        expect(foundChats(project, 'old')[0]).toMatchObject({ kind: 'chat', chatId: 'd', note: undefined });
        expect(foundChats(project, 'architecture')[0]!.note).toBeUndefined();

        const several = projectWith([chatOf('a', 'In the api', { folderId: 'f2' }), chatOf('b', 'In the main one'), chatOf('c', 'In the archived one', { folderId: 'f2', archivedAt: 5 })], FOLDERS);

        expect(foundChats(several, 'in the').map(({ note }) => note).toSorted()).toEqual(['api', 'api', 'web']);
    });

    it('carry the run of the chat for its icon', () => {
        const run = { id: 'r1', status: 'running' } as never;
        const withRun: ChatsOfProject = { ...projectWith([chatOf('a', 'Working', { orchestratorRunId: 'r1' }), chatOf('b', 'Not started')]), runs: new Map([['r1', run]]) };

        expect(foundChats(withRun, 'working')[0]!.run).toBe(run);
        expect(foundChats(withRun, 'not')[0]!.run).toBeUndefined();
    });
});
