import { describe, expect, it } from 'vitest';

import { runLabel } from './runLabel';

import type { Chat } from '@clowdy/protocol';

const chat = (id: string, title: string, orchestratorRunId?: string) => ({ id, title, orchestratorRunId }) as Chat;

describe('runLabel', () => {
    const chats = [chat('c1', 'Clone route in the daemon', 'r1'), chat('c2', 'Docs', 'r2'), chat('c3', '  ', 'r3')];

    it('names the orchestrator of a chat by the title of the chat, whatever its stale summary says', () => {
        expect(runLabel({ id: 'r2', name: 'Orchestrator 41', summary: 'An old title' }, chats)).toBe('Docs');
    });

    it('keeps its own name when no chat answers to the run or the chat has no title', () => {
        expect(runLabel({ id: 'r9', name: 'Orchestrator 07', summary: '' }, chats)).toBe('Orchestrator 07');
        expect(runLabel({ id: 'r3', name: 'Orchestrator 08', summary: '' }, chats)).toBe('Orchestrator 08');
    });

    it('names a native sub-agent by what it was asked to do, on one line', () => {
        expect(
            runLabel({ id: 'r5', name: 'general-purpose', origin: 'native', summary: 'Review clone route diff' }, chats)
        ).toBe('Review clone route diff');
        expect(
            runLabel(
                { id: 'r6', name: 'Explore', origin: 'native', summary: '  Find where\n the price   is computed ' },
                chats
            )
        ).toBe('Find where the price is computed');
    });

    it('names a native sub-agent that has no summary by its type, as the running-agents row does', () => {
        expect(runLabel({ id: 'r5', name: 'general-purpose', origin: 'native', summary: '' }, chats)).toBe(
            'General agent'
        );
        expect(runLabel({ id: 'r6', name: 'Explore', origin: 'native', summary: '   ' }, chats)).toBe('Explore agent');
        expect(runLabel({ id: 'r7', name: 'Sub-agent', origin: 'native', summary: '' }, chats)).toBe('Sub-agent');
    });

    it('accepts any iterable of chats', () => {
        expect(
            runLabel(
                { id: 'r1', name: 'Orchestrator 41', summary: '' },
                new Map(chats.map(item => [item.id, item])).values()
            )
        ).toBe('Clone route in the daemon');
    });
});
