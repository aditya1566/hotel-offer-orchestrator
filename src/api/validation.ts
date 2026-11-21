import { z } from 'zod';
import { HttpError } from './errors';

/** Empty query values (e.g. `minPrice=`) are treated as "not provided". */
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const singleValue = (field: string) =>
  z
    .unknown()
    .refine((v) => !Array.isArray(v), {
      message: `"${field}" must be provided only once`,
    })
    .optional();

const price = (field: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d+(\.\d+)?$/, {
        message: `"${field}" must be a non-negative number`,
      })
      .transform(Number)
      .refine((n) => Number.isFinite(n) && n <= 10_000_000, {
        message: `"${field}" is out of range`,
      })
      .optional(),
  );

export const hotelsQuerySchema = z
  .object({
    city: z.preprocess(
      emptyToUndefined,
      z
        .string({ message: 'Query parameter "city" is required' })
        .trim()
        .min(1, { message: 'Query parameter "city" is required' })
        .max(64, { message: '"city" must be at most 64 characters' })
        .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, {
          message: '"city" contains invalid characters',
        }),
    ),
    minPrice: price('minPrice'),
    maxPrice: price('maxPrice'),
    refresh: z.preprocess(
      emptyToUndefined,
      z
        .enum(['true', 'false', '1', '0'], {
          message: '"refresh" must be true or false',
        })
        .transform((v) => v === 'true' || v === '1')
        .default(false),
    ),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: '"minPrice" must be less than or equal to "maxPrice"',
    path: ['minPrice'],
  });

export type HotelsQuery = z.infer<typeof hotelsQuerySchema>;

const multiValueGuard = z.object({
  city: singleValue('city'),
  minPrice: singleValue('minPrice'),
  maxPrice: singleValue('maxPrice'),
  refresh: singleValue('refresh'),
});

export function parseHotelsQuery(query: unknown): HotelsQuery {
  const guard = multiValueGuard.safeParse(query);
  const parsed = guard.success ? hotelsQuerySchema.safeParse(query) : guard;
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({
      field: i.path.join('.') || undefined,
      message: i.message,
    }));
    throw new HttpError(400, 'INVALID_QUERY', details[0]?.message ?? 'Invalid query parameters', details);
  }
  return parsed.data as HotelsQuery;
}
