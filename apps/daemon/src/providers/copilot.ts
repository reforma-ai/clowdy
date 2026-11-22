import type { Provider } from './types';

export const copilot: Provider = {
    spec: {
        id: 'copilot',
        name: 'GitHub Copilot CLI',
        programs: ['copilot'],
        launch: { kind: 'binary', args: ['--acp'] },
    },
};
