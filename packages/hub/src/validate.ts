import { AppError } from './http';

type StringRule = { kind: 'string'; max: number; min?: number; multiline?: boolean; optional?: boolean };
type IntRule = { kind: 'int'; min: number; max: number; optional?: boolean };
type Rule = StringRule | IntRule;

type Out<R extends Record<string, Rule>> = {
  [K in keyof R]: R[K] extends StringRule
    ? R[K]['optional'] extends true
      ? string | undefined
      : string
    : R[K]['optional'] extends true
      ? number | undefined
      : number;
};

// Control characters other than tab and line breaks are refused everywhere;
// line breaks only in multi-line fields.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const LINE_BREAK = /[\t\r\n]/u;

const bad = (field: string, why: string) => new AppError(400, 'VALIDATION_FAILED', `${field}: ${why}`);

const checkString = (field: string, value: unknown, rule: StringRule): string => {
  if (typeof value !== 'string') throw bad(field, 'must be a string');
  if (CONTROL.test(value)) throw bad(field, 'contains control characters');
  if (!rule.multiline && LINE_BREAK.test(value)) throw bad(field, 'must be one line');
  const trimmed = value.trim();
  if (trimmed.length < (rule.min ?? 1)) throw bad(field, 'is empty or too short');
  if (value.length > rule.max) throw bad(field, `is longer than ${rule.max} characters`);
  return value;
};

const checkInt = (field: string, value: unknown, rule: IntRule): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw bad(field, 'must be a whole number');
  if (value < rule.min || value > rule.max) throw bad(field, `must be between ${rule.min} and ${rule.max}`);
  return value;
};

// Strict: the body must be an object with only the named fields, so a client
// cannot set anything the server derives (author, timestamps, versions).
export const parseBody = <R extends Record<string, Rule>>(body: unknown, rules: R): Out<R> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('body', 'must be a JSON object');
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((k) => !Object.hasOwn(rules, k));
  if (unknown.length > 0) throw bad(unknown[0], 'is not an accepted field');
  const out: Record<string, string | number | undefined> = {};
  for (const [field, rule] of Object.entries(rules)) {
    const value = input[field];
    if (value === undefined && rule.optional) continue;
    if (value === undefined) throw bad(field, 'is required');
    out[field] = rule.kind === 'string' ? checkString(field, value, rule) : checkInt(field, value, rule);
  }
  return out as Out<R>;
};
