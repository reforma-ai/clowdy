import { describe, expect, it } from 'vitest';

import { ProjectUi } from '../../stores';
import { chatScrollMemory } from './chatScrollMemory';

describe('chat reading memory', () => {
    it('remembers each chat separately for this project UI session and clears a position at the end', () => {
        const project = new ProjectUi('p');
        const first = chatScrollMemory(project, 'first');
        const second = chatScrollMemory(project, 'second');

        first.write({ top: 230 });
        second.write({ top: 700 });
        expect(chatScrollMemory(project, 'first').read()).toEqual({ top: 230 });
        expect(chatScrollMemory(project, 'second').read()).toEqual({ top: 700 });
        expect(chatScrollMemory(new ProjectUi('p'), 'first').read()).toBeUndefined();

        first.write(undefined);
        expect(chatScrollMemory(project, 'first').read()).toBeUndefined();
        expect(second.read()).toEqual({ top: 700 });
    });
});
