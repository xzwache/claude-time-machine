# Security policy

The time machine copies project files, including small ignored files such as local config, into a git repository under
`~/.claude/time-machine/`. It never sends anything over the network. Secrets (`.env` files, keys and certificates,
`.npmrc` and other credentials) are left out unless a project opts in with `/tm secrets keep`. Bugs that could leak
those files, copy a secret that should have been left out, write outside the project, or overwrite work without a way
back are treated as security issues.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/xzwache/claude-time-machine/security/advisories/new), not in public
issues. Include the steps to reproduce and the version (`/tm stats` or `.claude-plugin/plugin.json`).

You should get a reply within a week. Fixes go into the next release, and the advisory is published once it is out.

## Supported versions

Only the latest release gets security fixes.
