const text = (description) => ({ type: 'string', description });
const tool = (name, description, properties, required) => ({
  schemaVersion: 1, name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
  accesses: [{ kind: 'all' }], disclosure: 'deferred',
});

export const definitions = [
  tool('phone_prepare',
    'Prepare the phone runtime and report the actual device state. Reuse the selected ADB across phone tools and install upstream packages privately. If Windows ADB is missing, download=true accepts the linked Google terms and permits its download. Preparation does not connect a phone automatically.',
    {
      download: { type: 'boolean', default: false, description: 'Consent to download official Google platform-tools if ADB is missing, under the terms at https://developer.android.com/tools/releases/platform-tools.' },
      platform: { type: 'string', enum: ['android', 'ios'], default: 'android', description: 'iOS prepares upstream packages without requiring Android ADB.' },
      deviceId: text('Optional target device serial to check readiness for without mutating the global selected device.'),
    }, []),
  tool('phone_run',
    'Preferred phone interface: run async JavaScript with Mobilewright device, screen and expect, plus snapshot(), screenshot(), Android device.wake()/unlock()/sleep()/screenState()/ensureCleanIme(), device.humanDelay(), and screen.typeText()/humanTap()/humanSwipe(). screen.tap/swipe and locator.tap use humanized touch by default ({ raw: true } or { transport: "raw" } for raw input, with automatic ADB fallback on HyperOS bottom-edge INJECT_EVENTS zones); pass deviceId for isolated concurrent multi-phone operation without overwriting selected-device.json.',
    {
      script: text('Async JavaScript body. Example: await device.wake(); console.log(await snapshot()); await screenshot(); Native device/screen/expect are Mobilewright 0.0.67 APIs with humanized touch by default ({ raw: true } or KIKI_PHONE_RAW_INPUT=1 for raw input) plus Android power/lock/IME helpers and humanTap/humanSwipe/humanDelay; console output is returned.'),
      deviceId: text('Per-call target device serial/id. Runs in an isolated per-serial warm worker and never overwrites global selected-device.json.'),
      device: text('Online upstream device id. Required when multiple devices are online and none has been selected. Reuses and persists the selected device when deviceId is omitted.'),
      platform: { type: 'string', enum: ['android', 'ios'], default: 'android' },
      overrideHumanTakeover: { type: 'boolean', default: false, description: 'Set true only when the user explicitly instructs the agent to act while Human Takeover is active on this target phone.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 90000, description: 'Whole script deadline; completed phone actions are not rolled back on cancellation or timeout.' },
    }, []),
  tool('android_connection',
    'Manage Android ADB connections, separate from screen control. devices returns raw adb devices -l output including unauthorized/offline states; select persists default selected-device.json; pair uses the wireless pairing address and code; connect/disconnect use the connection address. Pairing and connection ports differ. Requires official Android platform-tools. Does not restart ADB.',
    {
      action: { type: 'string', enum: ['devices', 'pair', 'connect', 'disconnect', 'select'] },
      address: text('IP:port or host:port. Required for pair, connect and disconnect. Use the pairing port for pair and the debugging port for connect.'),
      deviceId: text('Android serial to set as the global default selected device when action="select".'),
      code: text('Wireless debugging pairing code; required only for pair.'),
    }, ['action']),
  tool('android_shell',
    'Run one explicit Android shell command through official adb, optionally using su for a rooted phone. Pass serial (or deviceId) from android_connection devices and command argv, not a shell program. root=true invokes su -c and may prompt on the phone; it does not run adb root. Use upstream Mobile MCP for UI, text and app operations. Returns actual stdout/stderr/exit status; never retries.',
    {
      serial: text('Exact adb transport serial from android_connection devices, including IP:port for wireless devices. May differ from the Mobile MCP device id.'),
      deviceId: text('Alias for serial when targeting a specific Android device.'),
      argv: { type: 'array', minItems: 1, items: text('One command argument. Quotes, spaces and Chinese characters are preserved as data.') },
      root: { type: 'boolean', default: false, description: 'Use su only for an explicitly requested privileged operation. Ordinary commands run as adb shell.' },
    }, ['argv']),
];
