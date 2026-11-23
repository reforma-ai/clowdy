'use client';

import { type NodeViewProps, NodeViewWrapper } from '@tiptap/react';
import { type MouseEvent, type PointerEvent, type ReactNode, use } from 'react';

import { defaultRenderMention, mentionAttrsFromNode, RichInputMentionContext } from './mentionRender';

/**
 * TipTap host for consumer mention UI (via {@link RichInputMentionContext}).
 * The context holds a render function, not a component: it is called here, and `RichInput` makes
 * it create the element of the host's `renderMention`, so that component keeps its own hooks.
 */
export function RichInputMentionNodeView({ node, deleteNode }: NodeViewProps): ReactNode {
    const renderMention = use(RichInputMentionContext) ?? defaultRenderMention;
    const mention = mentionAttrsFromNode(node.attrs);

    return (
        <NodeViewWrapper
            as="span"
            contentEditable={false}
            onPointerDown={(event: PointerEvent) => event.stopPropagation()}
            onClick={(event: MouseEvent) => event.stopPropagation()}
        >
            {renderMention({ mention, deleteNode })}
        </NodeViewWrapper>
    );
}
