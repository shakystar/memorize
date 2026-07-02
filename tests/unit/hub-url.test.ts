import { describe, expect, it } from 'vitest';

import { isHttpUrl, parseHubUrl } from '../../src/cli/hub-url.js';

describe('parseHubUrl — Hub pretty-URL contract', () => {
  it('takes the origin as remote-url and the last segment as the id', () => {
    expect(parseHubUrl('https://hub.example/clone/wsp_abc123')).toEqual({
      remoteUrl: 'https://hub.example',
      remoteProjectId: 'wsp_abc123',
    });
  });

  it('ignores intermediate path segments — the Hub owns its route shape', () => {
    for (const path of [
      '/clone/proj_mq6skfo5_i5ds793o',
      '/sync/proj_mq6skfo5_i5ds793o',
      '/p/proj_mq6skfo5_i5ds793o',
      '/deeply/nested/anything/proj_mq6skfo5_i5ds793o',
      '/proj_mq6skfo5_i5ds793o',
    ]) {
      expect(parseHubUrl(`https://hub.example${path}`)).toEqual({
        remoteUrl: 'https://hub.example',
        remoteProjectId: 'proj_mq6skfo5_i5ds793o',
      });
    }
  });

  it('keeps a non-default port in the origin and tolerates trailing slash/query', () => {
    expect(
      parseHubUrl('http://127.0.0.1:8787/clone/wsp_x1/?utm_source=hub#top'),
    ).toEqual({
      remoteUrl: 'http://127.0.0.1:8787',
      remoteProjectId: 'wsp_x1',
    });
  });

  it('rejects URLs whose last segment is not a store id', () => {
    for (const raw of [
      'https://hub.example/',
      'https://hub.example/clone',
      'https://hub.example/clone/not-an-id',
      'https://hub.example/wsp_abc/settings',
    ]) {
      expect(() => parseHubUrl(raw)).toThrow(/wsp_… or proj_…/);
    }
  });

  it('rejects non-http(s) and malformed input', () => {
    expect(() => parseHubUrl('ftp://hub.example/wsp_abc')).toThrow(/http\(s\)/);
    expect(() => parseHubUrl('not a url')).toThrow(/Not a valid URL/);
  });

  it('isHttpUrl separates URL positionals from bare store ids', () => {
    expect(isHttpUrl('https://hub.example/clone/wsp_abc')).toBe(true);
    expect(isHttpUrl('HTTP://hub.example/wsp_abc')).toBe(true);
    expect(isHttpUrl('wsp_abc123')).toBe(false);
    expect(isHttpUrl('proj_mq6skfo5_i5ds793o')).toBe(false);
  });
});
