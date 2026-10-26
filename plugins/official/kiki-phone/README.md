# Kiki Phone

让 Kiki 像操作浏览器一样操作手机：先看当前页面，再按文字、标签或控件语义定位，点击、输入并检查结果。默认入口 `phone_run` 直接使用 [Mobilewright](https://github.com/mobile-next/mobilewright) 的 `device`、`screen` 和 `expect`；连接准备、完整 [Mobile MCP](https://github.com/mobile-next/mobile-mcp) 工具及 Android root 命令也在同一个插件中。

## 准备运行环境

需要 Node.js **22.12.0+**（含 npm），并让 `node` 在 Kiki 进程的 PATH 上可用。缺少时安装 Node 并加入 Kiki 的启动环境，再重试。开发本插件仓库需要 Node.js 24.15.0+。

**Windows**：解压插件 ZIP，双击 **`lib/start.cmd`**。脚本检查 Node/npm、复用现有 ADB、安装上游运行包，并列出手机连接状态。缺少 ADB 时会显示 Google 下载地址与许可条款；同意后才下载官方 platform-tools。已有 ADB 时不重新下载，也不重启／停止现有 ADB server。

**在 Kiki 对话里**：安装启用后，在运行包尚未准备时调用 `phone_prepare`。缺少 ADB 时，确认 [Google SDK Platform-Tools 条款](https://developer.android.com/tools/releases/platform-tools) 后用 `download=true` 继续。若已有官方 ADB，由你在 Kiki Phone 插件设置中填写 `adbPath`，或在自己的终端运行 `lib/start.cmd --adb <adb.exe路径>`；模型工具参数不接受可执行文件路径。准备时验证 `adb version`，并将选择保存供脚本、连接工具和 MCP 共用。

数据默认存放在 Windows `%LOCALAPPDATA%/kiki-phone`、macOS `~/Library/Application Support/kiki-phone` 或 Linux `$XDG_DATA_HOME/kiki-phone`（未设置时为 `~/.local/share/kiki-phone`），不修改全局 PATH、注册表或 Kiki home。它包含 ADB 选择、私有 npm 运行包／缓存和所选设备。需要指定开发或隔离目录时，设置 `KIKI_PHONE_DATA_DIR`；所有入口应使用相同值。源码更新或重装插件不会删除这份数据。

准备结果区分：

| 状态 | 下一步 |
| --- | --- |
| `transport_ready` | ADB transport 在线；接着用 `phone_run` 查看可操作设备及页面 |
| `authorization_required` | 解锁手机并接受 USB 调试 RSA 授权，再检查 |
| `device_offline` | 检查数据线／无线连接，再检查 |
| `no_device` | 运行环境已准备，连接开启 USB 调试的手机，或进行无线配对 |
| `download_consent_required` | 同意 Google 条款后下载，或在插件设置／本地一键脚本指定已有 ADB |
| `error` | 按返回的 npm／下载／ADB 原始错误处理 |

准备报告中的 `mcp.connected=false` 表示本步骤只完成准备；Kiki 的 MCP 管理入口才展示实际 MCP 连接。Windows USB 连接可能还需要手机厂商的驱动。

开发时在仓库根目录安装：

```text
/plugins install --trust ./plugins/official/kiki-phone
/plugins enable kiki-phone
```

ZIP 用户将解压后包含 `kimi.plugin.json` 的目录传给 `/plugins install --trust <目录>`。官方目录入口随正式发布提供。插件 MCP server 名为 `mobile`；若曾单独关闭，用 `/plugins mcp enable kiki-phone mobile` 开启。更换共享 ADB 后，重新连接这个 MCP server，使已启动进程取得新环境。

## 按语义操作，而不是先找坐标

先调用不带脚本的 `phone_run` 列设备。多台在线时指定 `device`；已选择的设备会保留到后续调用，离线时返回实际设备列表，不转向另一台手机。

`phone_run` 的 `script` 是异步 JavaScript，绑定的是原生 Mobilewright 对象。先打开设置并观察：

```js
await device.launchApp('com.android.settings');
console.log(await snapshot());
await screenshot();
```

根据刚才的页面文字定位，操作后再取树：

```js
await screen.getByText('显示', { exact: true }).tap();
console.log(await snapshot());
```

支持原生 `getByText`、`getByLabel`、`getByTestId`、`getByPlaceholder`、`getByRole`，以及定位器的 `tap`、`fill`、`clear`、`check`、`scrollIntoViewIfNeeded` 和 `expect` 等等待能力。控件的文字、标签、resource-id 与角色取自实际页面，不猜控件一定有某个角色。中文／换行可直接传给 `.fill('你好\n第二行')`。

`snapshot()` 原样返回上游 `screen.viewTree()`，保留控件的 type、id／testId、label、text、value 等字段；`screenshot()` 返回可显示在 Kiki 中的 PNG。界面变化后重新取树：部分 ROM 在输入时会更换控件类名，旧类型定位器后续断言失败不表示输入没有发生，先读新快照，不自动重填。自绘或安全窗口可能缺少语义树／图像，root 不会自动补齐它们。

脚本可串联同一任务的步骤。默认整段期限为 90 秒，可用 `timeoutMs` 调整到最多 300 秒；取消或超时不回滚已经完成的动作。脚本以本机账号权限执行，不是沙箱。不要把用户密码写入文件；截图、树、控制台输出及工具参数会进入 Kiki 会话和所选模型的上下文。文件输出请用明确的绝对路径。

## 连接与高级工具

普通 Android 无需 root。USB 连接需手机开启开发者选项和 USB 调试、接受 RSA 授权。`android_connection` 的 `devices` 保留 `adb devices -l` 原始结果，便于查看 `unauthorized`／`offline`。

Android 11+ 无线调试先配对，再连接；两者端口不同：

```json
{ "action": "pair", "address": "192.168.1.8:37123", "code": "123456" }
{ "action": "connect", "address": "192.168.1.8:41755" }
```

已配对时直接连接。`disconnect` 需填写具体连接地址。不会调用 `kill-server`、`adb root` 或 `tcpip 5555`。

完整上游 `mobile_*` MCP 工具仍直接可用，包括设备发现、截图、UI 树、动作、文本、应用和录屏。`phone_run` 与这些工具操作同一台手机时按顺序执行；人工接管时暂停 Kiki 输入。避免同一设备同时运行 Appium／uiautomator2。云设备分配／登录须由用户另行提出并授权相关费用。

root 任务使用 `android_shell`，传 `android_connection devices` 返回的 ADB transport serial（可能不同于上游设备 id）：

```json
{ "serial": "YOUR_ADB_SERIAL", "argv": ["id"], "root": true }
```

`root=true` 执行 `su -c`，可能弹出 root 管理器授权；返回 `uid=0` 才说明该次命令取得 root。生产机 adbd 可以仍是 shell UID，不要求 `adb root`。私有文件和系统操作仍受 su、SELinux、解锁状态及任务授权限制，结果保留 stdout／stderr／退出状态。

## iOS 运行条件

调用 `phone_prepare({platform:"ios"})` 或 `node lib/prepare-cli.mjs --platform ios` 可安装上游运行包，不要求 Android ADB。然后用 `phone_run` 的 `platform:"ios"` 列设备和操作。

真机需要信任／配对、Developer Mode，以及为该设备有效签名的上游 DeviceKit agent；UI 树、触控和流媒体依赖它。按 [mobilecli 说明](https://github.com/mobile-next/mobilecli#agent-management-) 准备 provisioning profile 和签名资产，从源码构建需要 macOS/Xcode。用户要求安装后可运行：

```sh
npx --yes mobilecli@1.0.21 agent install --device <device-id> --provisioning-profile <absolute-profile-path>
```

本地 Simulator 需要 macOS、Xcode 及对应运行时。Windows 真机还依赖 Apple 设备服务及上游支持的开发服务／隧道与签名流程；按实际错误准备环境，不把设备发现等同于 UI 就绪。

## 命令行

Windows 准备入口也可在终端运行：

```bat
lib\start.cmd
lib\start.cmd --download
lib\start.cmd --adb "D:\Android SDK\platform-tools\adb.exe"
```

`node lib/prepare-cli.mjs --json` 输出完整准备报告；`--no-warmup` 只查 Node/npm/ADB，不安装上游包。

插件为 MIT；Mobile MCP／Mobilewright 为 Apache-2.0，mobilecli 为 FSL-1.1-ALv2，Google platform-tools 遵循其 SDK 条款，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
