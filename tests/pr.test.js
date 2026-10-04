import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalChecks, prSummary } from '../lib/pr.js';

test('externalChecks counts non-Actions check runs and statuses only', () => {
  const rollup = [
    { __typename: 'CheckRun', workflowName: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', workflowName: '', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', workflowName: '', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', workflowName: '', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'ci/circleci', state: 'ERROR' },
    { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
    { __typename: 'StatusContext', context: 'x', state: 'SUCCESS' },
  ];
  assert.deepEqual(externalChecks(rollup), { failing: 2, pending: 2 });
});

test('prSummary', () => {
  assert.equal(prSummary(null), null);
  assert.deepEqual(prSummary({ number: 7, url: 'u', state: 'OPEN', isDraft: true, reviewDecision: '', mergeStateStatus: 'DIRTY', statusCheckRollup: [] }), {
    number: 7,
    url: 'u',
    state: 'OPEN',
    draft: true,
    review: null,
    merge: 'DIRTY',
    external: { failing: 0, pending: 0 },
  });
});
