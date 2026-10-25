# Kiki QQ

`kiki-qq` 把官方 QQ Bot（私聊 C2C、群聊）和 OneBot 11 接到 Kiki 的公开 `PluginImAdapter`。插件管理平台连接和消息传输；Host 管理账号绑定、权限、群历史、会话、去重和 SendMessage 路由。

## 配置账号

每个适配器代表一个配置账号，Host 中的渠道名分别为 `plugin:kiki-qq/qq-official` 和 `plugin:kiki-qq/qq-onebot`。

- **官方 QQ Bot**：填写 `official__appId`、`official__appSecret`，使用已获准群/C2C 消息权限的机器人应用。`official__intents` 默认 `100663296`，订阅群/C2C 消息和交互。API 默认 `https://api.sgroup.qq.com`，令牌默认 `https://bots.qq.com`；修改地址会把令牌或 AppSecret 发往新地址。
- **OneBot 11**：填写已有实现的 `onebot__wsUrl`，必须是同时提供事件和 API 动作的**正向通用 WebSocket**。`onebot__accessToken` 用于 HTTP 和 WS 的 Bearer 认证。启动和每次重连都调用 `get_login_info` 核实账号；可填写 `onebot__selfId` 锁定预期数字账号，返回不匹配时关闭连接。新连接核实完成前，业务动作返回未发送，不会排队迁移到另一账号。
- **群读取工具**：渠道运行时直接复用已核实的 WS 连接，无需另配 HTTP 地址。未启动渠道时，工具使用 `onebot__baseUrl`（默认 `http://127.0.0.1:5700`）独立读取：每次先核实 HTTP 登录账号，再读列表；可用 `onebot__selfId` 预先锁定账号。

在 Host 的 IM 配置中选择对应渠道并启动。OneBot 反向 WS、HTTP 事件轮询和 QQ 客户端安装/登录由外部实现负责，本插件不会创建本地 listener。迁移已有内置 OneBot 账号时，当前集成候选需先停止旧入口；Host 的跨内置/插件入口监听占用互斥仍待发布物集成验证。

### 当前接入状态

`entry.mjs` 使用公开 `registerImAdapter(definition, adapter)` 注册 `qq-official` 和 `qq-onebot`。两种 definition 分别声明同名 `listenerRealm`；start 保留带平台前缀的持久 `accountId`，另返回裸真实账号 `listenerAccountId`，供 Host 区分监听来源与绑定账号。支持版 Node 的稳定源码 RPC fixture 已覆盖两平台注册、收发、停止和 shutdown exit 0。

manifest 的 `x-kiki.imAdapters` 与 entry 的两个完整 definition 逐字段同步。安装时需使用支持该公开 IM adapter 合同的 Host；SDK 仅用于插件仓库的开发和校验。

## 能力与回执

| 操作 | 官方 QQ Bot（群/C2C） | OneBot 11 |
| --- | --- | --- |
| 私聊、群聊文本 | 支持，使用对应 OpenID 目标 | 支持，使用数字 user_id/group_id |
| 接收 @ | 保留 `mentioned` 和 OpenID 列表 | 保留 `mentioned`、数字 ID 和 `all` |
| 发送 @ | `unsupported`，不丢弃 @ 后发送正文 | 群目标支持数字 ID / `all`；私聊返回 `unsupported` |
| 引用消息 | 解析引用索引并关联真实 ID；出站使用 `message_reference` | 入站保留引用 ID；出站使用 `reply` 段 |
| 图片 | PNG / JPEG / GIF | PNG / JPEG / WebP / GIF |
| 语音、音频 | WAV / MP3 / SILK / AMR；上传类型 3 | WAV / MP3 / OGG / SILK / AMR；发送为 `record` 段 |
| 视频 | MP4；上传类型 2 后发送媒体消息 | MP4；发送为 `video` 段 |
| 普通文件 | 上传类型 4 | `unsupported`；标准 OneBot 11 无通用 file 段 |
| 按钮、交互回调 | 支持键盘按钮和回调确认，仍受应用平台权限约束 | `unsupported` |
| 群列表、成员列表 | `unsupported`；群/C2C API 无这两类列表接口 | 固定只读 API，返回完整列表 |
| 编辑、独立 topic 定向发送 | `unsupported` | `unsupported` |

媒体大小由 `lib/definitions.mjs` 声明：图片与语音/音频最多 20 MiB，视频 30 MiB，官方普通文件 100 MiB。官方小于 5 MiB 的数据使用单次上传，达到 5 MiB 时使用 SDK 分块协议：prepare、COS PUT、part finish、complete，然后才发送媒体消息。上传失败或取消不会发送消息；分块上传的重试只处理上传阶段，不重试消息发送。平台若拒绝格式、权限或配额，按实际响应返回失败。音频和语音走平台同一语音通道，不提供音乐播放器卡片或本地转码。

入站保留当前消息的每个媒体附件，单附件上限 8 MiB。只下载无凭据的公开 HTTP(S) 地址，DNS 解析后检查并固定地址，不跟随重定向；内网地址、平台本地文件路径和缺失 URL 不会读取，Host 收到带预览原因的事件。官方原生 `content_type="voice"` 和 `.amr` 归为音频，保留下载字节；`asr_refer_text` 标为参考文本，不调用 ASR。TTS 由独立 Voice/kiki-media 生成，再经 Host 的媒体发送路径交给此插件。

- `delivered`：平台返回有效的协议消息 ID。
- `failed`：明确拒绝、上传失败或发送前取消；修复参数、权限或连接后再决定发送。HTTP 429 返回 `errorKind="rate_limited"`；`Retry-After` 对应的等待在 0～60000 毫秒内时，返回整数 `retryAfterMs` 供 Host 调度。更长或非法的等待保留在 detail 中，不提供自动重试字段。
- `unsupported`：请求能力不受支持，发送前结束，不降级到另一身份/群/私聊。
- `unknown`：发送后超时、断线、取消，或成功响应缺少有效消息 ID。先核对平台，插件不会自动重发。
- `partial`：文本分片已有真实成功 ID，后续片失败或结果未知。回执保留已成功 ID，停止余下分片。

### 身份、源消息与引用

官方 `official:group:<groupOpenid>` / `official:c2c:<userOpenid>` 和 OneBot `onebot:group:<group_id>` / `onebot:private:<user_id>` 是独立身份域。群地址、发言者和 topic 分开保留；同群两位发言者共享群地址，senderId 各自不同。入站附带独立 topic 时保留该身份，出站因两种协议均无标准 topic 定向接口而返回 `unsupported`，不会误发到整个群。

`sourceMessageId` 是本次收到的源 ID；`replyToMessageId` 是引用的真实消息 ID。官方 `message_scene.ext` / `message_type=103` 中的引用索引按客户端、聊天和 topic 关联近期真实 ID；尚未见过的引用对象保留索引与引用内容预览，`replyToMessageId` 留空。被引用的附件只列在引用预览中，不下载为当前发言者的新附件。发送响应中的 `ext_info.ref_idx` 也只参与关联，不能单独证明消息已投递。

官方客户端为每个目标保存近期源消息/交互作为**被动回复上下文**：普通消息使用 `msg_id`，交互使用 `event_id`，引用另外放在 `message_reference`。它按来源限额和群 5 分钟/私聊 30 分钟窗口选择上下文；没有可用上下文时发起主动消息，由 QQ 平台返回实际权限/配额结果。引用索引、引用 ID、出站 messageId 和上传 file_uuid 都不会补作被动回复源。

## 读取群数据

- `plugin__kiki_qq__qq_list_groups`：读取已配置 OneBot 账号的群列表，无参数。
- `plugin__kiki_qq__qq_list_group_members`：读取某群成员，参数示例：`{"groupId":"100001"}`。

结果包含完整 `items`、`nextCursor: null`、实际核实的 `accountId` 和使用的 `transport`。运行中的渠道使用 `websocket`；停止后使用 `http`，同一配置仍以渠道已核实的真实账号为准，HTTP 账号不符时在读取列表前终止。独立使用工具且省略 selfId 时，配置不变期间首次核实的 HTTP 账号固定到当前插件进程。工具只允许这两个固定动作，不接受平台选择、任意 endpoint 或 shell。官方 OpenID 不能传给数字 `groupId`。

## 本地验证

从插件仓库根运行平台测试：

```sh
node --test --test-timeout=15000 plugins/official/kiki-qq/test/qq.test.mjs plugins/official/kiki-qq/test/qq-regressions.test.mjs
node plugins/official/kiki-qq/scripts/sync-manifest.mjs --check
```

HTTP fixture 拒绝任何未列出的完整 URL/方法。官方 Gateway 和 OneBot 的连接测试使用 vendored 连接器与测试自己创建的回环 WS 服务，覆盖登录身份、重连核实窗口、真实引用形态、附件归属、分块选路、失败/unknown/partial、取消和 stop 释放。COS 上传由测试注入的传输验证 URL、实际分块字节与取消信号；测试不使用真实账号或向外网发送数据。

给定公开 SDK IM 模块和同版本 Host runner，可验证真实插件 RPC 注册、两种渠道的 start→event→send→stop 和 shutdown：

```sh
node plugins/official/kiki-qq/scripts/check-host-contract.mjs <sdk-im-module> <hostRunner.mjs>
```

该脚本只连接自己创建的回环 HTTP/WS fixture，精确断言持久账号与裸 listenerAccountId，以及 shutdown exit 0。使用 Host 支持的 Node 版本；正式安装与跨入口互斥需在发布物上验证。

## 复用来源

- `vendor/qqbot-gateway/`：`@tencent-connect/qqbot-nodejs 1.0.5` 的 GatewayConnection、codec、constants、errors、event-dispatcher、reconnect 六个协议模块。保留官方心跳、IDENTIFY/RESUME、重连和取消生命周期；仅将 WS import 指向 vendored `ws 8.21.0`。
- `vendor/qqbot-media/`：同一 SDK 的完整 buffer 分块上传协议与直属 retry、routes、types、format 单元，接入现有客户端令牌、HTTP 和取消链；不读取本地路径，不另建凭据缓存。`lib/official-references.mjs` 适配其 `quote-ref` 的有界引用索引关联。
- `lib/onebot-transport.mjs` 与公共媒体地址策略：适配 `@nb-im/core 0.3.0` 的 `connect/linkFrom` 和公共地址检查，补齐早到帧、监听清理、固定 DNS 与有界负载。
- `lib/reply-context.mjs`：适配 `tencent-connect/dsh-qqbot@c8b9158b37817b0dbc1e514e62e16204ad47a6ce` 的消息上下文缓存/限额；缓存按客户端实例隔离，不导入 DSH Agent/session。
- OneBot 11 协议依据 `botuniverse/onebot-11@d4456ee706f9ada9c2dfde56a2bcfc69752600e4`。NapCat `3420f0b76d7dc0ac92cde1663f21ea27f61e13bb`、LuckyLillia `dc2b2b90092ef0f571b5546878288b83fff1e436` 是外部兼容实现参照；本插件不携带 NTQQ、签名或 QQ 客户端实现。

许可证与改编范围见 `NOTICE` 及各 vendor 目录的 `LICENSE`。
