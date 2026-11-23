import { isBusyRunStatus } from '@clowdy/protocol';
import { useEffect, useRef } from 'react';

import { useProjectState } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import { chatPlace, isPlaceReady } from '../sidePanel/currentPlace';
import { useGitFactsStore } from './useGitFacts';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * Reads the git facts of the chat's place again when the chat's run ends (it is no longer busy), since the agent has most likely changed files, committed or pushed. The facts are
 * read for as long as something shows them (the Info tab, the Changes tab); this only says when to read again, and a place that nothing observes is left alone (`GitFacts.refresh`).
 * The chat view calls it, so the answer is fresh whichever tab is open when the turn ends.
 */
export function useRefreshGitFactsAtRunEnd(chat: Chat, run: Run | undefined): void {
    const project = useProjectState();
    const store = useGitFactsStore();
    const { folders } = project.project;
    const place = chatPlace(folders, chat, chatFolder(project.chats, folders, chat.id)?.folder);
    const ready = isPlaceReady(place);
    const projectId = project.id;
    const folderId = place.folder.id;
    const workspaceId = place.workspace?.id;
    const busy = run !== undefined && isBusyRunStatus(run.status);
    const wasBusy = useRef(busy);

    useEffect(() => {
        if (wasBusy.current && !busy && ready) store.refresh({ projectId, folderId, ...(workspaceId !== undefined && { workspaceId }) });

        wasBusy.current = busy;
    }, [busy, ready, store, projectId, folderId, workspaceId]);
}
