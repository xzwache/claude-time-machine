// Which shell commands the time machine treats as read-only.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { isReadOnlyCommand } from '../hooks/bash.ts'

describe('read-only commands', () => {
  const readOnly = [
    'ls -la',
    'cat src/a.ts | grep foo',
    'git status && git diff --stat',
    'rg -n "TODO" src 2>/dev/null',
    'find . -name "*.ts" -type f',
    'cd src && ls',
    'sed -n 1,20p file.ts',
    'git log --oneline -5 2>&1 | head',
    'FOO=1 grep -r x .',
    '/usr/bin/wc -l a.ts',
  ]
  const writes = [
    'echo hi > a.txt',
    'cat a >> b',
    'sed -i s/a/b/ file.ts',
    'find . -name "*.tmp" -delete',
    'git checkout -- .',
    'git stash',
    'npm test',
    'rm -rf build',
    'ls $(touch x)',
    'grep x a | tee out.txt',
    'sort -o out.txt in.txt',
    'awk \'{ print > "out" }\' in',
    'git -C other status',
    'env rm x',
    'xargs rm < list',
    '',
  ]
  for (const command of readOnly) {
    test(`skips snapshots around: ${command}`, () => assert.equal(isReadOnlyCommand(command), true))
  }
  for (const command of writes) {
    test(`snapshots around: ${command || '(empty)'}`, () => assert.equal(isReadOnlyCommand(command), false))
  }
})
