import { describe, expect, it } from 'vitest';

import { runLabel } from './runLabel';

import type { Chat } from '@clowdy/protocol';

const chat = (id: string, title: string, orchestratorRunId?: string) => ({ id, title, orchestratorRunId }) as Chat;

describe('runLabel', () => {
    const chats = [chat('c1', 'Clone route in the daemon', 'r1'), chat('c2', 'Docs', 'r2'), chat('c3', '  ', 'r3')];

    it('names the orchestrator of a chat by the title of the chat', () => {
        expect(runLabel({ id: 'r2', name: 'Orchestrator 41' }, chats)).toBe('Docs');
    });

    it('keeps its own name when no chat answers to the run or the chat has no title', () => {
        expect(runLabel({ id: 'r9', name: 'Orchestrator 07' }, chats)).toBe('Orchestrator 07');
        expect(runLabel({ id: 'r3', name: 'Orchestrator 08' }, chats)).toBe('Orchestrator 08');
    });

    it('names a native sub-agent by its type, as the card and the running-agents row do', () => {
        expect(runLabel({ id: 'r5', name: 'general-purpose', origin: 'native' }, chats)).toBe('General agent');
        expect(runLabel({ id: 'r6', name: 'Explore', origin: 'native' }, chats)).toBe('Explore agent');
        expect(runLabel({ id: 'r7', name: 'Sub-agent', origin: 'native' }, chats)).toBe('Sub-agent');
    });

    it('accepts any iterable of chats', () => {
        expect(
            runLabel({ id: 'r1', name: 'Orchestrator 41' }, new Map(chats.map(item => [item.id, item])).values())
        ).toBe('Clone route in the daemon');
    });
});
