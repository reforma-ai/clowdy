import { Text } from '@clowdy/components/Text';
import { Robot } from '@clowdy/icons/14';

import { useRunLabel } from '../../shared';
import { useProjectState, useRunStream } from '../../stores';
import { ConversationCrumb } from '../chats/ConversationCrumb';
import { ConversationView } from '../chats/ConversationView';
import { SubagentBox } from '../chats/SubagentBox';
import { useStreamLinks } from '../chats/useStreamLinks';
import { chatOfRun } from './agentTree';

import type { Run } from '@clowdy/protocol';

/**
 * The page of a native sub-agent: the conversation page a chat has, over the sub-agent's own stream. Its box is the chat's with nothing to type
 * (`SubagentBox`), the line over the stream says whose sub-agent it is, and it has none of the chat's banners, nor a Reply, a Fork or an Edit on its messages.
 */
export function RunDetail({ run }: { run: Run }) {
    const project = useProjectState();
    const label = useRunLabel();
    const links = useStreamLinks();
    const stream = useRunStream(run.id);
    const chat = chatOfRun(project.chats.values(), run);

    return (
        <ConversationView
            run={run}
            stream={stream}
            top={
                chat && (
                    <ConversationCrumb
                        label="Chat of the sub-agent"
                        icon={<Robot />}
                        lead={`${label(run)} in`}
                        title={chat.title}
                        onOpen={() => links.onOpenChat(chat.id)}
                    />
                )
            }
            // Copy and the time stay, as in a chat that is read only; there is no one to reply to, fork or edit.
            messageActions={{}}
            // A sub-agent has no row of its work above a box to say it rests for its background work, so its stream does.
            backgroundLine="Waiting for background work…"
            emptyState={<Text color="secondary">This sub-agent has not written anything yet</Text>}
            bottom={<SubagentBox run={run} />}
        />
    );
}
