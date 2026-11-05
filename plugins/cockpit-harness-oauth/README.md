# Cockpit Harness OAuth

Use an existing Cockpit OAuth account for a selected AGY CLI or Codex app-server instance. This optional plugin requires Kiki 0.4.2 or newer and registers `plugin:cockpit-harness-oauth/cockpit-oauth`.

Build the separate `cockpit-harness-oauth` backend and its matching Cockpit sidecar, then configure these plugin settings on the Kiki server:

- `backendPath`: absolute path to the existing `cockpit-harness-oauth` or `cockpit-harness-oauth.exe` executable.
- `sidecarPath`: absolute path to the configured Cockpit sidecar.
- `dataDir`: optional absolute data directory passed to the backend.

Cockpit's desktop app can stay closed. The backend reads the same account store and starts only when you list accounts or prepare an instance. The existing global AGY login does not change. The panel lists account metadata; connection credentials travel through the private backend/host interface and are not saved in plugin settings.

Releasing an instance closes its loopback endpoint. Disabling the plugin releases all remaining leases. If a backend exits, prepare the instance again to obtain a new connection. A quota or authorization error stays with the selected account; choose another account explicitly or restore its authorization in Cockpit.

This MIT wrapper does not bundle Cockpit code or provide a downloader. The separately built Cockpit backend retains CC-BY-NC-SA-4.0; the sidecar's MIT components retain their original licenses.
