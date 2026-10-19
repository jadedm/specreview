// #32: the theme's own CSS stays black, white and grey. The browser smoke
// checks what renders; this catches a colour added to our files before that.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const FILES = ['house.css', 'review/review.css', 'diagrams.css'];
const read = (file: string) => readFileSync(path.join(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// VitePress palettes that carry hue by default. house.css points each at a
// grey; nothing else may use them.
const ACCENT =
  /--vp-c-(?:brand|tip|note|success|important|warning|caution|danger|indigo|purple|green|yellow|red|sponsor)[\w-]*/g;

const channels = (literal: string): number[] => {
  const hex = literal.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  return literal
    .replace(/^(?:rgba?|hsla?)\(|\)$/g, '')
    .split(/[\s,/]+/)
    .slice(0, 3)
    .map(Number);
};

// A colour is grey when its three channels are equal. Every other way to
// write a colour is refused rather than converted: hsl(), oklch(), lab(),
// lch(), hwb(), color(), and any named colour that is not a grey. Nothing in
// the theme needs them.
const GREY_NAMES = new Set([
  'black',
  'white',
  'gray',
  'grey',
  'silver',
  'dimgray',
  'dimgrey',
  'darkgray',
  'darkgrey',
  'lightgray',
  'lightgrey',
  'gainsboro',
  'whitesmoke',
]);
// Words a colour-bearing value may hold besides colours.
const KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'none',
  'solid',
  'dashed',
  'dotted',
  'double',
  'inset',
  'underline',
  'line-through',
  'overline',
  'auto',
]);
// Colour-bearing properties, and custom properties that hold a colour (the
// VitePress palette, --vp-c-*, which is how house.css sets every colour).
const COLOUR_PROPS =
  /^(?:color|background|background-color|background-image|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?|--vp-c-[\w-]+|--[\w-]*colou?r[\w-]*)$/;

export const nonGrey = (css: string): string[] => {
  const found = (css.match(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^)]*\)/gi) ?? []).filter(
    (literal) => {
      if (!/^(?:#|rgb)/i.test(literal)) return true;
      if (/^#[0-9a-f]{4}$|^#[0-9a-f]{8}$/i.test(literal)) return true;
      const [r, g, b] = channels(literal);
      return !(r === g && g === b);
    },
  );
  // Named colours, read from the values of colour-bearing properties.
  for (const [, prop, value] of css.matchAll(/(?:^|[;{\s])(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)/gi)) {
    if (!COLOUR_PROPS.test(prop.toLowerCase())) continue;
    const bare = value.replace(
      /var\([^)]*\)|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^)]*\)|#[0-9a-f]{3,8}\b/gi,
      ' ',
    );
    for (const word of bare.match(/[a-z][a-z-]*/gi) ?? []) {
      const w = word.toLowerCase();
      if (!GREY_NAMES.has(w) && !KEYWORDS.has(w) && !/^(?:px|em|rem|ms|s)$/.test(w)) found.push(word);
    }
  }
  return found;
};

// In house.css an accent variable may only be defined (the left of a
// declaration); anywhere else, or in a value, it is a use.
export const accentUses = (css: string, file: string): string[] => {
  const uses: string[] = [];
  for (const line of css.split('\n')) {
    const defined = file === 'house.css' ? line.match(/^\s*(--vp-c-[\w-]+)\s*:/)?.[1] : undefined;
    for (const name of line.match(ACCENT) ?? []) if (name !== defined) uses.push(name);
  }
  return uses;
};

describe('32: the theme CSS is monochrome', () => {
  it.each(FILES)('%s has no colour literal that is not a grey', (file) => {
    expect(nonGrey(read(file))).toEqual([]);
  });

  it.each(FILES)('%s uses no accent palette variable', (file) => {
    expect(accentUses(read(file), file)).toEqual([]);
  });

  it('house.css points every accent palette at a grey literal', () => {
    const css = read('house.css');
    const names = ['indigo', 'purple', 'green', 'yellow', 'red'].flatMap((family) =>
      ['1', '2', '3', 'soft'].map((step) => `--vp-c-${family}-${step}`),
    );
    for (const name of [...names, '--vp-c-sponsor']) {
      const value = css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1];
      expect(value, name).toBeDefined();
      expect(value, name).toMatch(/^(?:#[0-9a-f]{6}|rgba?\([^)]*\))$/i);
      expect(nonGrey(`.x { color: ${value}; }`), name).toEqual([]);
    }
  });

  it('14: the checks refuse what they are meant to', () => {
    expect(nonGrey('.x { color: #3451b2; }')).toEqual(['#3451b2']);
    expect(nonGrey('.x { color: rgb(60, 60, 67); border: 1px solid #ddd; }')).toEqual(['rgb(60, 60, 67)']);
    expect(nonGrey('.x { color: hsl(0 0% 50%); }')).toHaveLength(1);
    expect(nonGrey('.x { color: #1f1f1f; background: rgba(128, 128, 128, 0.14); }')).toEqual([]);
    expect(nonGrey('.x { color: red; }')).toEqual(['red']);
    expect(nonGrey('.x { border: 1px solid rebeccapurple; }')).toEqual(['rebeccapurple']);
    expect(nonGrey('.x { color: oklch(0.5 0.2 240); }')).toHaveLength(1);
    expect(nonGrey('.x { color: color(srgb 1 0 0); }')).toHaveLength(1);
    expect(nonGrey('.x { border: 1px solid currentColor; text-decoration: underline; color: white; }')).toEqual([]);
    expect(nonGrey(':root { --vp-c-text-1: red; }')).toEqual(['red']);
    expect(nonGrey(':root { --rv-link-color: teal; }')).toEqual(['teal']);
    expect(nonGrey('.x { background-image: linear-gradient(red, blue); }')).toContain('red');
    expect(nonGrey(':root { --vp-font-family-base: system-ui, sans-serif; --vp-c-bg: #ffffff; }')).toEqual([]);
    expect(accentUses('.x { color: var(--vp-c-brand-1); }', 'review/review.css')).toEqual(['--vp-c-brand-1']);
    expect(accentUses('  --vp-c-red-1: #1f1f1f;', 'house.css')).toEqual([]);
    expect(accentUses('  --vp-c-text-1: var(--vp-c-red-1);', 'house.css')).toEqual(['--vp-c-red-1']);
  });
});
