import { describe, expect, it } from 'vitest';

import { PROJECT_SLOTS, projectAtSlot, slotOfProject } from './projectSwitch';

import type { Project } from '@clowdy/protocol';

const project = (id: string, personal = false) => ({ id, personal }) as Project;
const personal = project('prj_personal', true);
const own = (count: number) => Array.from({ length: count }, (_, index) => project(`prj_${index + 1}`));

describe('projectAtSlot', () => {
    it('puts the personal space on 0 and the other projects on 1 and up, whatever the personal space sits at in the list', () => {
        const projects = [project('prj_a'), personal, project('prj_b')];

        expect(projectAtSlot(projects, 0)).toBe(personal);
        expect(projectAtSlot(projects, 1)?.id).toBe('prj_a');
        expect(projectAtSlot(projects, 2)?.id).toBe('prj_b');
        expect(projectAtSlot(projects, 3)).toBeUndefined();
    });

    it('has nothing on 0 where there is no personal space', () => {
        expect(projectAtSlot(own(2), 0)).toBeUndefined();
    });
});

describe('slotOfProject', () => {
    it('is the inverse of projectAtSlot', () => {
        const projects = [personal, ...own(3)];

        for (const item of projects) expect(projectAtSlot(projects, slotOfProject(projects, item)!)).toBe(item);
    });

    it('gives the tenth project and the ones after it no slot', () => {
        const projects = [personal, ...own(11)];

        expect(slotOfProject(projects, projects[PROJECT_SLOTS - 1])).toBe(9);
        expect(slotOfProject(projects, projects[PROJECT_SLOTS])).toBeUndefined();
        expect(slotOfProject(projects, projects[11])).toBeUndefined();
    });

    it('gives a project that is not in the list no slot', () => {
        expect(slotOfProject(own(2), project('prj_gone'))).toBeUndefined();
    });
});
