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
