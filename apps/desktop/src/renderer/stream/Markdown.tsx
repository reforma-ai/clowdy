import { cn } from '@clowdy/lib';
import { Streamdown, type AnimateOptions } from 'streamdown';

import styles from './Markdown.module.css';
import { PERSON_REHYPE_PLUGINS, STREAMDOWN_OPTIONS } from './markdown/options';
import './markdown/markdown.css';

/** Phrase-sized fade: no per-word stagger, so a chunk of text lands as one piece. */
const STREAM_FADE = { animation: 'fadeIn', duration: 180, stagger: 0 } as const satisfies AnimateOptions;

export interface MarkdownProps {
    text: string;
    /** The text is still arriving: Markdown not yet closed is drawn as if it were, a caret follows, new text fades in. */
    streaming?: boolean;
    /** What a person typed, not an agent: no raw HTML, single line breaks kept. */
    fromPerson?: boolean;
}

/** A message's text as Markdown, rendered into elements (never injected as HTML) by Streamdown, tuned for streaming. */
export function Markdown({ text, streaming = false, fromPerson = false }: MarkdownProps) {
    return (
        <div className={ cn(styles.text, fromPerson && styles.person) }>
            <Streamdown
                { ...STREAMDOWN_OPTIONS }
                // Streamdown's own utility classes get this prefix, so they never clash with the app's.
                prefix="streamdown"
                className="root"
                rehypePlugins={ fromPerson ? PERSON_REHYPE_PLUGINS : STREAMDOWN_OPTIONS.rehypePlugins }
                disallowedElements={ [] }
                mode={ streaming ? 'streaming' : 'static' }
                animated={ streaming ? STREAM_FADE : false }
                isAnimating={ streaming }
            >
                { text }
            </Streamdown>
        </div>
    );
}
