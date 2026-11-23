import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Menu, MenuItem, MenuTrigger, SubmenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { ChevronRight } from '@clowdy/icons/8';
// Fork wears the thread's mark until a Fork icon is drawn: swapping it is this one import.
import { Split as ForkIcon, NewChat } from '@clowdy/icons/14';

import type { ReactNode } from 'react';

/** An agent a conversation can be handed to: its id, its name, and its mark for the row. */
export interface ForkAgent {
    id: string;
    name: string;
    icon?: ReactNode;
}

export interface ForkMenuProps {
    /**
     * Fork the chat at this answer, in a new chat. For an agent that can cut its session there it is a copy of the session; for one that cannot (Cursor has no `session/fork`, an
     * answer from before the rewind points or one of a stopped turn has none) the caller hands the conversation to the chat's own agent as a file, which the person sees as the same Fork.
     */
    onFork: () => void;
    /** A fork is being made: `pending` on the menu that started it, `blocked` on the others, so there is one at a time. */
    state?: 'pending' | 'blocked';
    /** Hand the conversation up to this answer to another agent, in a new-chat page. The item is drawn only where it is given. */
    onHandoff?: (agentId: string) => void;
    /** The agents `onHandoff` can take: the signed-in ones other than the chat's own. None leaves the item off, with the reason under it. */
    agents?: readonly ForkAgent[];
}

const FORK = 'fork';
const OTHER_AGENT = 'agent';

/**
 * The Fork button of an answer, as a menu that opens on a press (not on hover): **Fork** makes a new chat from the thread up to this answer, and **Hand off to…**
 * opens the list of the other agents, whose pick opens a new-chat page on that agent with the conversation up to this answer attached as a file.
 */
export function ForkMenu({ onFork, state, onHandoff, agents = [] }: ForkMenuProps) {
    return (
        <MenuTrigger>
            <Button
                variant="filling"
                size="xs"
                iconOnly
                tooltip="Fork"
                tooltipPlacement="bottom"
                aria-label="Fork"
                isPending={state === 'pending'}
                isDisabled={state === 'blocked'}
            >
                <ForkIcon />
            </Button>
            <Popover placement="bottom start" spacing="xs" width={240}>
                <Menu aria-label="Fork" size="sm" onAction={key => key === FORK && onFork()}>
                    <MenuItem id={FORK} icon={<ForkIcon />} text="Fork" />
                    <Show when={onHandoff}>
                        {handoff => (
                            <SubmenuTrigger>
                                <MenuItem
                                    id={OTHER_AGENT}
                                    icon={<NewChat />}
                                    endAffix={<ChevronRight />}
                                    text="Hand off to…"
                                    // With no agent to take it the item says why, under its words.
                                    description={agents.length === 0 ? 'No other agent is ready' : undefined}
                                    stacked={agents.length === 0}
                                    isDisabled={agents.length === 0}
                                />
                                <Popover spacing="xs" width={200}>
                                    <Menu aria-label="Hand off to" size="sm" onAction={key => handoff(String(key))}>
                                        <For each={agents}>
                                            {agent => (
                                                <MenuItem
                                                    key={agent.id}
                                                    id={agent.id}
                                                    icon={agent.icon}
                                                    text={agent.name}
                                                />
                                            )}
                                        </For>
                                    </Menu>
                                </Popover>
                            </SubmenuTrigger>
                        )}
                    </Show>
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
