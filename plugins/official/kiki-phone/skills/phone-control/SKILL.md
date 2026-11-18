---
name: phone-control
description: Connect and operate Android phones, rooted Android devices and iOS through Kiki Phone. Use when the user asks for phone screenshots and UI trees, semantic or humanized taps/swipes, anti-bot safe mobile app operation, text entry, apps, recording, one-click setup, USB or wireless debugging, or explicitly requested Android su commands. Not for desktop or browser automation.
---

# Phone Control (`kiki-phone`)

## 1. Tool Selection

| Task | Tool | Notes |
| --- | --- | --- |
| UI observation, taps, swipes, text, power/IME | `phone_run` | Async JS with Mobilewright `device`, `screen`, `expect`, `snapshot()`, `screenshot()`, `device.wake()/unlock()/sleep()/screenState()/ensureCleanIme()`, `device.humanDelay()`, `screen.typeText()/humanTap()/humanSwipe()`. Omit `script` to list online devices. |
| Runtime setup or ADB diagnosis | `phone_prepare` | Run only when runtime is missing or transport fails. Pass `download: true` only after user accepts Google platform-tools terms; custom ADB paths belong in plugin setting `adbPath`. |
| USB/wireless ADB state, pair, connect | `android_connection` | `devices` shows `unauthorized`/`offline`; `pair` uses pairing port + 6-digit code; `connect`/`disconnect` use debugging port. |
| Rooted or shell argv on Android | `android_shell` | Pass exact ADB `serial` from `android_connection({ action: "devices" })` and string `argv[]` (`root: true` runs `su -c` only when explicitly requested). |
| Recording, app install, logs, cloud | `phone_help` -> `phone_call` | Query schema with `phone_help`, then invoke `phone_call({ name: "mobile_*", arguments })`. Serialize calls per phone. |

## 2. Route by App Risk Tier

Read `references/anti-risk-control.md` before automating apps with client-side gesture or accessibility telemetry.

- **Tier S (Strict anti-bot: Taobao, Xianyu, WeChat, Alipay, banking)**:
  - **Pure vision only**: `await screenshot()` (`<= 5-6` attached images per task; `{ attach: false, path }` for disk-only). **Never** call `snapshot()`, `screen.getBy*(...)`, or `expect(locator)` (locators dump two accessibility trees `50ms` apart and `.fill()` uses `ACTION_SET_TEXT`).
  - **Humanized entry & touch**: start from Home/Launcher (`pressButton('HOME')` or `launchApp` + `humanDelay(800, 1600)`), never cold-jump detail URLs, act via `screen.humanTap(box)` + `screen.humanSwipe('up')`, and run `await device.ensureCleanIme()`.
  - **`0`-retry risk-wall stop**: on any slider/CAPTCHA (`baxia`/`punish`), abnormal-environment prompt, or forced login wall, stop immediately with `0` retries, save one screenshot, and hand off to the user (`1800s` cooldown).
- **Tier A (Transaction/delivery: Meituan, Eleme, JD, Hema)**:
  - Single sparse `snapshot()` on settled screens for fees/totals (`screenshot()` for Canvas popups; never poll `snapshot()` in loops), plus `screen.humanTap(node.bounds)`. Stop on order-confirmation preview unless authorized; undo only items added in the current round.
- **Tier B (System & standard apps: `com.android.settings`, utilities, debug builds)**:
  - `snapshot()` + `screen.getByText` / `getByLabel` / `getByRole` / `getByTestId` (`.tap()` uses safe-core humanized touch by default; pass `{ raw: true }` or `KIKI_PHONE_RAW_INPUT=1` for raw `0ms` center taps).

```js
await device.wake();
await device.launchApp('com.android.settings');
console.log(await snapshot());
await screen.getByText('显示', { exact: true }).tap();
```

Coalesce predictable same-screen micro-steps into one `phone_run` call (`humanTap` -> `humanDelay(350, 700)` -> `typeText` -> `humanTap`) instead of inserting random decoy clicks. Re-observe before repeating any action whose outcome was unclear, and never write passwords to files or logs.

## 3. Failure Recovery

- **`Mobilewright runtime missing`**: Call `phone_prepare({})` (or `{ platform: "ios" }` on iOS).
- **`authorization_required` / `unauthorized`**: Ask the user to unlock the phone and tap Allow on the USB debugging RSA dialog, then recheck `android_connection({ action: "devices" })`.
- **`device_offline` / selected phone offline**: Do not switch to another phone silently. Run `android_connection({ action: "devices" })`; for wireless ADB, reconnect the current debugging port (`connect`) or re-pair (`pair`) if expired.
- **`secure_keyguard` (PIN/password/pattern lock)**: `device.wake()` turns the screen on without swiping blindly; ask the user to unlock the phone manually or via the `Phone Preview` workspace panel (`Interactive` toggle).
- **Lingering `AdbIME` / missing soft keyboard**: Run `await device.ensureCleanIme()` in `phone_run` to restore the native system IME.
- **iOS physical device**: Requires USB trust, Developer Mode, and a valid signed DeviceKit agent (`npx --yes mobilecli@1.0.21 agent install --device <id> --provisioning-profile <abs-path>`).
