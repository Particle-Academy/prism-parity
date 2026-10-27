// These are workflow data, never executed. Every mutation starts from the same
// valid pinned checkout/verifier/gate, so a refusal cannot come from a bad pin.
import { verifyStepLines } from './pin-github-checks.mjs';
export const config = { repository: 'Example-Org/.github', files: ['third-party/check.mjs', 'third-party/gate-graph.mjs', 'third-party/allowlist.json'], defaultPermissions: 'read' };
export const expected = { sha: 'a'.repeat(40), files: config.files, hashes: Object.fromEntries(config.files.map(file => [file, 'b'.repeat(64)])) };
export function workflow(change = {}) {
 const prior = change.prior || '';
 const gateFields = change.gateFields || '';
 const gateRun = change.gateRun || 'node .shared/third-party/check.mjs --repo .';
 return `name: Fixture
on: push
permissions:
  contents: read
${change.topFields || ''}jobs:
  gate:
    runs-on: windows-latest
${change.jobFields || ''}    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
${prior}      - uses: actions/checkout@v4
        with:
          repository: Example-Org/.github
          ref: ${expected.sha}
          path: .shared
          persist-credentials: false
${verifyStepLines(6, '.shared', expected).join('\n')}
      - name: Check dependencies
        run: ${gateRun}
${gateFields}`;
}
export const cases = [
 ...['npm ci', 'python indirect_writer.py', 'node indirect_writer.mjs', 'echo apparently-harmless'].map((run, i) => ({ id: `prior-run-${i+1}`, class: 1, code: 'prior-environment-write', change: { prior: `      - run: ${run}\n` } })),
 ...['pnpm/action-setup@v4', 'actions/cache@v4', 'yarnpkg/setup-yarn@v1', './.github/actions/local-setup'].map((uses, i) => ({ id: `prior-action-${i+1}`, class: 2, code: 'prior-environment-write', change: { prior: `      - uses: ${uses}\n` } })),
 ...[
  '        env:\n          CI: true\n',
  '        env: {}\n',
  '        shell: bash\n',
  '        shell: bash --rcfile planted/profile {0}\n',
 ].map((gateFields,i)=>({id:`gate-context-${i+1}`,class:3,code:'gate-unverified',change:{gateFields}})),
 ...[
  '    container: node:22\n',
  '    container:\n      image: node:22\n',
  '    container: ${{ matrix.container }}\n',
  '    container: { image: node:22 }\n',
 ].map((jobFields,i)=>({id:`job-container-${i+1}`,class:4,code:'inherited-execution',change:{jobFields}})),
 {id:'gate-path-job-cwd',class:5,code:'gate-unverified',change:{jobFields:'    defaults:\n      run:\n        working-directory: planted\n'}},
 {id:'gate-path-step-cwd',class:5,code:'gate-unverified',change:{gateFields:'        working-directory: planted\n'}},
 {id:'gate-path-shell-cd',class:5,code:'gate-unverified',change:{gateRun:'cd planted && node .shared/third-party/check.mjs --repo .'}},
 {id:'gate-path-multiline-cd',class:5,code:'gate-unverified',change:{gateRun:'|\n          cd planted\n          node .shared/third-party/check.mjs --repo .'}},
 ...['node_options','node_path','Path','bash_env'].map((name,i)=>({id:`windows-case-${i+1}`,class:6,code:'prior-environment-write',change:{prior:`      - uses: actions/checkout@v4\n        env:\n          ${name}: planted\n`}})),
 {id:'loader-ld-audit',class:7,code:'inherited-execution',change:{topFields:'env:\n  LD_AUDIT: planted.so\n'}},
 {id:'loader-legacy-command',class:7,code:'inherited-execution',change:{jobFields:'    env:\n      ACTIONS_ALLOW_UNSECURE_COMMANDS: true\n'}},
 {id:'loader-bash-function',class:7,code:'inherited-execution',change:{topFields:"env:\n  'BASH_FUNC_node%%': planted\n"}},
 {id:'loader-lower-ld-audit',class:7,code:'inherited-execution',change:{jobFields:'    env:\n      ld_audit: planted.so\n'}},
 {id:'dynamic-prior-env',class:8,code:'prior-environment-write',change:{prior:'      - uses: actions/checkout@v4\n        env: ${{ inputs.environment }}\n'}},
 {id:'merge-prior-env',class:8,code:'prior-environment-write',change:{prior:'      - uses: actions/setup-node@v4\n        env:\n          <<: ${{ inputs.environment }}\n'}},
 {id:'dynamic-gate-env',class:8,code:'gate-unverified',change:{gateFields:'        env: ${{ inputs.environment }}\n'}},
 {id:'merge-job-env',class:8,code:'inherited-execution',change:{jobFields:'    env:\n      <<: ${{ inputs.environment }}\n'}},
];
