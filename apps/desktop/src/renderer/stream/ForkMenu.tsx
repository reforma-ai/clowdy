import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Menu, MenuItem, MenuTrigger, SubmenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
// Fork wears the thread's mark until a Fork icon is drawn: swapping it is this one import.
import { ArrowRight, Split as ForkIcon, NewChat } from '@clowdy/icons/14';
import { ChevronRight } from '@clowdy/icons/8';

import type { ReactNode } from 'react';

/** An agent a conversation can be handed to: its id, its name, and its mark for the row. */
export interface ForkAgent {
    id: string;
    name: string;
    icon?: ReactNode;
}

export interface ForkMenuProps {
    /** Fork the chat at this answer: a copy of the agent's own session, cut there, in a new chat. Drawn only where it is given: the agent has to be able to cut its session at this answer. */
    onFork?: () => void;
    /** A fork is being made: `pending` on the menu that started it, `blocked` on the others, so there is one at a time. */
    state?: 'pending' | 'blocked';
    /**
     * Hand the conversation up to this answer to the chat's own agent, in a new-chat page, for an answer `onFork` is not given for (Cursor has no `session/fork`, an answer from before the
     * rewind points or one of a stopped turn has none): the conversation goes in as a file, which is a hand-off, not a fork. Drawn only without `onFork`, and then the button reads `Hand off`.
     */
    onHandoffHere?: () => void;
    /** Hand the conversation up to this answer to another agent, in a new-chat page. The item is drawn only where it is given. */
    onHandoff?: (agentId: string) => void;
    /** The agents `onHandoff` can take: the signed-in ones other than the chat's own. None leaves the item off, with the reason under it. */
    agents?: readonly ForkAgent[];
}

const FORK = 'fork';
const HERE = 'here';
const OTHER_AGENT = 'agent';

/**
 * The button of an answer's menu, which opens on a press (not on hover). **Fork** makes a copy of the agent's session in a new chat. **Hand off to a new chat** and **Hand off to
 * another agent…** open a new-chat page with the conversation up to this answer attached as a file, on the same agent and on the one picked from the list. Fork is a copy of the
 * thread and a hand-off is a file, so an answer the agent cannot cut its session at has the hand-offs only, and its button reads `Hand off`.
 */
export function ForkMenu({ onFork, state, onHandoffHere, onHandoff, agents = [] }: ForkMenuProps) {
    const label = onFork ? 'Fork' : 'Hand off';

    return (
        <MenuTrigger>
            <Button
                variant="filling"
                size="xs"
                iconOnly
                tooltip={ label }
                tooltipPlacement="bottom"
                aria-label={ label }
                isPending={ state === 'pending' }
                isDisabled={ state === 'blocked' }
            >
                { onFork ? <ForkIcon /> : <ArrowRight /> }
            </Button>
            <Popover placement="bottom start" spacing="xs" width={ 240 }>
                <Menu aria-label={ label } size="sm" onAction={ key => (key === FORK ? onFork?.() : key === HERE && onHandoffHere?.()) }>
                    <Show when={ onFork }>
                        <MenuItem id={ FORK } icon={ <ForkIcon /> } text="Fork" />
                    </Show>
                    <Show when={ !onFork && onHandoffHere }>
                        <MenuItem id={ HERE } icon={ <NewChat /> } text="Hand off to a new chat" />
                    </Show>
                    <Show when={ onHandoff }>
                        { handoff => (
                            <SubmenuTrigger>
                                <MenuItem
                                    id={ OTHER_AGENT }
                                    icon={ <ArrowRight /> }
                                    endAffix={ <ChevronRight /> }
                                    text="Hand off to another agent…"
                                    // With no agent to take it the item says why, under its words.
                                    description={ agents.length === 0 ? 'No other agent is ready' : undefined }
                                    stacked={ agents.length === 0 }
                                    isDisabled={ agents.length === 0 }
                                />
                                <Popover spacing="xs" width={ 200 }>
                                    <Menu aria-label="Hand off to another agent" size="sm" onAction={ key => handoff(String(key)) }>
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
