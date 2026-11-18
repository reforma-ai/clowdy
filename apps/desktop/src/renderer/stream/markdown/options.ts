import { defaultRehypePlugins, type StreamdownProps } from 'streamdown';

import { streamdownComponents } from './components';

const sanitize = defaultRehypePlugins.sanitize as [unknown, { protocols?: { src?: readonly string[] } }];

const rehypeSanitize = [
    sanitize[0],
    {
        ...sanitize[1],
        protocols: {
            ...sanitize[1].protocols,
            src: [...(sanitize[1].protocols?.src ?? []), 'data'],
        },
    },
] as NonNullable<StreamdownProps['rehypePlugins']>[number];

/** Sanitize and harden, no rehype-raw: HTML tags stay characters, Markdown still renders. For what a person types. */
export const PERSON_REHYPE_PLUGINS = [
    rehypeSanitize,
    defaultRehypePlugins.harden,
] as NonNullable<StreamdownProps['rehypePlugins']>;

export const STREAMDOWN_OPTIONS = {
    parseIncompleteMarkdown: true,
    caret: 'block',
    controls: false,
    rehypePlugins: [
        defaultRehypePlugins.raw,
        ...PERSON_REHYPE_PLUGINS,
    ] as NonNullable<StreamdownProps['rehypePlugins']>,
    components: streamdownComponents,
} satisfies StreamdownProps;
