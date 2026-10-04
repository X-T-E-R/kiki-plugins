# kiki-notion

Read specified Notion material into a cited local brief, then save it to an explicit page when requested. This Kiki-maintained package connects to Notion's hosted MCP service; it is not a Notion-certified integration and does not bundle a server or API client.

## Install and connect

From a Kiki conversation at the repository root, install the package and enable it:

```text
/plugins install --trust ./plugins/official/kiki-notion
/plugins enable kiki-notion
```

For a downloaded package, replace the source with its extracted directory.
`--trust` gives Kiki's existing first-source installation consent; it does not
authorize all later tool calls. The plugin is disabled on first install until
you enable it. No Node dependencies or plugin settings are required.

Then authorize the plugin's `notion` connection — runtime name
`plugin-kiki-notion:notion` — through the existing browser OAuth flow:

- In the GUI: **Capabilities → MCP**.
- In the TUI: `/mcp` lists connections, and
  `/kiki-ops help me log in to MCP plugin-kiki-notion:notion` walks you through
  the same authorization.

Never paste a token into chat, and do not add a token field to this plugin. If a
newly installed connection does not appear in a conversation that is already
open, use `/reload` or start a new conversation so its tools get discovered.

Authorization grants access within the selected workspace, bounded by your own
permissions and any restrictions your workspace administrators set on MCP
clients and tools. Search, AI/connected-source search, filters, and quotas all
depend on the connection and your Notion plan, not on this package. Installing
it never authorizes a subscription upgrade or a charge.

## Ask for the result

Use the `notion-workspace` skill with a page URL, a scope, and a concrete
question:

```text
/skill:notion-workspace Read the launch material under this Notion page: <page URL>. Save a brief with source links to launch-brief.md. Do not write to Notion.
```

To save it back, name the destination and the change you want:

```text
/skill:notion-workspace Read launch-brief.md and add its findings as a new section to this Notion page: <target URL>. Preserve the existing notes and read back the result.
```

Asking only for a summary never writes to Notion. A request with an explicit
destination needs no second plugin-specific confirmation — the normal Kiki tool
approvals still apply. The skill reads the original pages rather than trusting
search snippets, carries dropped-filter and missing-subtree notices into the
brief, and reports an async write as pending until it finishes and reads back.
If access fails partway, the local brief is still usable.

## Data handling

Content returned by Notion is sent to the model provider you selected and
saved in your Kiki session history and in the local files you ask for. The
plugin creates no index, token store, or background job of its own.

Uninstalling it does **not** delete those files or that history, and does not
revoke the OAuth grant. To cut off Notion's access, disconnect the connection
from the MCP management entry and revoke it under Notion **Settings →
Connections**.

## Testing status

Installation, tool discovery, and a scripted MCP round trip are covered by the
package tests. Real Notion account authorization and writes, and autonomous model
execution, are not. See [`NOTICE`](NOTICE) for the applicable
[Notion agreements](https://www.notion.so/terms). This package's MIT license
covers its own configuration and skill, not the remote service or your workspace
content.

## 中文

`kiki-notion` 把指定范围的 Notion 资料读成带来源的本地简报；你明确要求时，再写到指定页面并读回检查。它由 Kiki 维护，使用 Notion 官方托管 MCP，并非 Notion 认证或背书的集成，不自带 API client 或服务器。

在仓库根目录的 Kiki 对话里运行上面的安装与启用命令；下载包则把路径换成解压目录。首次来源信任沿现有 `--trust` 机制，新安装包需要启用。然后打开**能力 → MCP**，对 `plugin-kiki-notion:notion` 完成浏览器 OAuth 授权；TUI 可用上面的 `/kiki-ops` 指令接续现有认证。不要在对话里粘贴 token。若当前对话尚未发现新连接，用 `/reload` 或新对话加载工具。

请求中给出资料范围、问题与本地文件路径；要写回则给出目标页面 URL/ID 和追加或更新意图。只总结不会远端写入；明确目标的写回不增加插件专属重复确认，Kiki 原有工具审批照常。权限、套餐、过滤条件被忽略、正文截断或异步未完成都会影响覆盖说明，不会被包装成“已读全库”或“写回成功”。安装不授权升级套餐或付费。

读取的资料可能发送给你选用的模型供应商，并保存在 Kiki 对话历史和指定本地文件中。插件不建立独立索引、凭据库或调度器。卸载**不会**删除这些文件/历史，也不会撤销 OAuth；需在 MCP 管理入口断开，并按需在 Notion **设置 → 连接**撤销服务访问。

现已验证安装、发现和脚本控制的合成 MCP 往返；未用真实账号登录/写入，也未验证模型自主执行。服务与内容遵循 [`NOTICE`](NOTICE) 所列 Notion 条款，不属于插件 MIT 许可的范围。
