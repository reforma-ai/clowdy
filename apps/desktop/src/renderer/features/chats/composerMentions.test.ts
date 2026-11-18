import { describe, expect, it } from 'vitest';

import { serializeMention } from './composerMentions';

import type { ComposerMentionAttrs } from '@clowdy/components/RichInput';

const mention = (kind: ComposerMentionAttrs['kind'], data: unknown): ComposerMentionAttrs => ({ id: 'x', label: 'x', kind, trigger: '@', data });

describe('serializeMention', () => {
    it('writes a task as its key', () => {
        expect(serializeMention(mention('task', { key: 'CAR-24', title: 'Rebuild the form' }))).toBe('CAR-24');
    });

    it('writes a file and a document as @path, from the project folder', () => {
        expect(serializeMention(mention('file', { path: 'src/booking/index.tsx' }))).toBe('@src/booking/index.tsx');
        expect(serializeMention(mention('doc', { path: '.clowdy/docs/decisions/pricing.md' }))).toBe('@.clowdy/docs/decisions/pricing.md');
    });

    it('quotes a path that holds a space', () => {
        expect(serializeMention(mention('file', { path: 'notes/my plan.md' }))).toBe('@"notes/my plan.md"');
    });

    it('asks for a skill in words, because no spelling of a command works for every agent', () => {
        expect(serializeMention(mention('command', { name: 'deploy' }))).toBe('Use the skill "deploy"');
    });

    it('writes nothing for a kind it does not know', () => {
        expect(serializeMention(mention('link', { url: 'https://example.com' }))).toBe('');
    });
});
