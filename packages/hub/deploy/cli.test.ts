import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isEntry, parseArgs } from './cli';

describe('9: the command line', () => {
  it('runs when invoked through a path with a space or a symlinked folder', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'specreview cli '));
    mkdirSync(path.join(root, 'real dir'));
    const file = path.join(root, 'real dir', 'deploy.mjs');
    writeFileSync(file, '');
    symlinkSync(path.join(root, 'real dir'), path.join(root, 'link'));
    const url = pathToFileURL(file).href;
    expect(url).toContain('%20');
    expect(isEntry(file, url)).toBe(true);
    expect(isEntry(path.join(root, 'link', 'deploy.mjs'), url)).toBe(true);
    expect(isEntry(path.join(root, 'other.mjs'), url)).toBe(false);
    expect(isEntry(undefined, url)).toBe(false);
  });

  it('refuses unknown commands and arguments, and names a missing option', () => {
    expect(() => parseArgs(['bogus'])).toThrow(/usage/);
    expect(() => parseArgs(['setup', '--force'])).toThrow(/unknown or incomplete argument: --force/);
    expect(() => parseArgs(['setup', '--org'])).toThrow(/unknown or incomplete argument: --org/);
    expect(() => parseArgs(['secret', '--org', 'x']).need('--name')).toThrow(/secret needs --name/);
  });
});
