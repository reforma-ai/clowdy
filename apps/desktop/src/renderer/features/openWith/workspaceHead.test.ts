import { describe, expect, it } from 'vitest';

import { workspaceHead } from './workspaceHead';

import type { ProjectWorkspaceInfo } from '@clowdy/protocol';

const made = { id: 'wks_1', branch: 'clowdy/ab12cd34', ready: true };
const read: ProjectWorkspaceInfo[] = [
    { workspaceId: 'wks_1', exists: true, branch: 'feature/other' },
    { workspaceId: 'wks_2', exists: false },
];

describe("the head of a chat's worktree", () => {
    it('is the branch it has now, not the one it was made with', () => {
        expect(workspaceHead(made, read)).toEqual({ branch: 'feature/other' });
    });

    it('is a short hash, marked detached, on a detached HEAD', () => {
        expect(
            workspaceHead(made, [{ workspaceId: 'wks_1', exists: true, branch: '5c4d3e2', detached: true }])
        ).toEqual({ branch: '5c4d3e2', detached: true });
    });

    it('is nothing while no read has answered, or when the read has no word on it, once it is made', () => {
        expect(workspaceHead(made, undefined)).toBeUndefined();
        expect(workspaceHead(made, [])).toBeUndefined();
        expect(workspaceHead({ ...made, id: 'wks_3' }, read)).toBeUndefined();
    });

    it('is the branch it will be made on while it is not made, whatever the read says', () => {
        expect(workspaceHead({ ...made, ready: false }, read)).toEqual({ branch: 'clowdy/ab12cd34' });
        expect(workspaceHead({ ...made, ready: false }, undefined)).toEqual({ branch: 'clowdy/ab12cd34' });
        expect(workspaceHead({ id: 'wks_1', ready: false }, undefined)).toEqual({});
    });

    it('says it is gone when it was made and the read says it is not on the disk', () => {
        expect(workspaceHead({ ...made, id: 'wks_2' }, read)).toEqual({ gone: true });
    });
});
