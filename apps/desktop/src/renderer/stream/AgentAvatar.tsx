import { Layers, User } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import styles from './AgentAvatar.module.css';

import type { RunRole } from '@clowdy/protocol';

export interface AgentAvatarProps {
    role?: RunRole;
    size?: 'sm' | 'md';
    className?: string;
}

/** The avatar of an agent: a rounded square, layers for an orchestrator and a person for the rest. */
export function AgentAvatar({ role = 'orchestrator', size = 'sm', className }: AgentAvatarProps) {
    return (
        <span aria-hidden className={ cn(styles.avatar, className) } data-size={ size }>
            { role === 'orchestrator' ? <Layers /> : <User /> }
        </span>
    );
}
