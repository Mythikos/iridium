/**
 * `cli.output.unit` — the stream split and the three renderers.
 *
 * The property worth defending is the stream split: half the command inventory offers `--json` so a
 * script can read the answer, and that is only true if nothing but the answer is on stdout. So the
 * buffered `CliIo` a test uses keeps the two streams apart, and the commands' own suites assert which
 * stream each sentence went to.
 */
import { describe, expect, it } from 'vitest';

import { BufferedIo, renderJson, renderPairs, renderTable } from './output.ts';

describe('cli.output.unit [area:ops]', () => {
  describe('the buffered io keeps the two streams apart', () => {
    it('collects stdout and stderr separately, in order', () => {
      const io = new BufferedIo();
      io.out('the answer');
      io.err('a warning');
      io.out('more answer');
      expect(io.stdout).toBe('the answer\nmore answer');
      expect(io.stderr).toBe('a warning');
    });

    it('starts empty, so a command that printed nothing is distinguishable', () => {
      const io = new BufferedIo();
      expect(io.stdout).toBe('');
      expect(io.stderr).toBe('');
    });
  });

  describe('renderJson', () => {
    it('is parseable and two-space indented, which is what `config check --json` prints', () => {
      const rendered = renderJson({ checks: [{ name: 'argon2', status: 'ok' }] });
      expect(JSON.parse(rendered)).toEqual({ checks: [{ name: 'argon2', status: 'ok' }] });
      expect(rendered).toContain('\n  "checks"');
    });
  });

  describe('renderPairs', () => {
    it('pads the key column to the widest key', () => {
      const rendered = renderPairs([
        ['user', 'u'],
        ['display name', 'd'],
      ]);
      expect(rendered.split('\n')).toEqual(['  user          u', '  display name  d']);
    });

    it('renders an empty list as an empty string rather than a stray blank line', () => {
      expect(renderPairs([])).toBe('');
    });
  });

  describe('renderTable', () => {
    it('aligns every column but the last, so a long detail does not trail into whitespace', () => {
      const rendered = renderTable(
        ['check', 'status', 'detail'],
        [
          ['argon2', 'ok', 'p50 213.5 ms'],
          ['yjs_instances', 'ok', 'one yjs copy is loaded'],
        ],
      );
      const lines = rendered.split('\n');
      expect(lines[0]).toBe('check          status  detail');
      expect(lines[1]).toBe('argon2         ok      p50 213.5 ms');
      expect(lines[2]).toBe('yjs_instances  ok      one yjs copy is loaded');
      for (const line of lines) expect(line).toBe(line.trimEnd());
    });

    it('widens a column to its header when every cell is shorter', () => {
      expect(renderTable(['status'], [['ok']]).split('\n')).toEqual(['status', 'ok']);
    });
  });
});
