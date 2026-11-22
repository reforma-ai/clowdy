import type { Provider } from './types';

export const opencode: Provider = {
    spec: {
        id: 'opencode',
        name: 'OpenCode',
        programs: ['opencode'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'opencode auth login',
    },
};
