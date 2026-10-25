# Kiki Bilibili

用原生工具搜索 B 站视频和 UP 主、读字幕或转写、查看真实视频帧、回复评论、处理通知和私信，并上传投稿。插件适配 `bili-agent==1.0.0` 的生产命令，上传复用它的 `VideoUploader`，不另写上传协议。

## 安装与账号

需要 Python 3.10+；真实抽帧和 ASR 还需要 FFmpeg。先在你选择的目录安装隔离的 CLI，例如 Windows PowerShell：

```powershell
python -m venv .venv-bilibili
.venv-bilibili/Scripts/python.exe -m pip install "bili-agent==1.0.0"
```

在 Kiki 中安装插件：

```text
/plugins install --trust ./plugins/official/kiki-bilibili
/plugins enable kiki-bilibili
```

在插件设置中填写：

| 设置 | 值 |
| --- | --- |
| `biliCliPath` | 隔离环境中 `bili.exe` 的绝对路径；也可使用 PATH 中的 `bili` |
| `cliHome` | 你为此账号选择的绝对目录，保存扫码登录与 ASR 配置；必填 |
| `ffmpegDir` | 可留空；FFmpeg 不在 PATH 时填写其目录 |
| `timeoutMs` | 单次等待上限，默认 600000 毫秒；上传耗时较长时可调大 |

调用 `bilibili_account {"action":"login"}`，扫描返回的二维码，再调用 `{"action":"status"}` 完成登录。该配置目录由 CLI 自己管理；插件不导入浏览器或其他插件的凭据。`logout` 删除这个配置目录中的本地登录。

修改插件后，对同一源目录再次执行 `install`。工具随安装更新；附带 skill 需 `/reload` 或新会话。

## 从发现到视频理解

工具的完整名称以 `plugin__kiki_bilibili__` 开头。例如用 `bilibili_discover` 搜索视频：

```json
{"action":"search","keyword":"量子计算","order":"new","limit":10}
```

`users` 搜索 UP 主，`hot` 读取热搜，`recommend` 获取当前账号的推荐视频。`timeline` 读取关注动态，可用 `up` 选择特定 UP 主；继续翻页时，把返回的 `next_offset` 作为 `cursor` 传入。

把视频的 BV 号交给 `bilibili_watch`：

```json
{"action":"all","video":"BV1Q541167Qg","timestamps":[12.5,48]}
```

`all` 返回元数据、字幕和画面；没有字幕时转为 ASR。也可以分别选 `metadata`、`subtitle`、`transcribe` 或 `visual`。字幕与 ASR 均保留时间轴，来源分别为 `subtitle` 和 `asr`。

画面默认 `visual: "frames"`：FFmpeg 从视频流读取真实帧，结果保留 `time`（请求秒数）、`actual_time`、`path` 和 `source: "real-video-stream"`。模型支持图片时，工具同时返回图片 part。原件留在 workspace 的 `.kiki-bilibili/frames/capture-*/`，不同调用不会相互覆盖。`visual: "preview"` 则读取进度条缩略图，结果标为 `bilibili-preview-thumbnail`；它的 `actual_time` 可能与请求时间不同。

ASR 默认本地引擎。先用同一个 `BILI_CLI_HOME` 配置 CLI 的 `bili asr setup local`；该命令会下载模型并安装依赖，请在隔离环境中运行。若已配置云端服务，可显式选择 `engine: "cloud"` 或 `"auto"`，费用由该服务决定。`maxMinutes` 默认 60，长视频可自行调大。用 `bilibili_account {"action":"asr_status"}` 检查模型与依赖。

## 评论、互动和收件箱

`bilibili_interact` 用 `comments` 读评论、`replies` 读楼中楼，支持发评论、回复、@、点赞和收藏。写操作直接执行一次。例如回复并真正 @ 对方：

```json
{"action":"reply","video":"BV1Q541167Qg","commentId":123,"text":"谢谢补充！","mentions":["456"]}
```

`mentions` 接受 UID 或完整昵称，CLI 查询当前昵称并发送平台的 mention 映射。回复楼中楼时再传根评论的 `rootId`。点赞评论时传 `commentId`，点赞视频时省略；收藏可传 `folder` 的名称或 ID。`undo: true` 取消赞或收藏。

`resourceType` 默认为 `video`；评论动态、图文或专栏时分别用 `dynamic`、`draw`、`article`，并在 `video` 字段填该评论区的数字 oid。`check` 检查当前登录账号的评论列表：根评论最多查最新 3 页，楼中楼最多 2 页。它返回 `found`、折叠和隐藏状态及 `inspection` 范围；查不到可能是翻页范围、审核或删除，不能据此判断其他账号是否看得到。

`bilibili_inbox` 用 `notifications` 只读未读数；`inbox` 一次读取新回复、@、赞、系统通知和未读私信，**同时会把通知标已读**，每类默认取 5 条、最多 20 条。单独读取可选 `replies`、`mentions`、`likes`、`system`；前三类用返回的 `next_cursor` 继续翻页。这些通知读取可能确认已读，结果保留 `read_effect`。只检查未读数量时选 `notifications`。

私信的 `list` 和 `read` 不标已读：

```json
{"action":"read","threadId":"456","limit":30}
```

`mark_read` 会读取消息，并确认最后一条返回消息的序号。是否确实标记由 CLI 的 `marked_read` 回执决定；没有消息时仍为 `false`。

## 投稿与恢复

`bilibili_publish` 一次上传并提交单 P 或多 P 视频，文件按数组顺序排列：

```json
{"action":"submit","files":["media/part1.mp4","media/part2.mp4"],"title":"作品标题","tags":["创作"],"description":"作品简介"}
```

视频、可选 `cover` 封面及其符号链接目标必须位于当前 workspace。不传封面时，CLI 用 FFmpeg 从视频提取。分区可传 `tid` 和 `zone`，省略时由 CLI 预测；默认勾选含 AI 生成内容声明，可用 `aiDeclare: false` 调整。`private: true` 设为仅自己可见；`schedule` 接受 ISO 时间，平台允许提前 2 小时至 15 天。

提交后用 `{"action":"status","bvid":"返回的BV号"}` 查看审核与平台实际保存的设置。若工具返回 `error.submission: "unknown"`，先去平台或查稿件确认结果，再决定是否重新操作。网络中断、本地取消或超时都可能留下已提交的操作；插件不自动重发。`accepted` 表示平台命令完成，作品仍可能处于审核中。

用 `bilibili_diagnose {}` 检查 CLI 版本和 ASR 依赖。缺命令时修正 `biliCliPath`；未登录或登录失效时用账号工具重新扫码。

## 来源与测试

实际运行依赖为 [kukemc/bili-cli](https://github.com/kukemc/bili-cli) 1.0.0，源码观察 `add0a05d8b9e114d380042f7b1472efc238d661d`。字幕、转写、抽帧、评论 mention、私信确认和多 P 上传均保留在该成熟 CLI 内。其它 donor 的取舍见 `NOTICE`。

```sh
node --test plugins/official/kiki-bilibili/test/bilibili.test.mjs
node plugins/official/kiki-bilibili/scripts/sync-manifest.mjs --check
npm run check -- kiki-bilibili
```

设置 `BILI_CONTRACT_PYTHON` 为安装了 `bili-agent==1.0.0` 的隔离 Python，可额外验证真实 CLI 参数解析。fixture 拒绝意外网络访问；账号登录、评论、私信标读和投稿的真实平台行为需在用户授权的账号上验收。
