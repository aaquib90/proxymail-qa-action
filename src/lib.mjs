// The Proxy Mail QA GitHub Action: starts a run before the tests, so their
// calls add what they saw (PROXYMAIL_QA_RUN), then finishes it after the job
// and posts the report on the pull request and in the job summary. No
// dependencies: it talks to the GitHub runner through its files and to the
// APIs with fetch. Everything takes env, so tests can pass their own.
import { appendFileSync, readFileSync } from 'node:fs';

const VERSION = '1.0.0';

export function inputs(env) {
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  return {
    apiKey: input('api-key'),
    name: input('name') || env.GITHUB_WORKFLOW || 'CI',
    comment: input('comment') !== 'false',
    failJob: input('fail-job') === 'true',
    githubToken: input('github-token'),
    apiUrl: (input('api-url') || 'https://api.proxymail.qa').replace(/\/+$/, ''),
  };
}

// Workflow commands take their data escaped.
const escapeData = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const log = {
  info: (message) => console.log(message),
  notice: (message) => console.log(`::notice::${escapeData(message)}`),
  warning: (message) => console.log(`::warning::${escapeData(message)}`),
};

// Appends to one of the runner's files (GITHUB_ENV, GITHUB_STATE…), with a
// heredoc delimiter so a value can't add lines of its own.
export function writeRunnerFile(env, file, values) {
  const path = env[file];
  if (!path) return;
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `pmqa_${Math.random().toString(36).slice(2)}`;
    appendFileSync(path, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

function event(env) {
  try {
    return env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function pullRequestNumber(env) {
  const e = event(env);
  const number = e.pull_request?.number ?? (env.GITHUB_EVENT_NAME?.startsWith('pull_request') ? e.number : undefined);
  return Number.isInteger(number) ? number : null;
}

// What the run says about where it ran.
export function runMeta(env) {
  const e = event(env);
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const attempt = Number(env.GITHUB_RUN_ATTEMPT) > 1 ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : '';
  const pr = pullRequestNumber(env);
  const meta = {
    repository: env.GITHUB_REPOSITORY,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
    commit: e.pull_request?.head?.sha || env.GITHUB_SHA,
    workflow: env.GITHUB_WORKFLOW,
    ...(pr ? { pull_request: pr } : {}),
    ...(env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID && server.startsWith('https://')
      ? { job_url: `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${attempt}` }
      : {}),
  };
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined && value !== ''));
}

async function api(fetcher, settings, method, path, body) {
  const response = await fetcher(`${settings.apiUrl}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'User-Agent': `proxymail-qa-action/${VERSION}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Proxy Mail QA answered ${response.status}: ${payload.message ?? response.statusText}`);
  }
  return (response.headers.get('Content-Type') ?? '').startsWith('text/markdown') ? response.text() : response.json();
}

// Before the tests: start the run and hand its id to the steps after.
export async function start(env, fetcher = fetch) {
  const settings = inputs(env);
  if (!settings.apiKey) {
    log.warning('No api-key, so no run was started. (Pull requests from forks don’t get secrets.)');
    return null;
  }
  try {
    const run = await api(fetcher, settings, 'POST', '/runs', { name: settings.name.slice(0, 120), source: 'ci', meta: runMeta(env) });
    writeRunnerFile(env, 'GITHUB_ENV', { PROXYMAIL_QA_RUN: run.id });
    writeRunnerFile(env, 'GITHUB_STATE', { run: run.id });
    writeRunnerFile(env, 'GITHUB_OUTPUT', { 'run-id': run.id, 'run-url': run.url });
    log.info(`Proxy Mail QA run started: ${run.url}`);
    return run;
  } catch (error) {
    // The tests still run; only the report is missing.
    log.warning(`Couldn’t start a Proxy Mail QA run: ${error.message}`);
    return null;
  }
}

// GitHub's API, for the pull request comment.
async function github(fetcher, env, token, method, path, body) {
  const response = await fetcher(`${env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `proxymail-qa-action/${VERSION}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub answered ${response.status}`), { status: response.status });
  return response.json();
}

// One comment per run name on the pull request, updated on each push.
export async function upsertComment(env, fetcher, token, number, body) {
  const marker = body.split('\n', 1)[0];
  const repo = env.GITHUB_REPOSITORY;
  let existing = null;
  for (let page = 1; page <= 10; page++) {
    const comments = await github(fetcher, env, token, 'GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    for (const comment of comments) if (typeof comment.body === 'string' && comment.body.split('\n', 1)[0] === marker) existing = comment;
    if (comments.length < 100) break;
  }
  if (existing) {
    try {
      return await github(fetcher, env, token, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
    } catch (error) {
      // Someone else's comment with the same first line: post our own.
      if (error.status !== 403 && error.status !== 404) throw error;
    }
  }
  return github(fetcher, env, token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body });
}

// After the job: finish the run, then report it. Returns the exit code.
export async function finish(env, fetcher = fetch) {
  const settings = inputs(env);
  const id = (env.STATE_run ?? '').trim();
  if (!id || !settings.apiKey) return 0;
  let run;
  let report;
  try {
    run = await api(fetcher, settings, 'POST', `/runs/${encodeURIComponent(id)}/finish`, { failed: false });
    report = await api(fetcher, settings, 'GET', `/runs/${encodeURIComponent(id)}?format=markdown`);
  } catch (error) {
    log.warning(`Couldn’t finish the Proxy Mail QA run: ${error.message}`);
    return 0;
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report}\n`);
  const number = pullRequestNumber(env);
  if (settings.comment && number && settings.githubToken) {
    try {
      await upsertComment(env, fetcher, settings.githubToken, number, report);
    } catch (error) {
      log.warning(
        error.status === 403
          ? 'Couldn’t comment on the pull request: give the job `permissions: pull-requests: write`, or set comment: false.'
          : `Couldn’t comment on the pull request: ${error.message}`,
      );
    }
  }
  log.info(`Proxy Mail QA run ${run.status}: ${run.url}`);
  if (run.status === 'failed' && settings.failJob) {
    console.log(`::error::${escapeData(`The Proxy Mail QA run failed: ${run.url}`)}`);
    return 1;
  }
  return 0;
}
