'use client';

import Mention from '@tiptap/extension-mention';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { RichInputMentionNodeView } from './RichInputMentionNodeView';

export const ComposerMention = Mention.extend({
    name: 'composerMention',

    addAttributes() {
        return {
            ...this.parent?.(),
            kind: {
                default: 'file',
                parseHTML: element => element.getAttribute('data-kind'),
                renderHTML: attributes => {
                    if (!attributes.kind) {
                        return {};
                    }

                    return { 'data-kind': attributes.kind };
                },
            },
            data: {
                default: null,
                parseHTML: element => {
                    const raw = element.getAttribute('data-payload');

                    if (!raw) {
                        return null;
                    }

                    try {
                        return JSON.parse(raw) as unknown;
                    } catch {
                        return null;
                    }
                },
                renderHTML: attributes => {
                    if (attributes.data == null) {
                        return {};
                    }

                    try {
                        return { 'data-payload': JSON.stringify(attributes.data) };
                    } catch {
                        return {};
                    }
                },
            },
        };
    },

    addNodeView() {
        return ReactNodeViewRenderer(RichInputMentionNodeView, {
            as: 'span',
            className: 'rich-input-mention',
        });
    },
});
