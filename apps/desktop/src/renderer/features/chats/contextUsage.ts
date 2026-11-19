import { formatTokens, tokensOf } from '../../shared/tokens';
import { usageTone, type UsageTone } from '../settings/providers/providerView';

import type { RunContext } from '@clowdy/protocol';

/** What the ring and its popover say of a reading. */
export interface ContextFill {
    /** How full the window is, as a whole percent between 0 and 100 (a window of no size is empty). */
    percent: number;
    /** The tone of the percent: the same thresholds as the usage bars of the Providers page. */
    tone: UsageTone;
    /** The tokens in the window, an estimate: `~92.3K`. */
    used: string;
    /** The size of the window: `200K`. */
    size: string;
    /** `46% full`. */
    label: string;
}

/** The ring's numbers from the orchestrator's latest `usage_update`. */
export function contextFill(context: RunContext): ContextFill {
    const used = tokensOf(context.used);
    const size = tokensOf(context.size);
    const percent = size > 0 ? Math.min(100, Math.round((used * 100) / size)) : 0;

    return {
        percent,
        tone: usageTone(percent),
        used: `~${ formatTokens(used) }`,
        size: formatTokens(size),
        label: `${ percent }% full`,
    };
}
