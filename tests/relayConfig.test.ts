import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredRelays, parseRelayList, resolveRelays } from '../src/lib/media/transport';

/**
 * The relay list is configurable at runtime (IROH_RELAYS on the server, served at
 * /api/media-config) with a build-time fallback (VITE_IROH_RELAYS). These tests cover the
 * parser shared by both, and the resolution order in resolveRelays. The Hono route itself is
 * a thin wrapper over parseRelayList and isn't exercised here, since server.ts starts the
 * whole app when imported.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(impl: () => Promise<Response>) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => impl()) as unknown as
    typeof fetch & ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('parseRelayList', () => {
  it('splits on commas and trims whitespace', () => {
    expect(parseRelayList('  https://a.example ,https://b.example\t, https://c.example  ')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });

  it('drops empty entries', () => {
    expect(parseRelayList(',, https://a.example ,,')).toEqual(['https://a.example']);
    expect(parseRelayList('')).toEqual([]);
    expect(parseRelayList('   ')).toEqual([]);
    expect(parseRelayList(undefined)).toEqual([]);
  });

  it('keeps only http(s) URLs', () => {
    expect(
      parseRelayList('relay.example.com, ftp://x.example, javascript:alert(1), http://plain.example, https://ok.example'),
    ).toEqual(['http://plain.example', 'https://ok.example']);
  });
});

describe('configuredRelays (build-time fallback)', () => {
  it('reads VITE_IROH_RELAYS through the same filter', () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://a.example, nope, https://b.example,');
    expect(configuredRelays()).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('resolveRelays', () => {
  it('uses the relays served by the server', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () => jsonResponse({ relays: ['https://runtime.example'] }));

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://runtime.example']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/media-config');
  });

  it('falls back to the build-time list when the server returns []', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () => jsonResponse({ relays: [] }));

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://build.example']);
  });

  it('falls back to n0 defaults (empty list) when neither source has relays', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', '');
    const fetchImpl = fakeFetch(async () => jsonResponse({ relays: [] }));

    await expect(resolveRelays(fetchImpl)).resolves.toEqual([]);
  });

  it('falls back without throwing when fetch rejects', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://build.example']);
  });

  it('falls back on a non-ok response', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () => jsonResponse({ relays: ['https://runtime.example'] }, 500));

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://build.example']);
  });

  it('falls back on a malformed JSON body', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () => new Response('<html>not json</html>', { status: 200 }));

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://build.example']);
  });

  it('filters invalid entries out of the server list', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ relays: ['', 'ftp://bad.example', 42, ' https://ok.example ', null] }),
    );

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://ok.example']);
  });

  it('falls back when the server list has no valid entries', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () => jsonResponse({ relays: ['', 'not-a-url', 7] }));

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://build.example']);
  });

  it('falls back when the body has no relays array', async () => {
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    const fetchImpl = fakeFetch(async () => jsonResponse({ relays: 'https://runtime.example' }));

    await expect(resolveRelays(fetchImpl)).resolves.toEqual(['https://build.example']);
  });

  it('gives up after about 3 seconds and falls back', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_IROH_RELAYS', 'https://build.example');
    // A request that never answers, but rejects once the caller aborts it.
    const neverAnswers = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;

    const pending = resolveRelays(neverAnswers);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toEqual(['https://build.example']);
  });
});
