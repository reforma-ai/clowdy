import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { GridList, GridListItem, listBoxItemDataShow, useCellEditMode } from '@clowdy/components/List';
import { Panel, PanelContent, PanelEmptyRow, PanelHeader } from '@clowdy/components/Panel';
import { EditPen, Message, Plus } from '@clowdy/icons/14';
import { useState } from 'react';

import { StatusDot } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import styles from './ChatList.module.css';
import { isRunActive } from './chatRun';
import { perform } from './commands';
import { useStartChat } from './useStartChat';

import type { Chat, ChatId } from '@clowdy/protocol';

/** The project's chats, newest activity first, and the button that starts another one. */
export function ChatList({ selectedId }: { selectedId: ChatId | undefined }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const { start, isCreating } = useStartChat();
    const [renamingId, setRenamingId] = useState<ChatId | null>(null);

    return (
        <Panel side="left" className={ styles.panel }>
            <PanelHeader>Chats</PanelHeader>

            <div className={ styles.create }>
                <Button variant="bordered" fullWidth isPending={ isCreating } onPress={ () => void start() }>
                    <Plus />
                    New chat
                </Button>
            </div>

            <PanelContent>
                { project.chatList.length === 0
                    ? <PanelEmptyRow>No chats yet</PanelEmptyRow>
                    : (
                        <GridList
                            aria-label="Chats"
                            size="md"
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={ selectedId }
                            onSelectionChange={ (keys) => {
                                const [id] = keys === 'all' ? [] : keys;

                                if (id !== undefined) ui.openChat(String(id));
                            } }
                        >
                            { project.chatList.map(chat => (
                                <GridListItem
                                    key={ chat.id }
                                    id={ chat.id }
                                    text={ chat.title }
                                    icon={ <Message /> }
                                    endAffix={ renamingId === chat.id ? undefined : <RowEnd chat={ chat } onRename={ () => setRenamingId(chat.id) } /> }
                                >
                                    { renamingId === chat.id
                                        ? <RenameField chat={ chat } onDone={ () => setRenamingId(null) } />
                                        : <span className={ styles.title } onDoubleClick={ () => setRenamingId(chat.id) }>{ chat.title }</span> }
                                </GridListItem>
                            )) }
                        </GridList>
                    ) }
            </PanelContent>
        </Panel>
    );
}

/** A dot while the chat's orchestrator is busy, and the rename button on hover. */
function RowEnd({ chat, onRename }: { chat: Chat; onRename: () => void }) {
    const project = useProjectState();
    const run = chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined;

    return (
        <span className={ styles.end }>
            { isRunActive(run) && <StatusDot status={ run.status } /> }
            <Button
                variant="filling"
                color="secondary"
                size="xs"
                iconOnly
                aria-label="Rename chat"
                tooltip="Rename"
                data-show={ listBoxItemDataShow.itemBoth }
                onPress={ onRename }
            >
                <EditPen />
            </Button>
        </span>
    );
}

/** The title as a field: Enter or leaving it renames, Escape keeps the old name. */
function RenameField({ chat, onDone }: { chat: Chat; onDone: () => void }) {
    const root = useRootStore();
    const edit = useCellEditMode();
    const [title, setTitle] = useState(chat.title);

    const commit = () => {
        const next = title.trim();

        onDone();

        if (next && next !== chat.title) void perform(root, { type: 'chat.rename', chatId: chat.id, title: next });
    };

    return (
        <Input
            type="text"
            size="xs"
            variant="bordered"
            aria-label="Chat title"
            autoFocus
            autoSelect
            value={ title }
            onChange={ setTitle }
            onFocus={ edit.onFocus }
            onBlur={ (event) => {
                edit.onBlur(event);
                commit();
            } }
            onKeyDown={ (event) => {
                if (event.key === 'Enter') commit();
                else if (event.key === 'Escape') onDone();
            } }
        />
    );
}
