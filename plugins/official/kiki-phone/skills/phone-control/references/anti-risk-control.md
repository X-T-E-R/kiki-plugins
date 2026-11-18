# Anti-Risk-Control Playbook (L1 Policy / L2 Primitives / L3 Hardware HID)

Use this reference before automating apps that run client-side bot/gesture telemetry, accessibility-tree monitors, or checkout risk engines.

## Scope and Honest Security Boundary

- **What L1 + L2 mitigate**: Accessibility view-tree polling storms (`getViewHierarchy`), `ACTION_SET_TEXT` zero-keystroke text injection, `0ms` pulse taps, zero-entropy geometric dead-center hits, zero-curvature constant-velocity linear swipes, lingering third-party automation IMEs (`AdbIME`), and contextless deep-link cold jumps.
- **What remains at OS level under software control**: Whenever `mobilecli` / `UiAutomation` or `adb` is attached, Android still reports `ADB_ENABLED=1`, an active `UiAutomation` bridge, and `MotionEvent.deviceId = -1` (`VIRTUAL_KEYBOARD_ID`). Software mode mitigates behavioral and accessibility-polling signals, not OS-level debugging flags—eliminating `ADB_ENABLED=1` and `deviceId = -1` requires **L3 physical BLE/USB HID hardware** (see Section 5).

---

## 1. App Risk Tier Classification (L1 Routing)

| Tier | Representative Apps | Observation Mode | Touch & Input Primitives | Entry, Cart & Stop Rules |
| --- | --- | --- | --- | --- |
| **Tier S** (Strict client-side telemetry) | Taobao (`com.taobao.taobao`), Xianyu (`com.taobao.idlefish`), WeChat (`com.tencent.mm`), Alipay, banking / financial apps | **Pure vision only**: use `await screenshot()`. **Never** call `snapshot()`, `screen.getBy*(...)`, or `expect(locator)` | `screen.humanTap(box)`, `screen.humanSwipe(...)`, `device.humanDelay()`, native system IME (`device.ensureCleanIme()`) | Enter from Home/Launcher (`pressButton('HOME')` or `launchApp` + `humanDelay(800, 1600)`); never cold-jump item detail URLs; search `"shop + item"` from main search bar (in-shop search <= 1 per shop); **0 retries** on risk walls + `1800s` cooldown |
| **Tier A** (Transaction & fulfillment) | Meituan (`com.sankuai.meituan`), Eleme (`me.ele`), JD (`com.jingdong.app.mall`), Hema (`com.wudaokou.hippo`) | **Sparse single `snapshot()`** after screen settles to read exact distances/fees/totals; `screenshot()` for custom Canvas/WebView popups; never poll `snapshot()` in loops | `screen.humanTap(node.bounds)` or `screen.humanTap(locator)`, `screen.humanSwipe('up')`, `device.humanDelay()` | Stop strictly on order-confirmation preview unless explicitly authorized to submit; on exit, **undo only items added in the current test round** (never clear historical cart items) |
| **Tier B** (System & low-sensitivity utilities) | Android Settings (`com.android.settings`), Clock, Calculator, local debug builds | Standard `snapshot()` + semantic locators (`getByText`, `getByLabel`, `getByRole`, `getByTestId`) | `.tap()`, `.fill()`, `.check()`, `expect()` (`.tap()` uses safe-core humanized touch by default; pass `{ raw: true }` or `KIKI_PHONE_RAW_INPUT=1` for raw `0ms` center taps) | Standard action verification; no artificial inter-step delays needed |

### Two Critical Underlying Traps to Avoid

1. **Implicit double tree dump inside `screen.getBy*(...)`**:
   Even though `locator.tap()` now humanizes its final touch trajectory, Mobilewright's `locator.tap()` / `resolveActionable()` still fetches two full accessibility trees `50ms` apart to verify bounds stability, and `locator.fill()` invokes `AccessibilityNodeInfo.performAction(ACTION_SET_TEXT)` with zero keyboard events. On Tier S, avoid `screen.getBy*(...)` completely and pass visual `{ x, y, width, height }` boxes straight to `screen.humanTap(box)`.
2. **Never use `adb shell input motionevent`**:
   AOSP `InputShellCommand.sendMotionEvent()` sets both `downTime` and `eventTime` to `SystemClock.uptimeMillis()` on every invocation. Injecting `DOWN` / `MOVE` / `UP` via separate shell commands overwrites `downTime` on every frame (`eventTime - downTime == 0ms`), producing an impossible physical signature plus `50-150ms` IPC stalls. Always use `screen.humanTap()` / `screen.humanSwipe()`, which replay constant-`downTime` pointer trajectories in-process through `screen.gesture({ pointers })` (or fall back to a single atomic `input swipe x0 y0 x1 y1 holdMs`).

---

## 2. Humanized Input Primitives & Rhythm Rules (L2)

### Available `phone_run` Helpers (Default Humanized + Raw Escape Hatch)

- **Default protection on `screen.tap()`, `screen.swipe()`, and `locator.tap()`**:
  - Whenever gesture replay (`screen.gesture`) is available, `screen.tap(x, y)`, `screen.swipe(...)` (`direction` or `(x1, y1, x2, y2, duration?)`), and `locator.tap()` automatically execute humanized trajectories so forgetful scripts never leak `0ms` dead-center taps or collinear constant-velocity swipes.
  - Pass `{ raw: true }` (e.g., `await screen.tap(x, y, { raw: true })`, `await screen.swipe('up', { raw: true })`, `await locator.tap({ raw: true })`) or set `KIKI_PHONE_RAW_INPUT=1` when exact raw `0ms`/linear injection is needed.
- `await screen.humanTap(target, opts?)` / `await screen.humanTap(x, y, opts?)`:
  - Accepts a visual `{ x, y, width, height }` box, a `snapshot()` node `{ bounds }`, a Mobilewright `locator`, or `(x, y)` coordinates.
  - Samples a truncated Gaussian point inside the central `44% x 44%` safe core (`insetRatio = 0.28`, `sigmaRatio = 0.12`, wide-row offset capped at `maxOffsetPx = 96`) so edges and side icons are never hit, holds for `55-125ms` right-skewed log-normal dwell, and applies `<= 1px` fingertip micro-roll (`<< 24px` Android `touchSlop` and safe for `3-5 CSS px` H5 click listeners). Returns `{ x, y, holdMs }`.
- `await screen.humanSwipe(direction, opts?)` / `await screen.humanSwipe(x1, y1, x2, y2, durationOrOpts?)`:
  - Supports `'up' | 'down' | 'left' | 'right'` (randomized off-center thumb zone start, or explicit `startX`/`startY`/`distance`) or explicit endpoints.
  - Generates a single-arch cubic Bezier curve (`3.5%-8%` chord arch with randomized control knots), fast initial escape on frame 1 (avoids accidental long-press recognition), ballistic-skewed S-curve velocity, inter-frame `dt` micro-jitter, and converging 2D physiological tremor (`0` at release so `VelocityTracker` fling never reverses). Returns `{ x1, y1, x2, y2, durationMs, steps }`.
- `await device.humanDelay(minMs = 450, maxMs = 1350)`:
  - Waits a right-skewed human pause (`(max - min) * u^1.4`) respecting script cancellation, returning actual `ms`. After `device.launchApp(...)` or `screen.pressButton('HOME')` on Android 14-16 / HyperOS, wait `humanDelay(800, 1400)` before `humanTap`/`humanSwipe` so `ShellTransitions` window animations finish and `InputDispatcher` does not cancel in-flight `ACTION_UP` events.
- `await device.ensureCleanIme()`:
  - Checks `settings get secure default_input_method` on Android; if `adbkeyboard` / `AdbIME` is active, switches back to the first installed system IME and disables `AdbIME`. Returns `{ changed, current?, previous?, restored? }`.

### Anti-Decoy Rhythm Rule (No Random Blind Actions)

- **Never insert random fake taps, aimless scrolling, or "account-warming" wandering loops** to mask LLM thinking latency. Empirical evaluation (`arXiv:2604.09574`) shows blind decoy actions frequently hit banners/ads/popups and collapse multi-step task completion rates (`0.75 -> 0.15`).
- Instead, **coalesce predictable same-screen micro-steps into one `phone_run` call** (for example: tap search box -> `humanDelay(350, 700)` -> type query -> `humanTap(searchButtonBox)`) so intra-page cadence looks continuous rather than spaced by uniform `8-12s` model turns. Keep attached screenshots `<= 5-6` per task to stay well under HTTP 413 payload limits; pass `{ attach: false, path }` for disk-only evidence.

### Tier S Pure-Vision Pattern

```js
await device.wake();
await device.ensureCleanIme();
// Step 1: capture screen visually (no snapshot, no getBy*)
await screenshot();
```

After reading the target bounding boxes from the returned image:

```js
// Step 2: execute coherent in-page sequence with humanized touch + natural cadence
await screen.humanTap({ x: 180, y: 148, width: 680, height: 88 });
await device.humanDelay(350, 700);
await screen.typeText('M3 304 nut', { submit: false });
await device.humanDelay(280, 550);
await screen.humanTap({ x: 910, y: 148, width: 130, height: 88 });
await device.humanDelay(900, 1600);
await screen.humanSwipe('up');
await device.humanDelay(500, 1100);
await screenshot();
```

---

## 3. Clean Text Entry & Transient IME Recovery

Persistent `com.android.adbkeyboard/.AdbIME` in `default_input_method` is a high-signal device-farm fingerprint.

1. Prefer tapping the input box via `screen.humanTap(box)` to raise the phone's normal system keyboard (Gboard, FlyIME, Doubao, MIUI/HyperOS keyboard) and entering ASCII model numbers or short queries via `screen.typeText(...)` + key selection.
2. Avoid repeated cross-app clipboard writes on Android 12+, which trigger system toast banners and `OnPrimaryClipChangedListener` hooks.
3. If an external workflow temporarily enables `AdbIME`, wrap it in `try / finally` so dwell time stays `< 500ms`, and always call `await device.ensureCleanIme()` before returning:

```js
const imeCleanup = await device.ensureCleanIme();
console.log(imeCleanup);
```

---

## 4. Risk-Wall `0`-Retry Hard-Stop Protocol

When any screenshot or page observation reveals:
- Slider verification (`向右滑动验证`, `baxia-slider`, `punish`, puzzle/9-grid CAPTCHA),
- Abnormal environment / security verification prompts (`环境异常`, SMS verification), or
- Forced re-login / session-downgrade screens (`tmd` login wall),

**execute the `0`-retry stop immediately**:
1. **Exempt from standard 3-retry stall rules (`0` retries)**: do **not** re-tap, refresh, switch search endpoints, or attempt to drag CAPTCHA sliders automatically.
2. Save one diagnostic screenshot (`await screenshot({ attach: false, path: '/abs/path/risk-wall.png' })` or one attached frame).
3. Run `await device.ensureCleanIme()` if IME state could be dirty, then stop all automated input and hand control back to the user to complete verification manually.
4. Recommend at least **`1800s` (30 minutes)** of cooldown on that app/engine before resuming automated queries.

---

## 5. L3 Hardware Escalation (`ESP32-S3` Physical BLE/USB HID)

### When L3 Is Warranted (and When It Is Not)

- **Stay on L1 + L2** for routine food-delivery coupon/checkout previews and low-frequency shopping lookups.
- **Escalate to L3 (`~20 RMB` `ESP32-S3`)** only when:
  1. Automating a **personal primary WeChat** account at frequency (super-apps can flag privileged `INJECT_EVENTS` / `ADB` environments even without accessibility services enabled);
  2. High-frequency Taobao / Xianyu patrols still hit slider walls due to `ADB_ENABLED=1` or `deviceId = -1`;
  3. Android 16+ banking / cross-border payment apps enforce Play Integrity `App Access Risk` and refuse to run while Developer Options / USB Debugging is enabled.

### Recommended L3 Topology

- **Controller**: Dual Type-C **`ESP32-S3-DevKitC-1`** (`UART` port receives serial trajectory frames from host PC; native USB/BLE side pairs to the phone as **BLE 5.0 HID `Digitizer Touch Screen (0x0D/0x04)` + `HID Keyboard`**, leaving the phone's Type-C port free for continuous fast charging).
- **Eliminated OS signals**: Turn **USB Debugging**, **Wireless Debugging**, and **Developer Options** completely **OFF** (`ADB_ENABLED=0`, no `adbd`, no `UiAutomation`). Kernel events arrive from `/dev/input/eventX` hardware drivers with a positive hardware `deviceId > 0`.
- **Zero-ADB vision feed**: Pair with LAN screen mirroring or a `Type-C to HDMI + USB UVC capture card` so visual grounding also stays physically decoupled from ADB.

### Four Field Pitfalls to Avoid

1. **Separate HID report descriptors**: Keep absolute `Touch Screen` (`Logical Minimum 0 .. Logical Maximum 10000`) and relative `Mouse` on distinct HID interfaces to avoid TinyUSB descriptor conflicts. Lock the phone in **portrait** orientation (some Android ROMs do not auto-rotate external digitizer axes in landscape; note also that iOS 13.4+ ignores absolute BLE touch digitizers, so BLE absolute touch targets Android).
2. **Modulate contact pressure & area**: Bare-bones HID firmware that emits constant `Tip Pressure = 1` and `Width/Height = 0` remains distinguishable. Declare `Tip Pressure (0x30)` and `Width/Height (0x48/0x49)` in the HID descriptor and apply slight frame-by-frame envelope variation during touch down/move/up.
3. **Mitigate `Touch + IMU` sensor flatline physically (never root a main phone)**: A phone lying flat on a rigid desk exhibits zero-variance accelerometer/gyroscope readings (`flatline`) during touch events (`arXiv:2608.30038`). **Do not root or install Zygisk/Shamiko on a primary phone** to spoof IMU sensors—native security SDKs (`libsgmain.so`, `libmtguard.so`) penalize root artifacts far more severely. Instead, mount the phone on a **flexible silicone gooseneck or spring holder** so ambient micro-vibrations couple naturally into each tap, and hand off rare hard verifications to the user.
4. **Keep L1 behavioral discipline**: Even with hardware `deviceId > 0`, cold deep-link jumps, bursty single-endpoint searches, or mechanical `0ms` center taps will still trip behavioral models—reuse the exact `human-input` Bezier/Gaussian keyframes over the serial HID link.
