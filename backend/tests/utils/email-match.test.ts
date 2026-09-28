import { emailEquals, escapeLikePattern, isSameEmail } from '../../src/utils/email-match';

describe('escapeLikePattern', () => {
  it.each([
    ['first_last@example.com', 'first\\_last@example.com'],
    ['100%@example.com', '100\\%@example.com'],
    ['back\\slash@example.com', 'back\\\\slash@example.com'],
    ['a_b%c\\d@example.com', 'a\\_b\\%c\\\\d@example.com'],
    ['__@example.com', '\\_\\_@example.com'],
  ])('escapes %s', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });

  it.each(['plain@example.com', 'first.last+tag@example.co.uk', "o'neil@example.com", ''])(
    'leaves %j alone: it has no pattern character',
    (input) => {
      expect(escapeLikePattern(input)).toBe(input);
    }
  );
});

describe('emailEquals', () => {
  it('is a case-insensitive equality filter on the escaped address', () => {
    expect(emailEquals('first_last@example.com')).toEqual({
      equals: 'first\\_last@example.com',
      mode: 'insensitive',
    });
  });

  it('is unchanged for an address without pattern characters', () => {
    // Which is why the mocked service suites did not need to change.
    expect(emailEquals('player@example.com')).toEqual({
      equals: 'player@example.com',
      mode: 'insensitive',
    });
  });

  it('does not normalise the address: callers trim and lower-case what they store', () => {
    expect(emailEquals(' Player@Example.com ').equals).toBe(' Player@Example.com ');
  });
});

describe('isSameEmail', () => {
  it.each([
    ['a@example.com', 'a@example.com'],
    ['A@Example.com', 'a@example.com'],
    [' a@example.com ', 'a@example.com'],
    ['first_last@example.com', 'FIRST_LAST@example.com'],
  ])('%j and %j are the same address', (a, b) => {
    expect(isSameEmail(a, b)).toBe(true);
  });

  it.each([
    ['first_last@example.com', 'firstXlast@example.com'],
    ['a@example.com', 'b@example.com'],
    ['a@example.com', null],
    [null, 'a@example.com'],
    [undefined, undefined],
    ['', ''],
  ])('%j and %j are not', (a, b) => {
    expect(isSameEmail(a, b)).toBe(false);
  });
});
