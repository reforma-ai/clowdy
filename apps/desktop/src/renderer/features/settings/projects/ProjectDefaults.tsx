import { LAST_USED, type Project } from '@clowdy/protocol';

import { useRootStore } from '../../../stores';
import { FOLLOW_APP, modeOf, NewChatChoices } from '../NewChatChoices';
import { setProjectDefaults } from './projectActions';

/**
 * What a new chat in this project starts with: Default (nothing saved) follows Settings > Chat, "Last used" (`LAST_USED`) starts it where the last chat
 * left off on this machine, or an agent and a mode of its own.
 */
export function ProjectDefaults({ project }: { project: Project }) {
    const root = useRootStore();
    const { engine, chatMode } = project.settings;

    return (
        <NewChatChoices
            followsApp
            engine={engine ?? FOLLOW_APP}
            mode={chatMode ?? FOLLOW_APP}
            onEngineChange={next =>
                void setProjectDefaults(root, project, { engine: next === FOLLOW_APP ? null : next })
            }
            onModeChange={next =>
                void setProjectDefaults(root, project, {
                    chatMode: next === LAST_USED ? LAST_USED : (modeOf(next) ?? null),
                })
            }
        />
    );
}
