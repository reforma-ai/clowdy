import { Text } from '@clowdy/components/Text';
import { useMemo } from 'react';

import { useProjectState, useRunStream } from '../../stores';
import { beginsWithPrompt, parentPrompt, promptItem } from '../../stream/subagents';
import { ConversationHeader } from '../chats/ConversationHeader';
import { ConversationView } from '../chats/ConversationView';
import { SubagentBox } from '../chats/SubagentBox';
import { useStreamLinks } from '../chats/useStreamLinks';
import { chatOfRun } from './agentTree';

import type { Run } from '@clowdy/protocol';

/**
 * The page of a native sub-agent: the conversation page a chat has, over the sub-agent's own stream, which begins as a thread's does with the card of what its parent asked
 * (`Message from <the chat>`). Its box is the chat's with nothing to type (`SubagentBox`), the header over the stream is the path to it (`ConversationHeader`), and it has none of the chat's banners,
 * nor a Reply, a Fork or an Edit on its messages.
 */
export function RunDetail({ run }: { run: Run }) {
    const project = useProjectState();
    const links = useStreamLinks();
    const stream = useRunStream(run.id);
    const chat = chatOfRun(project.chats.values(), run);
    const items = stream?.items ?? [];
    // A sub-agent stored before its first message was written has none: the page makes the card from the call that started it, in its parent's stream, which is fetched with
    // its own so the card does not come in after the page has begun to be read.
    const parent = useRunStream(run.parentToolCallId ? run.parentRunId : undefined);
    const parentItems = parent?.items;
    const lacksPrompt = (stream?.status === 'ready' || items.length > 0) && !beginsWithPrompt(items);
    const parentReady =
        parent !== undefined && ((parent.status !== 'idle' && parent.status !== 'loading') || parentItems!.length > 0);
    const text = lacksPrompt && parentItems ? parentPrompt(run, parentItems) : undefined;
    // The parent's stream changes while it works: the item stays the same object while what it is made from does.
    const leading = useMemo(
        () =>
            text !== undefined && chat
                ? promptItem({ id: run.id, startedAt: run.startedAt, createdAt: run.createdAt }, text, {
                      id: chat.id,
                      title: chat.title,
                  })
                : undefined,
        [text, run.id, run.startedAt, run.createdAt, chat?.id, chat?.title]
    );

    return (
        <ConversationView
            run={run}
            stream={stream}
            links={links}
            leading={leading}
            holding={lacksPrompt && parent !== undefined && !parentReady}
            top={<ConversationHeader chat={chat} subagent={run} />}
            // Copy and the time stay, as in a chat that is read only; there is no one to reply to, fork or edit.
            messageActions={{}}
            // A sub-agent has no row of its work above a box to say it rests for its background work, so its stream does.
            backgroundLine="Waiting for background work…"
            emptyState={<Text color="secondary">This sub-agent has not written anything yet</Text>}
            bottom={<SubagentBox run={run} />}
        />
    );
}
