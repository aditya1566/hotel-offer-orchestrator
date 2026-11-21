import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/api/errors';
import { parseHotelsQuery } from '../../src/api/validation';

function expectInvalid(query: Record<string, unknown>, messagePart: string) {
  try {
    parseHotelsQuery(query);
    expect.unreachable('expected validation to fail');
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).code).toBe('INVALID_QUERY');
    expect((err as HttpError).message).toContain(messagePart);
  }
}

describe('parseHotelsQuery', () => {
  it('accepts a city on its own', () => {
    expect(parseHotelsQuery({ city: 'delhi' })).toEqual({
      city: 'delhi',
      refresh: false,
    });
  });

  it('parses prices and refresh', () => {
    expect(
      parseHotelsQuery({
        city: ' New Delhi ',
        minPrice: '1000',
        maxPrice: '5000.50',
        refresh: 'true',
      }),
    ).toEqual({
      city: 'New Delhi',
      minPrice: 1000,
      maxPrice: 5000.5,
      refresh: true,
    });
  });

  it('allows open-ended ranges and treats empty values as absent', () => {
    expect(parseHotelsQuery({ city: 'delhi', minPrice: '3000' })).toMatchObject({ minPrice: 3000 });
    expect(parseHotelsQuery({ city: 'delhi', maxPrice: '3000', minPrice: '' })).toEqual({
      city: 'delhi',
      maxPrice: 3000,
      refresh: false,
    });
  });

  it('allows minPrice == maxPrice', () => {
    expect(parseHotelsQuery({ city: 'delhi', minPrice: '5340', maxPrice: '5340' })).toMatchObject({
      minPrice: 5340,
      maxPrice: 5340,
    });
  });

  it('requires city', () => {
    expectInvalid({}, 'city');
    expectInvalid({ city: '   ' }, 'city');
  });

  it('rejects malformed values', () => {
    expectInvalid({ city: 'delhi', minPrice: 'abc' }, 'minPrice');
    expectInvalid({ city: 'delhi', maxPrice: '-5' }, 'maxPrice');
    expectInvalid({ city: 'delhi', refresh: 'yes' }, 'refresh');
    expectInvalid({ city: 'del<script>' }, 'invalid characters');
    expectInvalid({ city: 'x'.repeat(65) }, '64');
  });

  it('rejects minPrice greater than maxPrice', () => {
    expectInvalid({ city: 'delhi', minPrice: '9000', maxPrice: '1000' }, 'less than or equal');
  });

  it('rejects repeated parameters', () => {
    expectInvalid({ city: ['delhi', 'mumbai'] }, 'only once');
  });
});
