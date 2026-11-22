import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';

export type SaveAnswer = 'save' | 'discard';

/** The question a tab with unsaved edits asks before it closes. */
export function SavePrompt({ name, onAnswer }: { name: string; onAnswer: (answer: SaveAnswer) => void }) {
    const { modal } = useModalContext();
    const answer = (value: SaveAnswer) => {
        onAnswer(value);
        modal.cancel();
    };

    return (
        <Box gap="xl" padding="xxl">
            <Box gap="md">
                <Text variant="heading-3">{`Save changes to ${name}?`}</Text>
                <Text variant="md" color="secondary">
                    Your changes are lost if you don’t save them
                </Text>
            </Box>
            <Box direction="row" gap="md" justify="end">
                <Button onPress={() => modal.cancel()}>Cancel</Button>
                <Button onPress={() => answer('discard')}>Don’t save</Button>
                <Button autoFocus color="primary" onPress={() => answer('save')}>
                    Save
                </Button>
            </Box>
        </Box>
    );
}
