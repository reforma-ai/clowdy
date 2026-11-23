import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Menu, MenuItem, MenuTrigger, SubmenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
// Fork wears the thread's mark until a Fork icon is drawn: swapping it is this one import.
import { ArrowRight, Split as ForkIcon } from '@clowdy/icons/14';
import { ChevronRight } from '@clowdy/icons/8';

import type { ReactNode } from 'react';

/** An agent a conversation can be handed to: its id, its name, and its mark for the row. */
export interface ForkAgent {
    id: string;
    name: string;
    icon?: ReactNode;
}

/**
 * What Fork carries into the new chat: `session`, a copy of the agent's own session cut at the answer; `conversation`, the words of the conversation up to the answer, attached as a
 * file to a new-chat page on the same agent, for an agent that cannot cut its session there (Cursor has no `session/fork`, an answer from before the points or one of a stopped turn has none).
 */
export type ForkMode = 'session' | 'conversation';

export interface ForkMenuProps {
    /** Fork the chat at this answer: a copy of the session, on the same agent, in a new chat (`mode` says what is copied). */
    onFork: () => void;
    /** What `onFork` carries over. `conversation` says so under the item. */
    mode?: ForkMode;
    /** A fork is being made: `pending` on the menu that started it, `blocked` on the others, so there is one at a time. */
    state?: 'pending' | 'blocked';
    /** Hand the conversation up to this answer to another agent, in a new-chat page. The second item is drawn only where it is given. */
    onHandoff?: (agentId: string) => void;
    /** The agents `onHandoff` can take: the signed-in ones other than the chat's own. None leaves the item off, with the reason under it. */
    agents?: readonly ForkAgent[];
}

const FORK = 'fork';
const OTHER_AGENT = 'agent';

/**
 * The Fork button of an answer, as a menu that opens on a press (not on hover): **Fork** makes a copy of the session in a new chat (or, in `conversation` mode, opens a
 * new-chat page on the same agent with the conversation up to this answer attached), and **Fork to another agent…** opens the list of the other agents, whose pick opens a
 * new-chat page on that agent with the same attachment.
 */
export function ForkMenu({ onFork, mode = 'session', state, onHandoff, agents = [] }: ForkMenuProps) {
    return (
        <MenuTrigger>
            <Button
                variant="filling"
                size="xs"
                iconOnly
                tooltip="Fork"
                tooltipPlacement="bottom"
                aria-label="Fork"
                isPending={ state === 'pending' }
                isDisabled={ state === 'blocked' }
            >
                <ForkIcon />
            </Button>
            <Popover placement="bottom start" spacing="xs" width={ 240 }>
                <Menu aria-label="Fork" size="sm" onAction={ key => key === FORK && onFork() }>
                    <MenuItem
                        id={ FORK }
                        icon={ <ForkIcon /> }
                        text="Fork"
                        // A session cannot be cut here, so the new chat starts from the words of this one: say so.
                        description={ mode === 'conversation' ? 'Attaches the conversation as a file' : undefined }
                        stacked={ mode === 'conversation' }
                    />
                    <Show when={ onHandoff }>
                        { handoff => (
                            <SubmenuTrigger>
                                <MenuItem
                                    id={ OTHER_AGENT }
                                    icon={ <ArrowRight /> }
                                    endAffix={ <ChevronRight /> }
                                    text="Fork to another agent…"
                                    // With no agent to take it the item says why, under its words.
                                    description={ agents.length === 0 ? 'No other agent is ready' : undefined }
                                    stacked={ agents.length === 0 }
                                    isDisabled={ agents.length === 0 }
                                />
                                <Popover spacing="xs" width={ 200 }>
                                    <Menu aria-label="Fork to another agent" size="sm" onAction={ key => handoff(String(key)) }>
                                        <For each={ agents }>
                                            { agent => <MenuItem key={ agent.id } id={ agent.id } icon={ agent.icon } text={ agent.name } /> }
                                        </For>
                                    </Menu>
                                </Popover>
                            </SubmenuTrigger>
                        ) }
                    </Show>
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
