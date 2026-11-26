import { describe, expect, it } from 'vitest';

import { chatItems, docItems, docPaths, fileItems, skillItems, skillName, taskItems } from './mentionItems';

import type { Chat, DocNode, DocsSource, ProjectFolder, SkillEntry, Task } from '@clowdy/protocol';

const task = (number: number, title: string): Task =>
    ({ id: `t-${number}`, number, key: `CAR-${number}`, title }) as Task;
const skill = (name: string, source: SkillEntry['source'], fields: Partial<SkillEntry> = {}): SkillEntry => ({
    id: `${source}:${name}`,
    name,
    source,
    description: `${name} skill`,
    enabled: true,
    tokens: 20,
    engines: [],
    ...fields,
});

describe('taskItems', () => {
    const tasks = [
        task(20, 'Move availability into one API call'),
        task(24, 'Rebuild the form as one view'),
        task(25, 'Send a confirmation email'),
    ];

    it('lists the newest first when nothing is typed', () => {
        expect(taskItems(tasks, '').map(item => item.label)).toEqual(['CAR-25', 'CAR-24', 'CAR-20']);
    });

    it('finds a task by a word of its title or by its key, in any case', () => {
        expect(taskItems(tasks, 'FORM').map(item => item.label)).toEqual(['CAR-24']);
        expect(taskItems(tasks, 'car-2 one').map(item => item.label)).toEqual(['CAR-24', 'CAR-20']);
        expect(taskItems(tasks, 'nothing like it')).toEqual([]);
    });

    it('carries the key for the message and the title for the hover', () => {
        expect(taskItems(tasks, '25')[0]).toMatchObject({
            kind: 'task',
            section: 'Tasks',
            displayText: 'CAR-25',
            data: { key: 'CAR-25', title: 'Send a confirmation email' },
        });
    });
});

describe('chatItems', () => {
    const chat = (id: string, title: string, updatedAt: number, archivedAt?: number): Chat => ({
        id,
        title,
        updatedAt,
        archivedAt,
        projectId: 'p',
        mode: 'autopilot',
        createdAt: 0,
    });
    const chats = [
        chat('c-1', 'Current chat', 10),
        chat('c-2', 'Review the architecture', 2),
        chat('c-3', 'Review the API', 3),
        chat('c-4', 'Old architecture review', 9, 9),
    ];

    it('excludes the current chat, lists active chats by recency, then archived chats', () => {
        expect(chatItems(chats, '', 'c-1').map(item => item.label)).toEqual([
            'Review the API',
            'Review the architecture',
            'Old architecture review',
        ]);
    });

    it('matches title words case-insensitively and carries a stable ID', () => {
        expect(chatItems(chats, 'ARCH Review').map(item => item.value)).toEqual(['chat:c-2', 'chat:c-4']);
        expect(chatItems(chats, 'c-4')[0]).toMatchObject({
            value: 'chat:c-4',
            label: 'Old architecture review',
            description: 'Archived',
            section: 'Chats',
            kind: 'chat',
            data: { chatId: 'c-4', title: 'Old architecture review' },
        });
    });
});

describe('docs', () => {
    const nodes: DocNode[] = [
        {
            path: 'decisions',
            name: 'decisions',
            kind: 'dir',
            children: [{ path: 'decisions/pricing.md', name: 'pricing.md', kind: 'file' }],
        },
        { path: 'README.md', name: 'README.md', kind: 'file' },
    ];
    const folders: ProjectFolder[] = [
        { id: 'fld_app', path: '/work/app' },
        { id: 'fld_api', path: '/work/api' },
    ];
    /** The Documents source (`.clowdy/docs`) of a folder, with the files given. */
    const documents = (...files: DocNode[]): DocsSource => ({
        id: 'documents',
        label: 'Documents',
        root: '.clowdy/docs',
        nodes: files,
    });
    const briefback = (...files: DocNode[]): DocsSource => ({
        id: 'briefback',
        label: 'Briefback',
        root: '.briefback',
        nodes: files,
    });

    it('flattens a tree to the paths of its files', () => {
        expect(docPaths(nodes)).toEqual(['decisions/pricing.md', 'README.md']);
    });

    it('offers a document of one folder by its own path from that folder, under the root of its source', () => {
        expect(
            docItems([{ folderId: 'fld_app', sources: [documents(...nodes)] }], folders.slice(0, 1), 'pric')
        ).toMatchObject([
            {
                value: 'doc:fld_app:.clowdy/docs/decisions/pricing.md',
                label: 'pricing.md',
                description: '.clowdy/docs/decisions',
                kind: 'doc',
                section: 'Documents',
                data: { path: '.clowdy/docs/decisions/pricing.md' },
            },
        ]);
        expect(
            docItems([{ folderId: 'fld_app', sources: [documents(...nodes)] }], folders.slice(0, 1), 'readme')[0]
                ?.description
        ).toBe('.clowdy/docs');
    });

    it('offers the documents of every source of a folder, in the order of the sources, each by the root it is below', () => {
        const tree = [
            {
                folderId: 'fld_app',
                sources: [
                    briefback({
                        path: 'acp',
                        name: 'acp',
                        kind: 'dir',
                        children: [{ path: 'acp/plan.md', name: 'plan.md', kind: 'file' }],
                    }),
                    documents(...nodes),
                ],
            },
        ];

        expect(docItems(tree, folders.slice(0, 1), 'p').map(item => (item.data as { path: string }).path)).toEqual([
            '.briefback/acp/plan.md',
            '.clowdy/docs/decisions/pricing.md',
        ]);
        // The root is part of the path the words are matched in.
        expect(
            docItems(tree, folders.slice(0, 1), 'briefback plan').map(item => [item.label, item.description])
        ).toEqual([['plan.md', '.briefback/acp']]);
        expect(docItems(tree, folders.slice(0, 1), 'clowdy plan')).toEqual([]);
    });

    it('ranks the documents by name before it cuts the list, and lets no source fill it: a dozen plans of one source leave room for the others', () => {
        const plans = Array.from(
            { length: 8 },
            (_, index): DocNode => ({
                path: `feature-${index}`,
                name: `feature-${index}`,
                kind: 'dir',
                children: [{ path: `feature-${index}/plan.md`, name: 'plan.md', kind: 'file' }],
            })
        );
        const tree = [
            {
                folderId: 'fld_app',
                sources: [
                    briefback(...plans),
                    documents(
                        { path: 'plan.md', name: 'plan.md', kind: 'file' },
                        { path: 'plan-view.md', name: 'plan-view.md', kind: 'file' }
                    ),
                ],
            },
        ];
        const paths = docItems(tree, folders.slice(0, 1), 'plan').map(item => (item.data as { path: string }).path);

        expect(paths).toEqual([
            '.briefback/feature-0/plan.md',
            '.briefback/feature-1/plan.md',
            '.briefback/feature-2/plan.md',
            '.briefback/feature-3/plan.md',
            '.clowdy/docs/plan.md',
            '.clowdy/docs/plan-view.md',
        ]);
        // A document whose name has the word, though it starts with something else, comes after the ones whose name starts with it.
        expect(
            docItems(
                [
                    {
                        folderId: 'fld_app',
                        sources: [
                            documents(
                                { path: 'my-plan.md', name: 'my-plan.md', kind: 'file' },
                                { path: 'plan.md', name: 'plan.md', kind: 'file' }
                            ),
                        ],
                    },
                ],
                folders.slice(0, 1),
                'plan'
            ).map(item => item.label)
        ).toEqual(['plan.md', 'my-plan.md']);
    });

    it("offers the documents of every folder, another folder's by its absolute path, each with its folder's name", () => {
        const tree = [
            { folderId: 'fld_app', sources: [documents(...nodes)] },
            { folderId: 'fld_api', sources: [documents({ path: 'README.md', name: 'README.md', kind: 'file' })] },
        ];

        expect(
            docItems(tree, folders, 'readme').map(item => [
                item.value,
                item.description,
                (item.data as { path: string }).path,
            ])
        ).toEqual([
            ['doc:fld_app:.clowdy/docs/README.md', 'app/.clowdy/docs', '.clowdy/docs/README.md'],
            ['doc:fld_api:.clowdy/docs/README.md', 'api/.clowdy/docs', '/work/api/.clowdy/docs/README.md'],
        ]);
        // The folder's name is searched with the path.
        expect(docItems(tree, folders, 'api readme').map(item => item.value)).toEqual([
            'doc:fld_api:.clowdy/docs/README.md',
        ]);
        expect(docItems(tree, folders, 'pric')[0]?.description).toBe('app/.clowdy/docs/decisions');
    });

    it("cites a document by its path from the folder the chat works in, and another folder's by its absolute path", () => {
        const tree = [
            { folderId: 'fld_app', sources: [documents({ path: 'a.md', name: 'a.md', kind: 'file' })] },
            { folderId: 'fld_api', sources: [documents({ path: 'b.md', name: 'b.md', kind: 'file' })] },
        ];

        expect(docItems(tree, folders, '', 'fld_api').map(item => item.data)).toEqual([
            { path: '/work/app/.clowdy/docs/a.md' },
            { path: '.clowdy/docs/b.md' },
        ]);
        expect(docItems(tree, folders, '').map(item => item.data)).toEqual([
            { path: '.clowdy/docs/a.md' },
            { path: '/work/api/.clowdy/docs/b.md' },
        ]);
    });

    it('offers nothing for a folder with no source', () => {
        expect(docItems([{ folderId: 'fld_app', sources: [] }], folders.slice(0, 1), '')).toEqual([]);
    });

    it("writes another folder's path with the separator of a Windows folder", () => {
        const tree = [
            { folderId: 'fld_app', sources: [] },
            { folderId: 'fld_win', sources: [documents({ path: 'notes/a.md', name: 'a.md', kind: 'file' })] },
        ];

        expect(docItems(tree, [folders[0]!, { id: 'fld_win', path: 'C:\\work\\api' }], '')[0]?.data).toEqual({
            path: 'C:\\work\\api\\.clowdy\\docs\\notes\\a.md',
        });
    });
});

describe('fileItems', () => {
    const folders: ProjectFolder[] = [
        { id: 'fld_app', path: '/work/app' },
        { id: 'fld_api', path: '/work/api' },
    ];
    const view = (items: ReturnType<typeof fileItems>) =>
        items.map(item => [item.value, item.label, item.description, (item.data as { path: string }).path]);

    it('offers a file of a project of one folder by its path from there, as the daemon ranked it', () => {
        expect(
            view(
                fileItems(
                    [
                        { folderId: 'fld_app', path: 'src/booking/price.ts' },
                        { folderId: 'fld_app', path: 'README.md' },
                    ],
                    folders.slice(0, 1)
                )
            )
        ).toEqual([
            ['file:fld_app:src/booking/price.ts', 'price.ts', 'src/booking', 'src/booking/price.ts'],
            ['file:fld_app:README.md', 'README.md', undefined, 'README.md'],
        ]);
    });

    it("offers the files of every folder, another folder's by its absolute path, each under its folder's name", () => {
        const matches = [
            { folderId: 'fld_api', path: 'src/price.ts' },
            { folderId: 'fld_app', path: 'src/booking/price.ts' },
            { folderId: 'fld_api', path: 'README.md' },
        ];

        expect(view(fileItems(matches, folders))).toEqual([
            ['file:fld_api:src/price.ts', 'price.ts', 'api/src', '/work/api/src/price.ts'],
            ['file:fld_app:src/booking/price.ts', 'price.ts', 'app/src/booking', 'src/booking/price.ts'],
            ['file:fld_api:README.md', 'README.md', 'api', '/work/api/README.md'],
        ]);
    });

    it("writes another folder's path with the separator of a Windows folder", () => {
        const windows: ProjectFolder[] = [
            { id: 'fld_app', path: 'C:\\work\\app' },
            { id: 'fld_api', path: 'C:\\work\\api\\' },
        ];

        expect(
            fileItems(
                [
                    { folderId: 'fld_api', path: 'src/routes/a.ts' },
                    { folderId: 'fld_app', path: 'src/b.ts' },
                ],
                windows
            ).map(item => item.data)
        ).toEqual([{ path: 'C:\\work\\api\\src\\routes\\a.ts' }, { path: 'src/b.ts' }]);
    });

    it('leaves out a file of a folder the project no longer has', () => {
        expect(fileItems([{ folderId: 'fld_gone', path: 'a.ts' }], folders)).toEqual([]);
    });

    it('cites a file by its path from the folder the chat works in, which is its working directory, and the others by their absolute paths', () => {
        const matches = [
            { folderId: 'fld_api', path: 'src/price.ts' },
            { folderId: 'fld_app', path: 'src/booking/price.ts' },
        ];

        // A chat in the second folder: its own files are relative, the main folder's are not.
        expect(fileItems(matches, folders, 'fld_api').map(item => item.data)).toEqual([
            { path: 'src/price.ts' },
            { path: '/work/app/src/booking/price.ts' },
        ]);
        expect(fileItems(matches, folders, 'fld_app').map(item => item.data)).toEqual([
            { path: '/work/api/src/price.ts' },
            { path: 'src/booking/price.ts' },
        ]);
    });
});

describe('skillItems', () => {
    const entries = [
        skill('clowdy:orchestrate', 'system'),
        skill('user:deploy', 'user'),
        skill('deploy', 'project'),
        skill('user:lint', 'user', { enabled: false }),
        skill('review', 'project', { description: 'Reviews a diff' }),
    ];

    it('names a user skill by its folder', () => {
        expect(skillName({ name: 'user:deploy' })).toBe('deploy');
        expect(skillName({ name: 'review' })).toBe('review');
    });

    it('leaves out system skills and skills that are off, and lists a shared name once', () => {
        expect(skillItems(entries, '').map(item => item.label)).toEqual(['/deploy', '/review']);
    });

    it('searches the name and the description', () => {
        expect(skillItems(entries, 'diff').map(item => item.label)).toEqual(['/review']);
    });

    it('carries the name the message asks for', () => {
        expect(skillItems(entries, 'review')[0]).toMatchObject({
            kind: 'command',
            displayText: '/review',
            data: { name: 'review' },
        });
    });
});
