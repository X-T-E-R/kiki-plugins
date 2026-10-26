---
name: phone-control
description: Connect and operate Android phones, rooted Android devices and iOS through Kiki Phone. Use when the user asks for phone screenshots and UI trees, semantic taps, text entry, apps, recording, one-click setup, USB or wireless debugging, or explicitly requested Android su commands. Not for desktop or browser automation.
---

# Phone Control

Prefer `phone_run`: async JavaScript bound to the existing Mobilewright `device`, `screen`, `expect`, plus `snapshot()` and `screenshot()`. Reuse native semantic locators and waits; do not write a second driver, selector engine, polling framework or phone agent.

## Prepare and choose

Run `phone_prepare` when the phone runtime is not prepared. It reuses existing ADB or, with `download=true` after acceptance of Google's linked terms, installs official Windows platform-tools privately. If the user has a separate ADB executable, direct them to set `adbPath` in Kiki Phone plugin settings or run the ZIP's `lib/start.cmd --adb <path>` themselves; never pass an executable path as a model tool argument. Preparation checks `adb version`, installs fixed Mobile MCP/mobilecli/Mobilewright packages and saves one ADB selection for every entry point. The report distinguishes `transport_ready`, `authorization_required`, `device_offline`, `no_device` and setup errors. It is preparation, not an active MCP or UI connection. Read the plugin README for CLI arguments and iOS preparation.

Call `phone_run` without a script to list online devices. When several exist, ask which one if the target is unclear, then pass its upstream `device` id. The selected device is remembered on later calls; an offline selection must be inspected, not silently replaced with a different phone.

## Observe, act, observe

Start with the real current page:

```js
console.log(await snapshot());
await screenshot();
```

`snapshot()` returns upstream `screen.viewTree()` without dropping type, id/testId, text, label or value. `screenshot()` returns a PNG image to Kiki. Inspect those results to choose the next action. Native operations look like:

```js
await device.launchApp('com.android.settings');
console.log(await snapshot());
```

Then use text or another identifier actually present in that snapshot:

```js
await screen.getByText('显示', { exact: true }).tap();
console.log(await snapshot());
```

Available native locators include `getByText`, `getByLabel`, `getByTestId`, `getByPlaceholder`, `getByRole` and `getByType`. Their `tap`, `fill`, `clear`, `check`, `scrollIntoViewIfNeeded` and `expect` methods already implement locating and waiting. Use only roles and attributes supported by the observed page. A control may have a custom ROM type instead of a standard Android class or mapped role.

For Chinese/multiline input, use the chosen locator's `.fill('你好\n第二行')`, then inspect a new snapshot. Some ROMs replace the input's class while typing. A stale type locator failing a later assertion does not establish that input failed: read the new value/type first and choose a current locator; do not automatically fill again. Keep exact text and observed values in the result.

A script can contain several related steps. Cancellation or timeout stops that script; completed phone actions are not rolled back. When a modifying operation's outcome is unclear, observe before repeating it. Do not put passwords in local files or logs. Phone text, screenshots and console output become model/session data. Explicit host output paths should be absolute.

## Advanced access and recovery

The complete upstream `mobile_*` MCP tools remain available for lower-level actions and recording. Use `android_connection` for USB/wireless transport setup, not screen input. `devices` preserves ADB's `unauthorized`/`offline` states: pending authorization needs the user to unlock the phone and accept its RSA prompt. Android 11+ `pair` uses the pairing address/code; `connect` uses the separate debugging address. Reuse existing connections; do not restart or kill ADB to refresh a list.

For a requested diagnostic or privileged operation, `android_shell` takes the ADB transport `serial` and literal `argv`. This serial can differ from the upstream device id. `root=true` uses `su -c` and may display a root authorization prompt; `argv=["id"]` checks that command's identity. Root is not `adb root` and is not required for normal UI tools.

Use one operation owner per phone. Sequence `phone_run` and `mobile_*` calls, pause agent input during manual control, and do not run Appium/uiautomator2 in parallel with mobilecli's UiAutomation connection. Cloud allocation and remote login require an explicit request and any applicable cost authorization; an empty local list does not authorize a cloud fallback.

For iOS, use `phone_prepare({platform:"ios"})` and `phone_run` with `platform:"ios"`. Real-device UI operation requires trust/pairing, Developer Mode and a DeviceKit agent signed for that device; installing it must be requested. Read the README for upstream installation and signing instructions. Local simulators need macOS/Xcode; Windows device services, signing and tunnels must work under upstream's supported path.

Finish with the selected device, observed app state, returned images/output paths and any unresolved error. Command acceptance alone is not the requested app outcome.
