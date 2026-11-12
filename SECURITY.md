# Security policy

## Reporting a vulnerability

Open a private security advisory on GitHub (Security -> Advisories -> Report a
vulnerability) if the repository is public, or contact the maintainers listed in
the repository. Do not open a public issue for an unpatched vulnerability.

## Operating this MCP server safely

This server is a thin wrapper over hypervisor and guest control APIs. It is
powerful by design; treat the MCP client as fully trusted.

- **Never commit credentials.** ESXi host credentials live in
  config/esxi-hosts.json, which is git-ignored, and are passed to govc through
  environment variables, not command lines. Prefer the password_env field or
  the ESXI_HOSTS_FILE override so that no plaintext password sits in a file.
- **Guest credentials** (guest_user/guest_password or ESXI_GUEST_USER /
  ESXI_GUEST_PASSWORD) are handed to vmrun/govc as arguments in some code
  paths. Do not put them in shell history, screenshots, or the repository.
- **VNC is effectively unauthenticated on ESXi 6.5** in our testing (the
  server negotiated security type "none" even when RemoteDisplay.vnc.password
  was set). Bind VNC to 127.0.0.1, keep the ESXi firewall closed, and reach it
  through an SSH tunnel. Disable VNC again when done (esxi_vnc disable).
- **Console power operations are destructive.** Prefer graceful shutdown
  (esxi_vm_power stop mode=soft, vm_power stop mode=soft) over hard power-off;
  repeated hard power-offs can push a Windows guest into recovery mode.
- **Screenshots and logs may contain secrets.** Console screenshots can include
  passwords, internal host names and confidential application windows. Do not
  publish demo images captured from real machines without redaction.
- Keep govc and VMware Tools up to date; both are separate downloads.

## Scope

The MCP server itself runs with the privileges of the user who launched it on
the machine that runs the MCP client. It has no network listener of its own
(stdio transport). The remote services it touches are protected by the
hypervisor and guest APIs, not by this server.
