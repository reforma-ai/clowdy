import {
    commandSchema,
    GIT_BRANCH_MERGE_STRATEGIES,
    MAX_ATTACHMENT_BYTES,
    mainFolder,
    PROTOCOL_VERSION,
    parseGitScope,
} from '@clowdy/protocol';
import { z } from 'zod';

import { contentDisposition, servedMediaType } from '../attachments/names';
import { executeCommandAsync, waitsForAgent } from '../commands';
import { getRun } from '../db/runs';
import { clearViewed, listViewed, setViewed } from '../db/viewed';
import { docsTree } from '../docs/tree';
import { requireChat } from '../domain/chats';
import { streamItems } from '../domain/items';
import { resolvePlace, resolveWorkspacePlace } from '../domain/places';
import { findProjectIcon } from '../domain/projectIcon';
import { projectsInfo, requireProject } from '../domain/projects';
import { projectSnapshot, rootSnapshot, taskDetail, taskDetailByKey } from '../domain/snapshots';
import { archivedTasksPage } from '../domain/taskArchive';
import { taskCommentsPage } from '../domain/taskComments';
import { DEFAULT_LIMIT } from '../domain/taskQuery';
import { workspaceRemoval } from '../domain/workspaceRemoval';
import { projectWorktrees } from '../domain/worktrees';
import { CommandError, invalid, notFound } from '../errors';
import { placeBranches } from '../git/branches';
import { placeChanges, placeFile } from '../git/changes';
import { projectFolderGit } from '../git/state';
import { placeStatus } from '../git/status';
import { checkRevision, checkViewedPath, viewedScopeKey } from '../git/viewed';
import { BodyTooLarge, declaredLength, JSON_BODY_LIMIT, readJson, readText } from './body';
import { commandResponse, failure, json } from './responses';
import { eventStream, gitSyncStream } from './sse';

import type {
    GitRemoteAction,
    GitViewedMark,
    Health,
    Project,
    TaskArchivePage,
    TaskCommentsPage,
} from '@clowdy/protocol';
import type { Services } from '../commands';
import type { ViewedPlace } from '../db/viewed';
import type { Place } from '../domain/places';
import type { BaseOptions } from '../git/status';

export interface RouteContext {
    services: Services;
    startedAt: number;
    version: string;
    heartbeatMs?: number;
    shutdown(): void;
    /** Lets a long-lived response opt out of the server's idle timeout. */
    keepOpen(request: Request): void;
}

export interface Route {
    method: 'GET' | 'POST' | 'DELETE';
    pattern: RegExp;
    /** Only the health check is open. */
    open?: boolean;
    /** The most bytes of request body the route takes; `JSON_BODY_LIMIT` when absent. Only an upload asks for more. */
    maxBody?: number;
    handle(request: Request, url: URL, params: string[]): Response | Promise<Response>;
}

/**
 * An upload may be a little over `MAX_ATTACHMENT_BYTES` on the wire before the daemon looks: past it Bun refuses the request with its
 * own bare 413, up to it the route answers with a JSON error that says what the limit is.
 */
const UPLOAD_BODY_SLACK = 1024 * 1024;

/** The body of `POST .../git/viewed` (`GitViewedSet`): the place, the scope, the file and its revision, each judged by the route. */
const viewedBody = z.object({
    folderId: z.string(),
    workspaceId: z.string().optional(),
    scope: z.string(),
    path: z.string(),
    revision: z.string(),
});

/** How many paths a file search answers with when it is not told, and the most it ever does. */
const DEFAULT_FILE_LIMIT = 40;
const MAX_FILE_LIMIT = 100;

/** The bodies of the two git writes: the place (`folderId`, and the worktree when there is one) and the ticked files; what is wrong with them is the route's to say (`selectChanged`). */
const gitCommitBody = z.object({
    folderId: z.string(),
    workspaceId: z.string().optional(),
    paths: z.array(z.string()),
    message: z.string(),
    conclude: z.literal(true).optional(),
});
const gitMessageBody = z.object({
    folderId: z.string(),
    workspaceId: z.string().optional(),
    paths: z.array(z.string()),
});
/** The body of `POST .../git/discard` (`GitDiscardRequest`): the place and the files, which the route judges (`selectChanged`, at most `MAX_GIT_DISCARD_PATHS`). */
const gitDiscardBody = z.object({
    folderId: z.string(),
    workspaceId: z.string().optional(),
    paths: z.array(z.string()),
});

/** The place of a remote action, with an optional expected head for push. */
const gitRemoteBody = z.object({ folderId: z.string(), workspaceId: z.string().optional() });
const gitCommitHash = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const gitPushBody = gitRemoteBody.extend({
    expectedHead: z.object({ branch: z.string().min(1), commit: gitCommitHash }).optional(),
});
const gitSyncBase = gitRemoteBody.extend({ branch: z.string().min(1).max(250) });
const gitSyncBody = z.union([
    gitSyncBase.extend({ destination: z.literal(false).optional(), commit: gitCommitHash.optional() }),
    gitSyncBase.extend({ destination: z.literal(true), commit: gitCommitHash }),
]);

const gitMergeSelection = {
    ...gitRemoteBody.shape,
    direction: z.enum(['from', 'into']),
    current: z.string(),
    branch: z.string(),
    remote: z.literal(true).optional(),
    strategy: z.enum(GIT_BRANCH_MERGE_STRATEGIES).optional(),
};
const gitMergeTarget = { ...gitRemoteBody.shape, target: z.string(), commit: gitCommitHash };

const gitMergeBody = z.discriminatedUnion('action', [
    z.object({ ...gitMergeSelection, action: z.literal('preview') }),
    z.object({
        ...gitMergeSelection,
        action: z.literal('merge'),
        sourceCommit: gitCommitHash,
        targetCommit: gitCommitHash,
        expectedMode: z.enum(['up-to-date', 'fast-forward', 'merge-commit', 'squash', 'rebase']).optional(),
    }),
    z.object({ ...gitMergeTarget, action: z.literal('push') }),
    z.object({
        ...gitMergeTarget,
        action: z.literal('abort'),
        sourceCommit: gitCommitHash,
        operation: z.literal('rebase').optional(),
    }),
]);

/** The body of `POST .../git/switch` (`GitSwitchRequest`): the place, the branch and, for a new one, where it starts; what is wrong with the name or the start is the switch's to say. */
const gitSwitchBody = z.object({
    folderId: z.string(),
    workspaceId: z.string().optional(),
    branch: z.string(),
    create: z.object({ start: z.string() }).optional(),
});

function integerParam(raw: string | null, name: string, fallback: number): number {
    if (raw === null) {
        return fallback;
    }

    // Digits only: `Number` would also take '', '1e3', '0x10' and ' 5'.
    if (!/^\d+$/.test(raw)) {
        throw invalid(`${name} must be a non-negative integer`);
    }

    return Number(raw);
}

export function createRoutes(context: RouteContext): Route[] {
    const { services } = context;
    const { store, files, skills, attachments } = services;
    /** The worktree a request of the documents or the file names asks for (`workspaceId`), in place of its folder's own checkout; none when it names no workspace. */
    const workspacePlaceOf = (project: Project, url: URL) => {
        const workspaceId = url.searchParams.get('workspaceId');

        return workspaceId ? resolveWorkspacePlace(store, project, workspaceId) : undefined;
    };

    /** The place a request of the git reads names: the folder's own checkout, or its worktree (`workspaceId`), judged by `resolvePlace` as the file routes' are. */
    const gitPlaceOf = (projectId: string, url: URL) =>
        resolvePlace(
            store,
            requireProject(store, projectId),
            url.searchParams.get('folderId') ?? '',
            url.searchParams.get('workspaceId') ?? undefined
        );
    /** The base of the place's pull request, when `GET .../git/pull-request` found one lately, for the reads that compare a place with its base: they never ask GitHub themselves. */
    const gitBaseOf = async (place: Place): Promise<BaseOptions> => {
        const base = await services.pullRequests.baseHint(place);

        return base === undefined ? {} : { base };
    };
    /** The place the marks of viewed files are kept under: the project's folder, and the worktree of it when the place is one (empty for the folder's own checkout). */
    const viewedPlaceOf = (projectId: string, place: Place): ViewedPlace => ({
        projectId,
        folderId: place.folder.id,
        workspaceId: place.workspace?.id ?? '',
    });
    /** The scope a request of the changes asks for: `all` when it names none. */
    const gitScopeOf = (url: URL) => {
        const scope = parseGitScope(url.searchParams.get('scope') ?? 'all');

        if (!scope) {
            throw invalid('The scope is none of all, branch, uncommitted, commit:<hash> and turn:<tree>:<tree>');
        }

        return scope;
    };

    return [
        {
            method: 'GET',
            pattern: /^\/v1\/health$/,
            open: true,
            handle: () =>
                json({
                    ok: true,
                    protocol: PROTOCOL_VERSION,
                    version: context.version,
                    pid: process.pid,
                    startedAt: context.startedAt,
                    activeRuns: services.runs.activeCount(),
                } satisfies Health),
        },
        {
            method: 'POST',
            pattern: /^\/v1\/shutdown$/,
            handle: () => {
                context.shutdown();

                return json({ ok: true });
            },
        },
        { method: 'GET', pattern: /^\/v1\/snapshot$/, handle: () => json(rootSnapshot(store)) },
        // `info` is not a project id (they all start with `prj_`), and the pattern is exact, so no route below can take it for one.
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/info$/,
            handle: async (_request, url) =>
                json(await projectsInfo(store, url.searchParams.get('project') ?? undefined)),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/snapshot$/,
            handle: (_request, _url, [id]) => json(projectSnapshot(store, id)),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/events$/,
            handle: (request, url) => {
                const head = store.headCursor();
                const cursor = integerParam(
                    url.searchParams.get('cursor') ?? request.headers.get('last-event-id'),
                    'cursor',
                    head
                );

                if (cursor > head) {
                    return json(
                        {
                            ok: false,
                            error: {
                                code: 'invalid',
                                message:
                                    'The cursor is ahead of the event log; fetch a new snapshot and resume from its cursor',
                                details: { cursor, head },
                            },
                        },
                        410
                    );
                }

                context.keepOpen(request);

                return new Response(
                    eventStream(store, cursor, url.searchParams.get('projectId') ?? undefined, context.heartbeatMs),
                    {
                        headers: {
                            'content-type': 'text/event-stream; charset=utf-8',
                            'cache-control': 'no-cache, no-transform',
                            'x-accel-buffering': 'no',
                        },
                    }
                );
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/commands$/,
            handle: async request => {
                let body: unknown;

                try {
                    body = JSON.parse(await readText(request, JSON_BODY_LIMIT));
                } catch (error) {
                    if (error instanceof BodyTooLarge) {
                        throw error;
                    }

                    return failure('invalid', 'The body is not valid JSON', undefined, '');
                }

                const parsed = commandSchema.safeParse(body);
                const requestId =
                    typeof (body as { requestId?: unknown } | null)?.requestId === 'string'
                        ? (body as { requestId: string }).requestId
                        : '';

                if (!parsed.success) {
                    return failure(
                        'invalid',
                        'The command is not valid',
                        parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
                        requestId
                    );
                }

                // A fork or an edit waits for the agent's process, and a delete that removes a worktree for git: either may outlast the idle timeout of a connection that sends nothing meanwhile.
                if (waitsForAgent(parsed.data)) {
                    context.keepOpen(request);
                }

                return commandResponse(await executeCommandAsync(services, parsed.data));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/runs\/([^/]+)\/items$/,
            handle: (_request, url, [id]) => {
                if (!getRun(store.db, id)) {
                    throw notFound('Run', id);
                }

                return json(streamItems(store, id, integerParam(url.searchParams.get('after'), 'after', 0)));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/chats\/([^/]+)\/items$/,
            handle: (_request, url, [id]) => {
                const runId = requireChat(store, id).orchestratorRunId;

                return json(
                    runId ? streamItems(store, runId, integerParam(url.searchParams.get('after'), 'after', 0)) : []
                );
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/chats\/([^/]+)\/workspace$/,
            handle: async (_request, _url, [id]) => json(await workspaceRemoval(store, id)),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/tasks\/([^/]+)\/detail$/,
            handle: (_request, _url, [id]) => json(taskDetail(store, id)),
        },
        // The same answer by a task's key within a project; the key segment is escaped by the client like any other.
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/detail$/,
            handle: (_request, _url, [id, key]) => json(taskDetailByKey(store, id, key)),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/tasks\/([^/]+)\/comments$/,
            handle: (_request, url, [id]) => {
                const { comments, total, nextCursor } = taskCommentsPage(store, id, {
                    limit: integerParam(url.searchParams.get('limit'), 'limit', DEFAULT_LIMIT),
                    cursor: url.searchParams.get('cursor') ?? undefined,
                });

                return json({
                    comments,
                    total,
                    ...(nextCursor !== undefined && { nextCursor }),
                } satisfies TaskCommentsPage);
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/archived-tasks$/,
            handle: (_request, url, [id]) => {
                const { tasks, total, nextCursor } = archivedTasksPage(store, id, {
                    limit: integerParam(url.searchParams.get('limit'), 'limit', DEFAULT_LIMIT),
                    cursor: url.searchParams.get('cursor') ?? undefined,
                });

                return json({
                    tasks,
                    total,
                    ...(nextCursor !== undefined && { nextCursor }),
                } satisfies TaskArchivePage);
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/git$/,
            handle: async (_request, url, [id]) =>
                json(await projectFolderGit(requireProject(store, id), url.searchParams.get('folderId') ?? '')),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/status$/,
            handle: async (_request, url, [id]) => {
                const place = gitPlaceOf(id, url);

                return json(await placeStatus(place, await gitBaseOf(place)));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/changes$/,
            handle: async (_request, url, [id]) => {
                const place = gitPlaceOf(id, url);

                return json(await placeChanges(place, gitScopeOf(url), await gitBaseOf(place)));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/branches$/,
            handle: async (_request, url, [id]) => {
                const project = requireProject(store, id);

                return json(
                    await placeBranches(
                        store,
                        project,
                        resolvePlace(
                            store,
                            project,
                            url.searchParams.get('folderId') ?? '',
                            url.searchParams.get('workspaceId') ?? undefined
                        )
                    )
                );
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/file$/,
            handle: async (_request, url, [id]) => {
                const place = gitPlaceOf(id, url);
                // A card sends the start of the list it belongs to: with it nothing is looked up to find the base (and the pull request's hint is not asked).
                const from = url.searchParams.get('from') ?? undefined;

                return json(
                    await placeFile(
                        place,
                        gitScopeOf(url),
                        url.searchParams.get('path') ?? '',
                        url.searchParams.get('oldPath') ?? undefined,
                        from === undefined ? await gitBaseOf(place) : { from }
                    )
                );
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/viewed$/,
            handle: async (_request, url, [id]) => {
                const place = gitPlaceOf(id, url);
                const key = await viewedScopeKey(place, gitScopeOf(url), await gitBaseOf(place));

                return json(listViewed(store.db, viewedPlaceOf(id, place), key) satisfies GitViewedMark[]);
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/viewed$/,
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, viewedBody);
                const scope = parseGitScope(body.scope);

                if (!scope) {
                    throw invalid(
                        'The scope is none of all, branch, uncommitted, commit:<hash> and turn:<tree>:<tree>'
                    );
                }

                checkViewedPath(body.path);
                checkRevision(body.revision);

                const place = resolvePlace(store, requireProject(store, id), body.folderId, body.workspaceId);
                const key = await viewedScopeKey(place, scope, await gitBaseOf(place));
                const mark = { path: body.path, revision: body.revision } satisfies GitViewedMark;

                store.tx(() => setViewed(store.db, viewedPlaceOf(id, place), key, mark, Date.now()));

                return json(mark);
            },
        },
        {
            method: 'DELETE',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/viewed$/,
            handle: async (_request, url, [id]) => {
                const path = url.searchParams.get('path') ?? '';

                checkViewedPath(path);

                const place = gitPlaceOf(id, url);
                const key = await viewedScopeKey(place, gitScopeOf(url), await gitBaseOf(place));

                store.tx(() => clearViewed(store.db, viewedPlaceOf(id, place), key, path));

                return json({ ok: true });
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/worktrees$/,
            handle: async (_request, _url, [id]) => json(await projectWorktrees(store, requireProject(store, id))),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/pull-request$/,
            handle: async (_request, url, [id]) => json(await services.pullRequests.read(gitPlaceOf(id, url))),
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/commit$/,
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, gitCommitBody);
                const place = resolvePlace(store, requireProject(store, id), body.folderId, body.workspaceId);

                // A commit may wait for a fingerprint (a signing key that asks for one), longer than the connection's idle timeout.
                context.keepOpen(request);

                return json(await services.gitWrites.commit(place, body));
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/discard$/,
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, gitDiscardBody);
                const project = requireProject(store, id);
                const place = resolvePlace(store, project, body.folderId, body.workspaceId);

                // The copy of a few files and a restore are quick, but a filter that has to fetch (Git LFS) may take longer than the connection's idle timeout.
                context.keepOpen(request);

                return json(await services.gitDiscard.discard(place, { projectId: project.id, paths: body.paths }));
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/sync$/,
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, gitSyncBody);
                const place = resolvePlace(store, requireProject(store, id), body.folderId, body.workspaceId);

                context.keepOpen(request);

                return new Response(
                    gitSyncStream(progress =>
                        services.gitRemote.sync(place, body, progress, target =>
                            services.pullRequests.forget(target).catch(() => undefined)
                        )
                    ),
                    {
                        headers: {
                            'content-type': 'text/event-stream; charset=utf-8',
                            'cache-control': 'no-cache, no-transform',
                            'x-accel-buffering': 'no',
                        },
                    }
                );
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/(fetch|pull|push|update|abort)$/,
            handle: async (request, _url, [id, action]) => {
                const body = await readJson(request, gitPushBody);
                const place = resolvePlace(store, requireProject(store, id), body.folderId, body.workspaceId);

                // A fetch or a push over SSH may wait for a fingerprint, longer than the connection's idle timeout.
                context.keepOpen(request);

                try {
                    const remote = services.gitRemote;
                    return json(
                        action === 'push'
                            ? await remote.push(place, body.expectedHead)
                            : await remote[action as Exclude<GitRemoteAction, 'push'>](place)
                    );
                } finally {
                    // What GitHub says of the branch moves with what was sent (a pull request opened, its checks started): the next read of it asks again, not after the short while it is kept.
                    await services.pullRequests.forget(place).catch(() => undefined);
                }
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/merge$/,
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, gitMergeBody);
                const place = resolvePlace(store, requireProject(store, id), body.folderId, body.workspaceId);

                context.keepOpen(request);

                try {
                    return json(await services.gitBranchMerge.run(place, body));
                } finally {
                    if (body.action !== 'preview') await services.pullRequests.forget(place).catch(() => undefined);
                }
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/switch$/,
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, gitSwitchBody);
                const project = requireProject(store, id);
                const place = resolvePlace(store, project, body.folderId, body.workspaceId);

                // A `post-checkout` hook of the person's may take a while, longer than the connection's idle timeout.
                context.keepOpen(request);

                return json(await services.gitSwitch.switch(project, place, body));
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/git\/message$/,
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, gitMessageBody);
                const place = resolvePlace(store, requireProject(store, id), body.folderId, body.workspaceId);

                // The agent has 30 seconds, and the place's other requests for a message may be ahead of this one.
                context.keepOpen(request);

                try {
                    return json(await services.commitMessages.generate(place, body.paths, request.signal));
                } catch (error) {
                    if (request.signal.aborted) return new Response(null, { status: 499 });
                    throw error;
                }
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/docs$/,
            handle: (_request, url, [id]) => {
                const project = requireProject(store, id);

                return json(docsTree(project, workspacePlaceOf(project, url)));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/files$/,
            handle: async (_request, url, [id]) => {
                const limit = Math.min(
                    Math.max(integerParam(url.searchParams.get('limit'), 'limit', DEFAULT_FILE_LIMIT), 1),
                    MAX_FILE_LIMIT
                );

                const project = requireProject(store, id);

                return json(
                    await files.search(
                        project,
                        url.searchParams.get('query') ?? '',
                        limit,
                        workspacePlaceOf(project, url)
                    )
                );
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/attachments$/,
            maxBody: MAX_ATTACHMENT_BYTES + UPLOAD_BODY_SLACK,
            handle: async (request, url, [id]) =>
                json(
                    await attachments.upload(requireProject(store, id), {
                        name: url.searchParams.get('name'),
                        contentType: request.headers.get('content-type'),
                        body: request.body,
                        declaredLength: declaredLength(request),
                    })
                ),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/attachments\/([^/]+)$/,
            handle: (_request, _url, [id, attachmentId]) => {
                const { record, path } = attachments.read(requireProject(store, id).id, attachmentId);

                // The bytes of a stranger's file next to the daemon's API: nothing here may be taken for a page, whatever its name says.
                return new Response(Bun.file(path), {
                    headers: {
                        'content-type': servedMediaType(record.mediaType),
                        'content-disposition': contentDisposition(record.name),
                        'x-content-type-options': 'nosniff',
                        'content-security-policy': 'sandbox',
                    },
                });
            },
        },
        {
            method: 'DELETE',
            pattern: /^\/v1\/projects\/([^/]+)\/attachments\/([^/]+)$/,
            handle: (_request, _url, [id, attachmentId]) => {
                attachments.remove(requireProject(store, id).id, attachmentId);

                return json({ ok: true });
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/icon$/,
            handle: (_request, _url, [id]) => {
                const project = requireProject(store, id);
                const icon = project.personal ? undefined : findProjectIcon(mainFolder(project).path);

                if (!icon) {
                    throw new CommandError('not_found', `${project.name} has no icon in its main folder`);
                }

                // A file of the project's own, read by the app as a picture; nothing here may be taken for a page.
                return new Response(Bun.file(icon.path), {
                    headers: {
                        'content-type': icon.mediaType,
                        'x-content-type-options': 'nosniff',
                        'content-security-policy': 'sandbox',
                        'cache-control': 'no-store',
                    },
                });
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/agents$/,
            handle: async () => json(services.providers.decorate(await services.agents.list())),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/agents\/([^/]+)\/models$/,
            handle: async (_request, _url, [id]) => {
                if (!services.agents.has(id!)) {
                    throw notFound('Agent', id!);
                }

                return json(await services.models.get(id!));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/skills$/,
            handle: (_request, url) => {
                const projectId = url.searchParams.get('projectId');

                return json(skills.catalog(projectId === null ? undefined : requireProject(store, projectId)));
            },
        },
    ];
}
