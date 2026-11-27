import { Chip } from '@clowdy/components/Chip';
import { Message } from '@clowdy/icons/14';
import { use } from 'react';

import { StreamLinksContext } from '../StreamLinks';

import type { Chat } from '@clowdy/protocol';

/** A chat referenced in a message, using its current title rather than the stored ID. */
export function ChatReferenceChip({ chat }: { chat: Pick<Chat, 'id' | 'title'> }) {
    const { onOpenChat } = use(StreamLinksContext);

    return (
        <Chip
            icon={<Message width={12} height={12} />}
            tooltip={onOpenChat ? chat.title : undefined}
            onPress={onOpenChat ? () => onOpenChat(chat.id) : undefined}
        >
            {chat.title}
        </Chip>
    );
}
