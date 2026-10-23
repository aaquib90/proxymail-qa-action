# Proxy Mail QA run

A GitHub Action that groups a job's email tests into a [Proxy Mail QA](https://proxymail.qa) run and posts what it saw on the pull request: which emails arrived and how long after the test submitted, the codes, where each link goes, email checks, unsubscribe, offer and coupon checks, failed tests, and any email that never came.

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
      - uses: aaquib90/proxymail-qa-action@v1
        with:
          api-key: ${{ secrets.PROXYMAIL_QA_API_KEY }}
      - run: npm ci
      - run: npx playwright test
        env:
          PROXYMAIL_QA_API_KEY: ${{ secrets.PROXYMAIL_QA_API_KEY }}
```

The action starts a run and sets `PROXYMAIL_QA_RUN` for the steps after it. The [Node.js client](https://www.npmjs.com/package/proxymail-qa) (0.5.0 or later) and the [Python helper](https://proxymail.qa/docs/python) read it, so the calls your tests already make add to the run. From other tools, send the id in a header: `Proxy-Mail-QA-Run: $PROXYMAIL_QA_RUN`.

After the job, whether it passed or not, the action finishes the run, writes the report to the job summary and posts it on the pull request, updating the same comment on each push.

### Which test each email came from

With the Node.js client 0.8.0 or later, Playwright tests import `test` from `proxymail-qa/playwright` and add `proxymail-qa/playwright/reporter` to the config's reporters. With pytest, `conftest.py` imports the [Python helper's](https://proxymail.qa/docs/python) hooks. The report then says which test each email belongs to, and lists the tests that failed with what their emails did and the step that failed. [How to set it up](https://proxymail.qa/docs/ci#which-test-each-email-came-from)

### Compared with the last runs

The report compares the run with the last 10 finished runs of the same name and lists what changed: emails that took much longer than usual, a test that now gets two emails instead of one, tests that fail for the first time or now and then, email checks that newly fail, steps that passed last time and didn't run or now fail, and a new sender or link site. Keep `name` the same from run to run.

## Inputs

| Input          | Default                    | What it does                                                                                                                                |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-key`      | (required)                 | A Proxy Mail QA API key, from a secret                                                                                                      |
| `name`         | `<workflow> / <job>`       | The run's name. Runs with the same name share a comment, so give matrix jobs their own: `e2e (${{ matrix.browser }})`                       |
| `comment`      | `true`                     | Post the report on the pull request. Needs `pull-requests: write`                                                                           |
| `fail-job`     | `false`                    | Fail the job when the run failed (an email missing or one that came when none should have, a failed check or test, or a note), even if the tests passed |
| `github-token` | `${{ github.token }}`      | The token used to comment                                                                                                                   |
| `api-url`      | `https://api.proxymail.qa` | The Proxy Mail QA API                                                                                                                       |

Outputs: `run-id` and `run-url`.

## What a run keeps

The addresses, the codes (with a coupon's discount and what checkout said), timings, email check verdicts, the failed tests' names and errors, and each link's site and path, with anything in the path that looks like a token hidden. Never an email's text or subject, or a link's query, where sign-in tokens usually are. Runs are kept for 90 days, and everyone on the project can open them in the app.

Pull requests from forks don't get secrets, so there the action warns and starts no run. If the API can't be reached, it warns and your tests run as usual.

## More

- [Running in CI](https://proxymail.qa/docs/ci)
- [REST API: runs](https://proxymail.qa/docs/rest-api#runs-a-report-for-the-pull-request)

MIT licensed. The source lives in the Proxy Mail QA monorepo and is copied here for each release.
