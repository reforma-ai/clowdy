import type { Handlers } from './context';

export const skillsHandlers: Pick<Handlers, 'skills.setEnabled'> = {
    'skills.setEnabled': ({ skills }, { name, enabled }) => {
        skills.setEnabled(name, enabled);

        return { name, enabled };
    },
};
