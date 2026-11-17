export type UnitCategory
    = | 'absolute-length'
      | 'relative-length'
      | 'viewport'
      | 'percent'
      | 'time'
      | 'angle';

export interface UnitDef {
    name: string;
    category: UnitCategory;
    step: number;
    shiftStep?: number;
    precision: number;
}

export const UNIT_REGISTRY: Record<string, UnitDef> = {
    px: { name: 'px', category: 'absolute-length', step: 1, precision: 0 },

    rem: { name: 'rem', category: 'relative-length', step: 0.1, precision: 3 },
    em: { name: 'em', category: 'relative-length', step: 0.1, precision: 3 },
    ch: { name: 'ch', category: 'relative-length', step: 0.1, precision: 2 },
    ex: { name: 'ex', category: 'relative-length', step: 0.1, precision: 2 },
    lh: { name: 'lh', category: 'relative-length', step: 0.1, precision: 3 },

    '%': { name: '%', category: 'percent', step: 1, precision: 2 },

    vw: { name: 'vw', category: 'viewport', step: 1, precision: 2 },
    vh: { name: 'vh', category: 'viewport', step: 1, precision: 2 },
    dvh: { name: 'dvh', category: 'viewport', step: 1, precision: 2 },
    svh: { name: 'svh', category: 'viewport', step: 1, precision: 2 },
    lvh: { name: 'lvh', category: 'viewport', step: 1, precision: 2 },
    vmin: { name: 'vmin', category: 'viewport', step: 1, precision: 2 },
    vmax: { name: 'vmax', category: 'viewport', step: 1, precision: 2 },
    cqi: { name: 'cqi', category: 'viewport', step: 1, precision: 2 },
    cqb: { name: 'cqb', category: 'viewport', step: 1, precision: 2 },

    s: { name: 's', category: 'time', step: 0.1, precision: 2 },
    ms: { name: 'ms', category: 'time', step: 10, precision: 0 },

    deg: { name: 'deg', category: 'angle', step: 1, precision: 0 },
    grad: { name: 'grad', category: 'angle', step: 1, precision: 2 },
    rad: { name: 'rad', category: 'angle', step: 0.1, precision: 3 },
    turn: { name: 'turn', category: 'angle', step: 0.05, precision: 3 },
};

export const getUnit = (name: string): UnitDef | undefined => UNIT_REGISTRY[name];

export const stepForUnit = (name: string): number =>
    UNIT_REGISTRY[name]?.step ?? 1;

export const shiftStepForUnit = (name: string): number => {
    const def = UNIT_REGISTRY[name];

    if (!def) {
        return 10;
    }

    return def.shiftStep ?? def.step * 10;
};

const unitsIn = (...cats: UnitCategory[]): string[] =>
    Object.values(UNIT_REGISTRY)
        .filter(u => cats.includes(u.category))
        .map(u => u.name);

export const LENGTH_UNITS_BASIC: readonly string[] = ['px', 'rem', 'em', '%', 'vw', 'vh'];

export const LENGTH_UNITS_ALL: readonly string[] = unitsIn(
    'absolute-length',
    'relative-length',
    'viewport',
    'percent'
);

export const TIME_UNITS: readonly string[] = unitsIn('time');
export const ANGLE_UNITS: readonly string[] = unitsIn('angle');

export const UNIT_PRECISION: Record<string, number> = Object.fromEntries(
    Object.values(UNIT_REGISTRY).map(u => [u.name, u.precision])
);

// longer names first so 'rem' isn't captured as 'em', 'dvh' before 'vh', etc.
const LENGTH_UNITS_PATTERN = [...LENGTH_UNITS_ALL]
    .sort((a, b) => b.length - a.length)
    .join('|');
const CSS_UNITS_PATTERN = [...LENGTH_UNITS_ALL, ...TIME_UNITS, ...ANGLE_UNITS]
    .sort((a, b) => b.length - a.length)
    .join('|');

export const LENGTH_UNIT_RE = new RegExp(`^(-?\\d+(?:\\.\\d+)?)(${ LENGTH_UNITS_PATTERN })$`);
export const CSS_UNIT_RE = new RegExp(`^(-?\\d+(?:\\.\\d+)?)(${ CSS_UNITS_PATTERN })$`);
export const NUMBER_WITH_UNIT_RE = new RegExp(
    `^-?\\d+(\\.\\d+)?(${ CSS_UNITS_PATTERN })?$`
);

export const BARE_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

export interface ParsedUnitValue {
    value: number;
    unit: string;
}

export type AngleUnit = 'deg' | 'grad' | 'rad' | 'turn';

export interface AngleUnitValue {
    value: number;
    unit: AngleUnit;
}

const ANGLE_VALUE_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(deg|grad|rad|turn)?$/i;

const ANGLE_UNIT_TO_DEGREES: Record<AngleUnit, number> = {
    deg: 1,
    grad: 0.9,
    rad: 180 / Math.PI,
    turn: 360,
};

export function isAngleUnit(unit: string): unit is AngleUnit {
    return ANGLE_UNITS.includes(unit);
}

export function parseAngleValue(input: string, fallbackUnit: AngleUnit = 'deg'): AngleUnitValue | null {
    const match = input.trim().match(ANGLE_VALUE_RE);

    if (!match) {
        return null;
    }

    const value = Number(match[1]);
    const unit = match[2]?.toLowerCase() ?? fallbackUnit;

    if (!Number.isFinite(value) || !isAngleUnit(unit)) {
        return null;
    }

    return { value, unit };
}

export function angleToDegrees(value: AngleUnitValue): number {
    return value.value * ANGLE_UNIT_TO_DEGREES[value.unit];
}

export function angleFromDegrees(degrees: number, unit: AngleUnit): AngleUnitValue {
    return { value: degrees / ANGLE_UNIT_TO_DEGREES[unit], unit };
}

export function parseUnitValue(raw: string): ParsedUnitValue | null {
    const match = raw.trim().match(CSS_UNIT_RE);

    if (!match) {
        return null;
    }

    return { value: parseFloat(match[1]), unit: match[2] };
}

export function roundForUnit(value: number, unit: string): number {
    const precision = UNIT_REGISTRY[unit]?.precision ?? 2;
    const factor = 10 ** precision;

    return Math.round(value * factor) / factor;
}
