import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finish, runMeta, start, upsertComment } from '../src/lib.mjs';

const RUN = { id: '00000000-0000-4000-8000-000000000123', url: 'https://app.proxymail.qa/runs/00000000-0000-4000-8000-000000000123', status: 'passed' };
const REPORT = '<!-- proxymail-qa-run: E2E / test -->\n### ✅ E2E / test passed\n';

let dir;
let env;
let logs;

const file = (name) => {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch {
    return '';
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pmqa-action-'));
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ number: 7, pull_request: { number: 7, head: { sha: 'abc1234def5678' } } }));
  env = {
    'INPUT_API-KEY': 'qa_test',
    INPUT_NAME: 'E2E / test',
    INPUT_COMMENT: 'true',
    'INPUT_FAIL-JOB': 'false',
    'INPUT_GITHUB-TOKEN': 'ghs_test',
    'INPUT_API-URL': 'https://api.test',
    GITHUB_REPOSITORY: 'acme/web',
    GITHUB_HEAD_REF: 'feature/login',
    GITHUB_REF_NAME: '7/merge',
    GITHUB_SHA: 'mergecommit000',
    GITHUB_WORKFLOW: 'E2E',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: join(dir, 'event.json'),
    GITHUB_RUN_ID: '99',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://gh.test',
    GITHUB_ENV: join(dir, 'env'),
    GITHUB_STATE: join(dir, 'state'),
    GITHUB_OUTPUT: join(dir, 'output'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary'),
  };
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line) => logs.push(line));
});

afterEach(() => vi.restoreAllMocks());

// A fake for both APIs, recording each request.
function fakeFetch(routes) {
  const calls = [];
  const fetcher = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${init.method} ${url}`;
    const answer = routes[key];
    if (!answer) throw new Error(`Unexpected ${key}`);
    return typeof answer === 'function' ? answer() : answer.clone();
  });
  return { fetcher, calls };
}

describe('start', () => {
  it('starts a run with where it ran, and hands its id to later steps', async () => {
    const { fetcher, calls } = fakeFetch({ 'POST https://api.test/v1/runs': Response.json(RUN, { status: 201 }) });
    expect(await start(env, fetcher)).toEqual(RUN);
    expect(calls[0].headers.Authorization).toBe('Bearer qa_test');
    expect(calls[0].body).toEqual({
      name: 'E2E / test',
      source: 'ci',
      meta: {
        repository: 'acme/web',
        branch: 'feature/login',
        commit: 'abc1234def5678',
        workflow: 'E2E',
        pull_request: 7,
        job_url: 'https://github.com/acme/web/actions/runs/99/attempts/2',
      },
    });
    expect(file('env')).toMatch(new RegExp(`^PROXYMAIL_QA_RUN<<(pmqa_\\w+)\\n${RUN.id}\\n\\1\\n$`));
    expect(file('state')).toContain(`\n${RUN.id}\n`);
    expect(file('output')).toContain(`\n${RUN.url}\n`);
  });

  it('never fails the job: no key or no API only warns', async () => {
    const { fetcher } = fakeFetch({ 'POST https://api.test/v1/runs': Response.json({ message: 'This API key is not valid' }, { status: 401 }) });
    expect(await start(env, fetcher)).toBeNull();
    expect(logs.join('\n')).toContain('::warning::Couldn’t start a Proxy Mail QA run: Proxy Mail QA answered 401: This API key is not valid');
    expect(await start({ ...env, 'INPUT_API-KEY': '' }, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(file('env')).toBe('');
  });

  it('reads pushes without a pull request', () => {
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ ref: 'refs/heads/main' }));
    expect(runMeta({ ...env, GITHUB_EVENT_NAME: 'push', GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main', GITHUB_RUN_ATTEMPT: '1' })).toEqual({
      repository: 'acme/web',
      branch: 'main',
      commit: 'mergecommit000',
      workflow: 'E2E',
      job_url: 'https://github.com/acme/web/actions/runs/99',
    });
  });
});

describe('finish', () => {
  const routes = (extra = {}) => ({
    [`POST https://api.test/v1/runs/${RUN.id}/finish`]: Response.json(RUN),
    [`GET https://api.test/v1/runs/${RUN.id}?format=markdown`]: new Response(REPORT, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }),
    'GET https://gh.test/repos/acme/web/issues/7/comments?per_page=100&page=1': Response.json([]),
    'POST https://gh.test/repos/acme/web/issues/7/comments': Response.json({ id: 1 }, { status: 201 }),
    ...extra,
  });

  it('finishes the run, writes the job summary and comments on the pull request', async () => {
    const { fetcher, calls } = fakeFetch(routes());
    expect(await finish({ ...env, STATE_run: RUN.id }, fetcher)).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST https://api.test/v1/runs/${RUN.id}/finish`,
      `GET https://api.test/v1/runs/${RUN.id}?format=markdown`,
      'GET https://gh.test/repos/acme/web/issues/7/comments?per_page=100&page=1',
      'POST https://gh.test/repos/acme/web/issues/7/comments',
    ]);
    expect(calls[3].headers.Authorization).toBe('Bearer ghs_test');
    expect(calls[3].body).toEqual({ body: REPORT });
    expect(file('summary')).toBe(`${REPORT}\n`);
  });

  it('updates its own comment for the same run name', async () => {
    const { fetcher, calls } = fakeFetch(
      routes({
        'GET https://gh.test/repos/acme/web/issues/7/comments?per_page=100&page=1': Response.json([
          { id: 41, body: 'Looks good' },
          { id: 42, body: '<!-- proxymail-qa-run: E2E / test -->\n### old' },
          { id: 43, body: '<!-- proxymail-qa-run: E2E / other -->\n### other job' },
        ]),
        'PATCH https://gh.test/repos/acme/web/issues/comments/42': Response.json({ id: 42 }),
      }),
    );
    await finish({ ...env, STATE_run: RUN.id }, fetcher);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://gh.test/repos/acme/web/issues/comments/42', body: { body: REPORT } });
  });

  it('only warns when it can’t comment, and fails the job only when asked', async () => {
    const failed = { ...RUN, status: 'failed' };
    const { fetcher } = fakeFetch(
      routes({
        [`POST https://api.test/v1/runs/${RUN.id}/finish`]: () => Response.json(failed),
        'GET https://gh.test/repos/acme/web/issues/7/comments?per_page=100&page=1': () => new Response('{}', { status: 403 }),
      }),
    );
    expect(await finish({ ...env, STATE_run: RUN.id }, fetcher)).toBe(0);
    expect(logs.join('\n')).toContain('permissions: pull-requests: write');
    expect(await finish({ ...env, STATE_run: RUN.id, 'INPUT_FAIL-JOB': 'true' }, fetcher)).toBe(1);
    expect(logs.at(-1)).toBe(`::error::The Proxy Mail QA run failed: ${RUN.url}`);
  });

  it('does nothing when no run was started, and skips the comment when asked', async () => {
    const { fetcher, calls } = fakeFetch(routes());
    expect(await finish(env, fetcher)).toBe(0);
    expect(calls).toEqual([]);
    await finish({ ...env, STATE_run: RUN.id, INPUT_COMMENT: 'false' }, fetcher);
    expect(calls.map((c) => c.url).some((u) => u.startsWith('https://gh.test'))).toBe(false);
  });
});

describe('upsertComment', () => {
  it('posts its own when another comment has the same first line but isn’t editable', async () => {
    const { fetcher, calls } = fakeFetch({
      'GET https://gh.test/repos/acme/web/issues/7/comments?per_page=100&page=1': Response.json([{ id: 9, body: REPORT }]),
      'PATCH https://gh.test/repos/acme/web/issues/comments/9': new Response('{}', { status: 403 }),
      'POST https://gh.test/repos/acme/web/issues/7/comments': Response.json({ id: 10 }, { status: 201 }),
    });
    await upsertComment(env, fetcher, 'ghs_test', 7, REPORT);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'POST']);
  });
});
