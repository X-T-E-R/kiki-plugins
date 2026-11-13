# Upstream components

Kiki Phone invokes these published packages without copying or modifying their implementations. Preparation and the first compact MCP launch install them privately with npm. The explicit `--raw` launcher retains its fixed npx fallback. The plugin's MIT license does not replace upstream licenses.

| Component | Selected version | License | Source |
| --- | --- | --- | --- |
| `@mobilenext/mobile-mcp` | `1.0.13` | Apache-2.0 | https://github.com/mobile-next/mobile-mcp |
| `@modelcontextprotocol/sdk` | `1.27.1` | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `mobilewright` (Mobile MCP direct dependency) | `0.0.67` | Apache-2.0 | https://github.com/mobile-next/mobilewright |
| `mobilecli` and its platform-specific `@mobilenext/mobilecli-*` executables | `1.0.21` | FSL-1.1-ALv2 | https://github.com/mobile-next/mobilecli |

Published package metadata and installed package license files govern their respective components and transitive dependencies. mobilecli's Functional Source License includes use restrictions and a future Apache-2.0 license grant; consult its [full license](https://github.com/mobile-next/mobilecli/blob/main/LICENSE) for your use.

Android preparation reuses installed official SDK Platform-Tools, or downloads Google's Windows package after the user accepts Google's linked terms. No ADB or Apple executable is redistributed in this plugin.

## Referenced open-source UI layout & device workspace patterns

Portions of the aspect-ratio viewport fitting (`fitDeviceFrame`) and device workspace / control-rail interaction design in `lib/preview-service.mjs` and `panel.html` are adapted from **T3 Code** (`https://github.com/pingdotgg/t3code`), licensed under the MIT License:

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
