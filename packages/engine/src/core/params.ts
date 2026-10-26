import { z } from 'zod';
import type { AnyStudyDef, StudyDef } from './types';

/**
 * Small builders that attach UI metadata to Zod schemas. The Studies dialog renders Inputs from
 * `z.toJSONSchema(def.schema)`, so `title`, `description`, `min/max`, `enum` and our custom keys
 * (`step`, `verify`, `group`) all flow through to the form automatically.
 */
export interface ParamMeta {
  [k: string]: unknown;
  title: string;
  description?: string;
  step?: number;
  /** marks a ⚠ VERIFY knob (INDICATORS.md) — shown with a badge in the Inputs tab */
  verify?: string;
  group?: string;
}

export const int = (def: number, min: number, max: number, meta: ParamMeta) =>
  z.number().int().min(min).max(max).default(def).meta({ ...meta, step: meta.step ?? 1 });

export const num = (def: number, min: number, max: number, meta: ParamMeta) =>
  z.number().min(min).max(max).default(def).meta({ ...meta, step: meta.step ?? 0.01 });

export const bool = (def: boolean, meta: ParamMeta) => z.boolean().default(def).meta(meta);

export const choice = <const T extends readonly [string, ...string[]]>(values: T, def: T[number], meta: ParamMeta) =>
  z.enum(values).default(def as never).meta(meta);

export const text = (def: string, meta: ParamMeta) => z.string().max(200).default(def).meta(meta);

/** Resolve a (possibly partial / stale) user config against the study schema, filling defaults. */
export function resolveConfig(def: AnyStudyDef, partial: unknown = {}): Record<string, unknown> {
  const r = def.schema.safeParse(partial ?? {});
  if (r.success) return r.data as Record<string, unknown>;
  // Drop invalid keys one by one so a single bad persisted value doesn't reset everything.
  const obj = { ...(partial as Record<string, unknown>) };
  for (const issue of r.error.issues) {
    const k = issue.path[0];
    if (typeof k === 'string') delete obj[k];
  }
  const r2 = def.schema.safeParse(obj);
  return (r2.success ? r2.data : def.schema.parse({})) as Record<string, unknown>;
}

export const defaultsOf = (def: AnyStudyDef): Record<string, unknown> => def.schema.parse({}) as Record<string, unknown>;

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  step?: number;
  verify?: string;
  group?: string;
  properties?: Record<string, JsonSchema>;
  [k: string]: unknown;
};

/** JSON Schema used to generate the Inputs tab. */
export function inputsSchema(def: AnyStudyDef): JsonSchema {
  return z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
}

/** Define a study with its config type inferred from the Zod schema (keeps every study strictly typed). */
export function defineStudy<S extends z.ZodType<object>, St>(
  schema: S,
  d: Omit<StudyDef<z.output<S>, St>, 'schema'>,
): StudyDef<z.output<S>, St> {
  return { ...d, schema } as unknown as StudyDef<z.output<S>, St>;
}
