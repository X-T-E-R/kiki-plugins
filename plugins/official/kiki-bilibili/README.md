# Kiki Bilibili

用原生工具搜索 B 站视频和 UP 主、读字幕或本地转写、查看真实视频帧、管理多账号登录态、回复评论与私信，并运营投稿、动态和合集。运行前需安装 `bili-agent==1.0.0`。

## 安装与多账号配置

需要 Python 3.10+（推荐 Python 3.12 以使用 `sherpa-onnx` 本地语音转写）；真实抽帧和 ASR 还需要 FFmpeg。在隔离环境中安装 CLI 与本地转写依赖，例如 Windows：

```powershell
uv venv --python 3.12 .venv-bilibili
uv pip install --python .venv-bilibili/Scripts/python.exe "bili-agent==1.0.0" sherpa-onnx numpy
```

当 `biliCliPath` 指向虚拟环境中的 `bili` 可执行文件且同目录存在 Python 解释器时，插件会按每个配置目录常驻隔离的暖进程（复用 Python 导入、HTTP 连接池、60 秒视频元数据缓存与本地 ONNX 语音识别模型），各账号环境完全隔离。

在 Kiki 中安装插件：

```text
/plugins install --trust ./plugins/official/kiki-bilibili
/plugins enable kiki-bilibili
```

在插件设置中填写：

| 设置 | 值 |
| --- | --- |
| `biliCliPath` | 隔离环境中 `bili.exe` 的绝对路径；也可使用 PATH 中的 `bili` |
| `cliHome` | 默认账号的绝对配置目录，保存扫码登录与 ASR 配置；未设置 `profiles` 时必填 |
| `profiles` | 可选多账号映射（JSON 对象或逐行 `别名=绝对路径`），例如 `{"nia":"C:\\...\\bili-nia-home","main":"C:\\...\\bili-main-home"}` |
| `defaultProfile` | 可选默认账号别名（对应 `profiles` 中的键）；未传工具参数 `profile` 时优先使用，留空则回退到 `cliHome` |
| `ffmpegDir` | 可留空；FFmpeg 不在 PATH 时填写其目录 |
| `timeoutMs` | 单次等待上限，默认 600000 毫秒；接受 1000–2147483647 的整数，上传耗时较长时可调大。无效值会在启动前返回 `CONFIGURATION` |

所有工具均支持可选 `profile` 参数（如 `"nia"` 或 `"main"`），只接受已在设置中声明的账号别名或 `"default"`，不读取隐式目录或浏览器 Cookie。调用 `bilibili_account {"action":"profiles"}` 可一次查看全部已配置账号的登录状态；调用 `{"action":"login","profile":"main"}` 生成二维码，扫码后调用 `{"action":"status","profile":"main","waitSeconds":60}` 完成登录。`logout` 仅删除所选配置目录中的本地凭证。

在 `bilibili_interact`、`bilibili_inbox`、`bilibili_publish` 和 `bilibili_account` 中可传入 `expectedMid`（期望的登录 UID）：任何写操作发送前都会校验当前 profile 的登录 UID，未登录或 UID 不一致时立即返回 `ACCOUNT_MISMATCH`（`submission: "not_sent"`），防止误操作串号。

修改插件后，对同一源目录再次执行 `install`。工具随安装更新；附带 skill 需 `/reload` 或新会话。

## 发现、竞品调研与视频理解

工具完整名称以 `plugin__kiki_bilibili__` 开头。例如用 `bilibili_discover` 搜索视频或调研 UP 主：

```json
{"action":"search","keyword":"AI Agent","order":"views","limit":10}
```

- `users` 搜索 UP 主；`user_info`（传 `up` UID 或完整昵称）读取粉丝数、获赞数与认证资料；`user_videos`（支持 `order`: `new` / `views` / `favorites` 与 `keyword` 筛选）拉取该 UP 主的代表作和近期投稿。
- `hot` 读取热搜，`popular`、`weekly`、`precious`、`rank` 浏览全站与分区榜单，`recommend` 获取当前账号的推荐流，`timeline` 读取关注动态（用返回的 `next_offset` 作为 `cursor` 翻页）。传入 `unseen: true` 可跳过当前 profile 已看过的视频。

把视频的 BV 号交给 `bilibili_watch`：

```json
{"action":"digest","video":"BV1Q541167Qg","frames":9,"comments":5}
```

- `digest` 并发拉取元数据、官方 AI 总结、截断字幕（无字幕时自动走本地/云端 ASR）、章节、热评和 9 宫格预览拼图，并将视频记入已看列表。
- `all` 先获取元数据，再并发拉取带时间轴的字幕（无字幕回退 ASR）、高清视频帧和可选评论。也可以单独选择 `metadata`、`summary`、`chapters`、`danmaku`、`subtitle`、`transcribe` 或 `visual`。
- 画面默认 `visual: "frames"`：通过多 CDN 分片并发 FFmpeg 从视频流截取真实帧，结果保留 `time`、`actual_time`、`path` 和 `source: "real-video-stream"`，原件保存在 workspace 的 `.kiki-bilibili/frames/capture-*/`。`visual: "preview"` 则并发拉取进度条缩略图，标为 `bilibili-preview-thumbnail`。
- ASR 默认使用 `local` 引擎，可通过 `bilibili_account {"action":"asr_status"}` 或 `bilibili_diagnose {}` 检查模型就绪状态（`ready: true`）。

## 评论、互动和收件箱

`bilibili_interact` 用 `comments` 读评论（支持 `unreplied` 未回复与 `supporters` 充电/粉丝牌筛选）、`replies` 读楼中楼，支持发评论、回复、@、发送时间轴弹幕（`danmaku`）、点赞和收藏：

```json
{"action":"reply","video":"BV1Q541167Qg","commentId":123,"text":"谢谢补充！","mentions":["456"]}
```

回复楼中楼时再传根评论的 `rootId`；评论动态、图文或专栏时设置 `resourceType` 并在 `video` 填数字 oid。`check` 检查当前账号最新评论页（根评论最多 3 页、楼中楼最多 2 页），不能据此判断其他账号是否可见。

`bilibili_inbox` 用 `notifications` 只读未读数；`inbox` 一次读取新回复、@、赞、系统通知和未读私信并标已读。私信的 `list` 和 `read` 不标已读，`mark_read` 确认最后一条返回消息的序号。

## 创作中心、投稿、动态与合集

`bilibili_account` 提供账号创作数据与关注列表：
- `{"action":"stats","period":"week"}`：创作中心播放、访客、涨粉、播放端分布与同行对比（支持 `yesterday` / `week` / `month` / `3months`）。
- `{"action":"following"}`：读取当前账号关注列表。

`bilibili_publish` 覆盖投稿全流程与日常动态、合集管理：

```json
{"action":"submit","files":["media/part1.mp4"],"cover":"media/cover.png","title":"作品标题","tags":["AI","编程"],"description":"作品简介"}
```

- **稿件投递与维护**：`submit` 上传并提交单 P 或多 P 视频（支持 `cover`、`cover43`、`topic`、`season`、`dynamicText`、`schedule`、`noReprint`、`private`；默认开启 `aiDeclare`）；`edit` 修改已投稿件标题、简介、标签、封面、AI 声明或单 P 换源（`video`）；`status` 查看审核状态与实际生效配置；`list` 按状态（`all` / `published` / `reviewing` / `rejected`）列出稿件；`stats` 查看单稿件每百次播放互动率与完播率；`zones` 查看可用分区。
- **分段章节**：`chapters_show`、`chapters_set`（传入 `"00:00 开场"` 格式数组）、`chapters_clear`。
- **动态与投票**：`dynamic_post`（支持最多 9 张 workspace 本地图片、`mentions` 与投票 `voteTitle`/`voteOptions`）、`dynamic_list`、`dynamic_delete`、`dynamic_vote`。
- **视频合集**：`season_list`、`season_create`、`season_add`。

所有上传媒体及符号链接目标必须位于当前 workspace。若写操作返回 `error.submission: "unknown"`，请先通过 `status`、`list` 或 `dynamic_list` 核实平台实际状态，插件绝不自动重发结果未知的写请求。
