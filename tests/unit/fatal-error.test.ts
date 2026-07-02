import { describe, expect, it } from 'vitest';

import {
  formatFatalError,
  writeFatalErrorAndExit,
} from '../../src/cli/fatal-error.js';

describe('formatFatalError', () => {
  it('prints Error messages and stringifies non-Error values', () => {
    expect(formatFatalError(new Error('boom'))).toBe('boom');
    expect(formatFatalError('plain')).toBe('plain');
  });
});

describe('writeFatalErrorAndExit', () => {
  it('exits after stderr flushes', () => {
    let written = '';
    let exitCode: number | undefined;
    const timers: Array<() => void> = [];

    expect(() =>
      writeFatalErrorAndExit(new Error('guard failed'), {
        stderr: {
          write(chunk, callback) {
            written += chunk;
            callback?.();
            return true;
          },
        },
        exit(code): never {
          exitCode = code;
          throw new Error('exit');
        },
        setTimeout(callback) {
          timers.push(callback);
          return {};
        },
      }),
    ).toThrow('exit');

    expect(written).toBe('guard failed\n');
    expect(exitCode).toBe(1);
    expect(timers).toHaveLength(0);
  });

  it('falls back to a timer when stderr never calls back', () => {
    let exitCode: number | undefined;
    let fallback: (() => void) | undefined;

    writeFatalErrorAndExit('guard failed', {
      stderr: {
        write() {
          return true;
        },
      },
      exit(code): never {
        exitCode = code;
        throw new Error('exit');
      },
      setTimeout(callback) {
        fallback = callback;
        return {};
      },
    });

    expect(() => fallback?.()).toThrow('exit');
    expect(exitCode).toBe(1);
  });
});
