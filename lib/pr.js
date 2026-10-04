const CHECK_FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

// Checks on the PR that don't come from Actions workflows: other apps' check runs and commit statuses.
export function externalChecks(rollup = []) {
  let failing = 0;
  let pending = 0;
  for (const c of rollup) {
    if (c.__typename === 'CheckRun') {
      if (c.workflowName) continue;
      if (c.status !== 'COMPLETED') pending++;
      else if (CHECK_FAIL.has(c.conclusion)) failing++;
    } else if (c.__typename === 'StatusContext') {
      if (c.state === 'PENDING' || c.state === 'EXPECTED') pending++;
      else if (CHECK_FAIL.has(c.state)) failing++;
    }
  }
  return { failing, pending };
}

// `gh pr view --json` → what the pane header shows.
export function prSummary(pr) {
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: pr.isDraft === true,
    review: pr.reviewDecision || null,
    merge: pr.mergeStateStatus || null,
    external: externalChecks(pr.statusCheckRollup ?? []),
  };
}
