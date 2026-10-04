import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, dispatchInputs, initialValue, missingInputs, inputFlags } from '../lib/dispatch-inputs.js';

const WF = `name: deploy # comment
on:
  push:
    branches:
    - main
  workflow_dispatch:
    inputs:
      environment:
        description: "Where to: deploy"
        required: true
        type: choice
        options:
          - staging
          - production
      dry_run:
        description: Skip the apply
        type: boolean
        default: true
      version:
        description: >
          Version to deploy,
          e.g. 1.2.3
        required: false
      tags:
        type: choice
        options: [a, 'b c', "d"]
      target:
        type: environment
jobs:
  deploy:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' &&
      inputs.dry_run
    steps:
      - uses: actions/checkout@v7
      - name: apply
        run: |
          echo "env: \${{ inputs.environment }}"
          # not a comment for YAML, part of the script
        env: { A: 1, B: "x" }
`;

test('parseYaml: maps, lists, flow, block scalars, comments, continuation lines', () => {
  const doc = parseYaml(WF);
  assert.deepEqual(doc.on.push.branches, ['main']);
  assert.equal(doc.jobs.deploy.steps[1].run, 'echo "env: ${{ inputs.environment }}"\n# not a comment for YAML, part of the script');
  assert.deepEqual(doc.jobs.deploy.steps[1].env, { A: '1', B: 'x' });
  assert.equal(doc.jobs.deploy.if, "github.event_name == 'workflow_dispatch' && inputs.dry_run");
  assert.equal(doc.on.workflow_dispatch.inputs.version.description, 'Version to deploy, e.g. 1.2.3');
});

test('dispatchInputs: types, options, defaults, required', () => {
  assert.deepEqual(dispatchInputs(WF), [
    { name: 'environment', description: 'Where to: deploy', required: true, type: 'choice', options: ['staging', 'production'], default: null },
    { name: 'dry_run', description: 'Skip the apply', required: false, type: 'boolean', options: [], default: true },
    { name: 'version', description: 'Version to deploy, e.g. 1.2.3', required: false, type: 'string', options: [], default: null },
    { name: 'tags', description: '', required: false, type: 'choice', options: ['a', 'b c', 'd'], default: null },
    { name: 'target', description: '', required: false, type: 'environment', options: [], default: null },
  ]);
});

test('dispatchInputs: none, flow triggers, unreadable', () => {
  assert.deepEqual(dispatchInputs('on:\n  workflow_dispatch:\n'), []);
  assert.deepEqual(dispatchInputs('on: [push, workflow_dispatch]\n'), []);
  assert.deepEqual(dispatchInputs('on: workflow_dispatch\n'), []);
  assert.deepEqual(dispatchInputs("'on':\n  workflow_dispatch:\n    inputs:\n      x:\n        default: 1\n").map((i) => i.default), ['1']);
  assert.equal(dispatchInputs('on:\n  push:\n x: [\n'), null);
});

test('onBlock: only the top-level on: section', async () => {
  const { onBlock } = await import('../lib/dispatch-inputs.js');
  assert.equal(onBlock('name: x\non:\n  push:\n# c\n  workflow_dispatch:\njobs:\n  a: [\n'), 'on:\n  push:\n# c\n  workflow_dispatch:');
  assert.equal(onBlock('name: x\n'), '');
  assert.deepEqual(dispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      a:\njobs:\n  x: [\n    1,\n  ]\n').map((i) => i.name), ['a']);
});

test("this repo's workflows parse", () => {
  for (const f of ['ci.yml', 'release.yml']) assert.notEqual(parseYaml(readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), 'utf8')), null, f);
  assert.deepEqual(dispatchInputs(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).map((i) => i.name), ['increment']);
});

test('form helpers: initial values, missing required, -f flags', () => {
  const inputs = dispatchInputs(WF);
  const values = Object.fromEntries(inputs.map((i) => [i.name, initialValue(i)]));
  assert.deepEqual(values, { environment: 'staging', dry_run: true, version: '', tags: 'a', target: '' });
  assert.deepEqual(missingInputs(inputs, { ...values, environment: '' }), ['environment']);
  assert.deepEqual(inputFlags(inputs, values), ['-f', 'environment=staging', '-f', 'dry_run=true', '-f', 'tags=a']);
});
