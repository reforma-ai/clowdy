import { Claude, Cursor, Openai } from '@clowdy/icons/logo';

import type { SVGProps } from 'react';

type Mark = typeof Claude;

/** Each provider's own mark: Claude's starburst keeps its brand colour, the others follow the text colour. Codex wears OpenAI's. */
const MARKS: Record<string, Mark> = { claude: Claude, codex: Openai, cursor: Cursor };

export interface ProviderIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
    /** The agent's id; an agent without a mark of its own gets a plain ring. */
    agentId: string;
    size?: number;
}

/** A provider's brand mark. */
export function ProviderIcon({ agentId, size = 20, ...props }: ProviderIconProps) {
    const Mark = MARKS[agentId];

    if (Mark) {
        return <Mark size={size} {...props} />;
    }

    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false" {...props}>
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" />
        </svg>
    );
}
