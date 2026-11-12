# Contributing

Thanks for taking a look. The project is intentionally dependency-free: the
server and all tools use Node.js built-in modules only. Please keep it that way
unless there is a strong reason.

## Local setup (Windows)

~~~powershell
scripts\fetch-govc.ps1            # downloads govc into tools\ (git-ignored)
node --test tests\unit.test.js    # fast tests
node tests\probe.js               # MCP protocol smoke test (needs vmrun installed)
~~~

On Linux/macOS use scripts/fetch-govc.sh and node tests/unit.test.js. The
end-to-end tests (tests/e2e.js, tests/esxi-vcsim.js, tests/esxi-live.js) need a
local VMware Player/Workstation, the vcsim download, or credentials for a real
ESXi host; they are not part of CI.

## Pull requests

- One focused change per PR; include a short motivation and what you tested.
- Run node --check on every modified src/*.js and node --test tests/unit.test.js.
- If you touch the MCP tool surface, update README's tool tables and keep tool
  names stable (they become mcp__<server>__<name> in clients).
- Do not add secrets, host inventories, screenshots of real machines, or
  config/esxi-hosts.json to a commit. Check git status before pushing.
- Encoding rule: JSON/YAML/JS files stay UTF-8. .vmx edits are written by the
  server as latin1 on purpose; do not "fix" that.

## Security-sensitive changes

Changes touching credential handling, command construction, VNC exposure, or
power operations should call that out in the PR description. See SECURITY.md.
