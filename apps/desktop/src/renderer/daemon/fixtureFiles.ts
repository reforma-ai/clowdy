/** What a few of the fixture folders' files hold, for the file manager to show; any other file is one line naming itself. */
const CONTENTS: Record<string, string> = {
    'README.md':
        '# Car Rental\n\nThe booking service for the partner garages.\n\n## Run\n\n```sh\nbun install\nbun run dev\n```\n\n## Where things are\n\n- `src/booking` is the booking form and its price rules\n- `src/api` is what the partner garages call\n- `src/db/schema.ts` is the database\n',
    'package.json':
        '{\n  "name": "car-rental",\n  "version": "0.4.0",\n  "private": true,\n  "scripts": {\n    "dev": "bun --watch src/index.tsx",\n    "test": "bun test",\n    "typecheck": "tsc --noEmit"\n  },\n  "dependencies": {\n    "react": "^19.2.0"\n  }\n}\n',
    'tsconfig.json':
        '{\n  "compilerOptions": {\n    "strict": true,\n    "target": "ES2022",\n    "jsx": "react-jsx"\n  },\n  "include": ["src"]\n}\n',
    '.gitignore': 'node_modules\ndist\n.env\n',
    'src/booking/index.tsx':
        "import { Steps } from './steps';\n\nexport function Booking() {\n    return <Steps />;\n}\n",
    'src/booking/BookingForm.tsx':
        "import { useState } from 'react';\n\nexport function BookingForm() {\n    const [step, setStep] = useState(0);\n    const next = () => setStep(step + 1);\n\n    return <button onClick={ next }>Next</button>;\n}\n",
    'src/booking/price.ts':
        '/** The weekend surcharge applies from Friday evening to Sunday night. */\nexport const weekendRate = 1.15;\n\nconst round = (value: number) => Math.round(value * 100) / 100;\nconst sum = (values: number[]) => values.reduce((total, value) => total + value, 0);\n\nexport const total = (days: number[]) => round(sum(days));\n',
    'src/booking/price.test.ts':
        "import { expect, test } from 'bun:test';\n\nimport { total } from './price';\n\ntest('adds the days up', () => {\n    expect(total([40, 40, 46])).toBe(126);\n});\n",
    'src/booking/weekend.ts':
        '/** The surcharge of a weekend day, as its own line in the price. */\nexport const weekendSurcharge = (day: number, rate: number) => Math.round(day * (rate - 1) * 100) / 100;\n',
    'src/db/schema.ts':
        "export const bookings = {\n    id: 'text',\n    carId: 'text',\n    from: 'date',\n    to: 'date',\n    price: 'integer',\n};\n",
};

/** The files of a fixture folder with what each holds, a few more than the ones its search lists, so the tree has a dotfile and a config to show. */
export function fixtureFileContents(paths: readonly string[]): Record<string, string> {
    const files: Record<string, string> = {};

    for (const path of [...paths, '.gitignore', 'tsconfig.json']) files[path] = CONTENTS[path] ?? `// ${path}\n`;

    return files;
}
