/**
 * Small typing helpers shared by the schema modules. `isolatedDeclarations` requires an explicit
 * type on every exported binding, and a zod enum's type is mechanical enough to name once here
 * rather than spell out at each of the several dozen closed vocabularies this package carries.
 */

import type { z } from 'zod';

/** The type of `z.enum(values)` for a `readonly string[]` declared `as const`. */
export type EnumOf<T extends readonly string[]> = z.ZodEnum<{ [K in T[number]]: K }>;
