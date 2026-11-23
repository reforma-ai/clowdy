import type { Provider } from './types';

export const gemini: Provider = {
    spec: {
        id: 'gemini',
        name: 'Gemini CLI',
        programs: ['gemini'],
        launch: { kind: 'binary', args: ['--acp'] },
        login: 'gemini',
    },
};
