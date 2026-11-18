import { Button } from '@clowdy/components/Button';
import { Show } from '@clowdy/components/Show';
import { ChevronDown } from '@clowdy/icons/8';
import { use, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { formatTime } from '../shared/time';
import { Markdown } from './Markdown';
import { personMarkdown } from './personMarkdown';
import { StreamLinksContext } from './StreamLinks';
import styles from './UserBubble.module.css';

/** A message longer than this is clamped under a fade until the person opens it. */
const COLLAPSE_MIN_CHARS = 500;

/** Clamps a long message under a fade. The toggle shows only when the clamp hides something. */
function Clamp({ children }: { children: ReactNode }) {
    const content = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);
    const [clipped, setClipped] = useState(false);

    useLayoutEffect(() => {
        const inner = content.current;
        const clamp = inner?.parentElement;

        if (!inner || !clamp || expanded) return;

        const measure = () => setClipped(clamp.scrollHeight > clamp.clientHeight + 1);
        const observer = new ResizeObserver(measure);

        measure();
        observer.observe(inner);

        return () => observer.disconnect();
    }, [expanded]);

    return (
        <>
            <div className={ styles.clamp } data-expanded={ expanded } data-clipped={ clipped }>
                <div ref={ content }>{ children }</div>
            </div>
            <Show when={ clipped }>
                <Button variant="inline" color="secondary" className={ styles.toggle } aria-expanded={ expanded } onPress={ () => setExpanded(!expanded) }>
                    { expanded ? 'Show less' : 'Show full message' }
                    <ChevronDown className="chevron" aria-expanded={ expanded } aria-hidden />
                </Button>
            </Show>
        </>
    );
}

export interface UserBubbleProps {
    text: string;
    at: number;
    /** The message came in while the stream was on screen: it rises into place. */
    animate?: boolean;
}

/** What the person wrote: a tinted bubble on the right, the time under it. The text is Markdown, as the message box writes it; files and tasks it mentions are chips. */
export function UserBubble({ text, at, animate }: UserBubbleProps) {
    const { taskOfKey } = use(StreamLinksContext);
    const body = <Markdown text={ personMarkdown(text, taskOfKey) } fromPerson />;

    return (
        <div className={ styles.row } data-animate={ animate || undefined }>
            <div className={ styles.bubble }>
                <Show when={ text.length > COLLAPSE_MIN_CHARS } fallback={ body }>
                    <Clamp>{ body }</Clamp>
                </Show>
            </div>
            <time className={ styles.time } dateTime={ new Date(at).toISOString() }>{ formatTime(at) }</time>
        </div>
    );
}
