import { Text } from '@clowdy/components/Text';

/** A line of text with `code` spans, the way the daemon writes its hints: no `cursor-agent` command was found. */
export function InlineCode({ text }: { text: string }) {
    const parts = text.split('`');

    // An odd count of backticks leaves the last one open: it is plain text then.
    return (
        <>
            { parts.map((part, index) => (index % 2 === 1 && index < parts.length - 1
                ? <Text key={ index } as="code" variant="code">{ part }</Text>
                : part)) }
        </>
    );
}
