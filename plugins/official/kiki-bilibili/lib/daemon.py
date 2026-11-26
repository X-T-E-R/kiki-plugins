"""Persistent warm worker for kiki-bilibili (bili-agent==1.0.0).

Dedicated to a single (python, BILI_CLI_HOME, ffmpegDir) tuple so profile state
is isolated at the OS process boundary while Python imports, TLS pools, WBI keys,
metadata caches, and local ONNX ASR models stay warm across tool calls.
"""

from __future__ import annotations

import asyncio
import bisect
import contextvars
import importlib
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

# Isolate OS fd 1 immediately so no third-party Python print or C++ library
# (onnxruntime / curl_cffi) can ever write stray bytes onto the JSON-RPC pipe.
_IPC_FD = os.dup(1)
_DEVNULL_FD = os.open(os.devnull, os.O_WRONLY)
os.dup2(_DEVNULL_FD, 1)
os.close(_DEVNULL_FD)
_IPC_OUT = os.fdopen(_IPC_FD, "wb", buffering=0)
_IPC_IN = sys.stdin.buffer
_IPC_WRITE_LOCK = threading.Lock()


class _NullBuffer(io.RawIOBase):
    def writable(self) -> bool:
        return True

    def write(self, b: Any) -> int:
        return len(b)


class _NullTextIO(io.TextIOWrapper):
    def __init__(self) -> None:
        super().__init__(io.BufferedWriter(_NullBuffer()), encoding="utf-8", write_through=True)

    def isatty(self) -> bool:
        return False


sys.stdout = _NullTextIO()
sys.stderr = _NullTextIO()

os.environ["BILI_CLI_NO_RATE_LIMIT"] = "1"
os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def _send_ipc(payload: dict[str, Any]) -> None:
    line = (json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str) + "\n").encode("utf-8")
    with _IPC_WRITE_LOCK:
        try:
            _IPC_OUT.write(line)
        except OSError:
            os._exit(0)


try:
    import httpx
    import typer
    from bilibili_api import comment as bili_comment
    from bilibili_api import creative_center as bili_cc
    from bilibili_api import user as bili_user
    from bilibili_api import video as bili_video
    from PIL import Image

    import bili_cli
    from bili_cli import cards, config, frames as fr, main as bili_main, output, runtime
    from bili_cli.asr import audio as asr_audio, engines as asr_engines, pipeline as asr_pipeline
    from bili_cli.asr import settings as asr_settings, setup as asr_setup
    from bili_cli.commands import (
        asr as cmd_asr,
        auth as cmd_auth,
        autoreply as cmd_autoreply,
        comment as cmd_comment,
        danmaku as cmd_danmaku,
        dm as cmd_dm,
        dm_watch as cmd_dm_watch,
        dynamic as cmd_dynamic,
        feed as cmd_feed,
        hot as cmd_hot,
        mcp as cmd_mcp,
        me as cmd_me,
        owner as cmd_owner,
        search as cmd_search,
        season as cmd_season,
        skills as cmd_skills,
        upload as cmd_upload,
        user as cmd_user,
        video as cmd_video,
    )
    from bili_cli.errors import BiliError, from_exception

    try:
        from typer._click.exceptions import UsageError
    except ImportError:
        from click.exceptions import UsageError
except BaseException as _boot_exc:  # pragma: no cover
    _send_ipc({"type": "init_error", "message": f"{type(_boot_exc).__name__}: {_boot_exc}"})
    sys.exit(1)


# Patch runtime.run across all Typer command modules so Click/Typer option parsing
# captures the async command coroutine instead of calling nested asyncio.run().
_ORIG_RUN = runtime.run
_CAPTURE_BOX: contextvars.ContextVar[list[Any] | None] = contextvars.ContextVar("_CAPTURE_BOX", default=None)


def _captured_run(coro_fn: Any) -> None:
    box = _CAPTURE_BOX.get()
    if box is not None:
        box.append(coro_fn)
        return
    _ORIG_RUN(coro_fn)


for _mod in (
    runtime,
    bili_main,
    cmd_asr,
    cmd_auth,
    cmd_autoreply,
    cmd_comment,
    cmd_danmaku,
    cmd_dm,
    cmd_dm_watch,
    cmd_dynamic,
    cmd_feed,
    cmd_hot,
    cmd_mcp,
    cmd_me,
    cmd_owner,
    cmd_search,
    cmd_season,
    cmd_skills,
    cmd_upload,
    cmd_user,
    cmd_video,
):
    if hasattr(_mod, "run"):
        _mod.run = _captured_run

_CLICK_GROUP = typer.main.get_command(bili_main.app)


# ------------------------------------------------------------------ Caches & Pools

INFO_TTL_SECONDS = 60.0
INFO_MAX_ENTRIES = 128
GPU_TTL_SECONDS = 300.0
HD_STRIPE_CONCURRENCY = 3

_INFO_CACHE: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
_INFO_INFLIGHT: dict[tuple[str, str], asyncio.Future[dict[str, Any]]] = {}

_GPU_CACHE: tuple[float, dict[str, Any] | None] | None = None
_GPU_INFLIGHT: asyncio.Future[dict[str, Any] | None] | None = None

_IMPORTABLE_CACHE: dict[str, bool] = {}
_ASR_ENGINE_CACHE: dict[tuple[int, str], asr_engines.Engine] = {}
_HTTPX_POOL: dict[tuple[str, str], httpx.AsyncClient] = {}

_ORIG_BUILD_ASR = asr_engines.build


def _asr_mtime_ns() -> int:
    p = asr_settings.path()
    try:
        return p.stat().st_mtime_ns
    except OSError:
        return 0


def _cached_build_asr(which: str = "auto") -> asr_engines.Engine:
    conf = asr_settings.load()
    resolved = which
    if resolved == "auto":
        resolved = conf.get("default") or ("cloud" if conf.get("cloud") else "local" if conf.get("local") else "")
    cfg_part = conf.get(resolved) if resolved in ("local", "cloud") else None
    key = (_asr_mtime_ns(), f"{resolved}:{json.dumps(cfg_part, sort_keys=True, ensure_ascii=False)}")
    cached = _ASR_ENGINE_CACHE.get(key)
    if cached is not None:
        return cached
    eng = _ORIG_BUILD_ASR(which)
    if len(_ASR_ENGINE_CACHE) >= 8:
        _ASR_ENGINE_CACHE.pop(next(iter(_ASR_ENGINE_CACHE)))
    _ASR_ENGINE_CACHE[key] = eng
    return eng


asr_engines.build = _cached_build_asr


def _cached_importable(module_name: str) -> bool:
    if module_name in _IMPORTABLE_CACHE:
        return _IMPORTABLE_CACHE[module_name]
    ok = asr_setup._importable(module_name)
    _IMPORTABLE_CACHE[module_name] = ok
    return ok


async def _get_gpu_cached() -> dict[str, Any] | None:
    global _GPU_CACHE, _GPU_INFLIGHT
    now = time.monotonic()
    if _GPU_CACHE is not None and (now - _GPU_CACHE[0]) < GPU_TTL_SECONDS:
        return _GPU_CACHE[1]
    if _GPU_INFLIGHT is not None:
        return await asyncio.shield(_GPU_INFLIGHT)
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[dict[str, Any] | None] = loop.create_future()
    _GPU_INFLIGHT = fut
    try:
        res = await asyncio.to_thread(asr_setup.detect_gpu)
        _GPU_CACHE = (time.monotonic(), res)
        fut.set_result(res)
        return res
    except BaseException as exc:
        if not fut.done():
            fut.set_exception(exc)
        raise
    finally:
        _GPU_INFLIGHT = None


def _cred_key(cred: Any) -> str:
    if cred is None or not getattr(cred, "sessdata", None):
        return "anon"
    return f"{getattr(cred, 'dedeuserid', '')}:{cred.sessdata[:16]}"


def _get_http_client(cred: Any = None, referer: str | None = None) -> httpx.AsyncClient:
    eff_referer = referer or runtime.WEB_HEADERS["Referer"]
    key = (_cred_key(cred), eff_referer)
    client = _HTTPX_POOL.get(key)
    if client is not None and not client.is_closed:
        return client
    headers = dict(runtime.WEB_HEADERS)
    headers["Referer"] = eff_referer
    cookies: dict[str, str] = {}
    if cred is not None:
        cookies = {
            k: v
            for k, v in {
                "SESSDATA": cred.sessdata,
                "bili_jct": cred.bili_jct,
                "DedeUserID": cred.dedeuserid,
                "buvid3": cred.buvid3,
                "buvid4": cred.buvid4,
            }.items()
            if v
        }
    client = httpx.AsyncClient(
        headers=headers,
        cookies=cookies,
        timeout=20.0,
        follow_redirects=True,
        limits=httpx.Limits(max_keepalive_connections=16, max_connections=32),
    )
    if len(_HTTPX_POOL) >= 8:
        oldest_key = next(iter(_HTTPX_POOL))
        old_client = _HTTPX_POOL.pop(oldest_key)
        asyncio.create_task(old_client.aclose())
    _HTTPX_POOL[key] = client
    return client


def _clear_mutable_caches() -> None:
    _INFO_CACHE.clear()


def _put_info_cache(cred_k: str, info: dict[str, Any]) -> None:
    now = time.monotonic()
    while len(_INFO_CACHE) >= INFO_MAX_ENTRIES:
        _INFO_CACHE.pop(next(iter(_INFO_CACHE)))
    bvid = info.get("bvid")
    aid = info.get("aid")
    if bvid:
        _INFO_CACHE[(str(bvid), cred_k)] = (now, info)
    if aid is not None:
        _INFO_CACHE[(f"aid:{aid}", cred_k)] = (now, info)


async def _get_video_and_info(video_id: str) -> tuple[bili_video.Video, dict[str, Any]]:
    ids = runtime.parse_video_id(video_id)
    cred = config.optional_credential()
    ck = _cred_key(cred)
    lookup_key = (str(ids["bvid"]) if "bvid" in ids else f"aid:{ids['aid']}", ck)
    v = bili_video.Video(**ids, credential=cred)

    now = time.monotonic()
    hit = _INFO_CACHE.get(lookup_key)
    if hit is not None and (now - hit[0]) < INFO_TTL_SECONDS:
        return v, hit[1]

    inflight = _INFO_INFLIGHT.get(lookup_key)
    if inflight is not None:
        info = await asyncio.shield(inflight)
        return v, info

    loop = asyncio.get_running_loop()
    fut: asyncio.Future[dict[str, Any]] = loop.create_future()
    _INFO_INFLIGHT[lookup_key] = fut
    try:
        info = await v.get_info()
        _put_info_cache(ck, info)
        _INFO_CACHE[lookup_key] = (time.monotonic(), info)
        fut.set_result(info)
        return v, info
    except BaseException as exc:
        if not fut.done():
            fut.set_exception(exc)
        raise
    finally:
        _INFO_INFLIGHT.pop(lookup_key, None)


class _AsyncRWGate:
    """Allows unlimited concurrent read coroutines; serializes write coroutines exclusively."""

    def __init__(self) -> None:
        self._cond = asyncio.Condition()
        self._readers = 0
        self._writer = False
        self._waiting_writers = 0

    async def acquire_read(self) -> None:
        async with self._cond:
            while self._writer or self._waiting_writers > 0:
                await self._cond.wait()
            self._readers += 1

    async def release_read(self) -> None:
        async with self._cond:
            self._readers -= 1
            if self._readers == 0:
                self._cond.notify_all()

    async def acquire_write(self) -> None:
        async with self._cond:
            self._waiting_writers += 1
            try:
                while self._writer or self._readers > 0:
                    await self._cond.wait()
                self._writer = True
            finally:
                self._waiting_writers -= 1

    async def release_write(self) -> None:
        async with self._cond:
            self._writer = False
            self._cond.notify_all()


_GATE = _AsyncRWGate()


# ------------------------------------------------------------------ Fast Native Handlers


async def _fast_asr_status() -> dict[str, Any]:
    conf = asr_settings.load()
    local = conf.get("local") or {}
    ffmpeg_ok = shutil.which("ffmpeg") is not None
    checks: dict[str, bool] = {
        "ffmpeg": ffmpeg_ok,
        "sherpa_onnx": _cached_importable("sherpa_onnx"),
        "vad_model": bool(conf.get("vad_model") and Path(conf["vad_model"]).exists()),
    }
    if local.get("device") == "cuda":
        checks["qwen_asr"] = _cached_importable("qwen_asr")
    elif local:
        checks["model_files"] = Path(local["model_dir"]).exists()
    default = conf.get("default") or ("cloud" if conf.get("cloud") else "local" if local else None)
    gpu = await _get_gpu_cached()
    local_ready = True
    if default == "local":
        if local.get("device") == "cuda":
            local_ready = bool(checks.get("qwen_asr"))
        else:
            local_ready = bool(checks.get("sherpa_onnx") and checks.get("model_files"))
    return {
        "default": default,
        "cloud": asr_settings.masked(conf.get("cloud") or {}) or None,
        "local": local or None,
        "gpu": gpu,
        "checks": checks,
        "ready": bool(default) and checks["ffmpeg"] and local_ready,
    }


async def _grab_preview_parallel(snapshot: dict[str, Any], times: list[float], out_dir: Path) -> list[dict[str, Any]]:
    index: list[int] = snapshot.get("index") or []
    images: list[str] = snapshot.get("image") or []
    cols, rows = snapshot.get("img_x_len") or 10, snapshot.get("img_y_len") or 10
    w, h = snapshot.get("img_x_size"), snapshot.get("img_y_size")
    if not index or not images or not w or not h:
        raise BiliError("not_found", "该视频没有预览缩略图。", hint="改用 --quality hd（需要 ffmpeg）。")
    per_sheet = cols * rows
    count = min(len(index), len(images) * per_sheet)

    picks: list[tuple[float, int, int, int]] = []
    needed_sheets: set[int] = set()
    for t in times:
        k = max(0, min(bisect.bisect_right(index, t) - 1, count - 1))
        sheet_no, pos = divmod(k, per_sheet)
        picks.append((t, k, sheet_no, pos))
        needed_sheets.add(sheet_no)

    client = _get_http_client()

    async def fetch_sheet(sheet_no: int) -> tuple[int, Image.Image]:
        url = images[sheet_no]
        full_url = "https:" + url if url.startswith("//") else url
        resp = await client.get(full_url)
        resp.raise_for_status()
        img = await asyncio.to_thread(lambda raw=resp.content: Image.open(io.BytesIO(raw)).convert("RGB"))
        return sheet_no, img

    fetched = await asyncio.gather(*(fetch_sheet(sn) for sn in sorted(needed_sheets)))
    sheets = dict(fetched)

    def crop_all() -> list[dict[str, Any]]:
        out_items: list[dict[str, Any]] = []
        for t, k, sheet_no, pos in picks:
            x, y = (pos % cols) * w, (pos // cols) * h
            dest = out_dir / fr.frame_name(t)
            sheets[sheet_no].crop((x, y, x + w, y + h)).save(dest, quality=90)
            out_items.append({"time": t, "actual_time": index[k], "path": str(dest)})
        return out_items

    return await asyncio.to_thread(crop_all)


async def _grab_hd_striped(playurl: dict[str, Any], times: list[float], out_dir: Path) -> list[dict[str, Any]]:
    if not shutil.which("ffmpeg"):
        raise BiliError("invalid_argument", "--quality hd 需要 ffmpeg。", hint="安装 ffmpeg，或改用 --quality preview。")
    stream = fr.pick_stream(playurl)
    raw_urls = [stream.get("baseUrl") or stream.get("base_url")] + list(stream.get("backupUrl") or stream.get("backup_url") or [])
    urls = sorted([u for u in raw_urls if u], key=lambda u: "mcdn" in u)
    if not urls:
        raise BiliError("not_found", "没有可用的视频流。", hint="改用 --quality preview。")
    headers = "".join(f"{k}: {v}\r\n" for k, v in runtime.WEB_HEADERS.items())
    sem = asyncio.Semaphore(HD_STRIPE_CONCURRENCY)

    async def extract_one(idx: int, t: float) -> dict[str, Any]:
        dest = out_dir / fr.frame_name(t)
        err = b""
        async with sem:
            n_urls = len(urls)
            for attempt in range(n_urls):
                url = urls[(idx + attempt) % n_urls]
                probe_flags = ["-probesize", "1M", "-analyzeduration", "1M"] if attempt < n_urls - 1 or n_urls == 1 else []
                cmd = [
                    "ffmpeg",
                    "-nostdin",
                    "-y",
                    "-loglevel",
                    "error",
                    "-headers",
                    headers,
                    *probe_flags,
                    "-ss",
                    f"{t:.2f}",
                    "-i",
                    url,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    str(dest),
                ]
                try:
                    proc = await asyncio.to_thread(
                        subprocess.run,
                        cmd,
                        stdin=subprocess.DEVNULL,
                        capture_output=True,
                        timeout=fr.HD_FRAME_TIMEOUT,
                    )
                except subprocess.TimeoutExpired:
                    err = f"ffmpeg 超过 {fr.HD_FRAME_TIMEOUT} 秒未完成".encode()
                    continue
                err = proc.stderr
                if proc.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
                    return {"time": t, "actual_time": t, "path": str(dest)}
            raise BiliError("network_error", f"截取 {fr.fmt_time(t)} 的画面失败：{err.decode(errors='ignore')[-200:]}")

    results = await asyncio.gather(*(extract_one(i, t) for i, t in enumerate(times)))
    return list(results)


def _split_opts_and_pos(args: list[str]) -> tuple[list[str], list[str]]:
    if "--" in args:
        idx = args.index("--")
        return args[:idx], args[idx + 1 :]
    return args, []


async def _fast_video_subtitle(video_id: str, page: int, lang: str | None, text_only: bool) -> dict[str, Any]:
    v, info = await _get_video_and_info(video_id)
    cid = cmd_video._pick_page(info, page)["cid"]
    subs = (await v.get_subtitle(cid=cid) or {}).get("subtitles") or []
    available = [{"lang": s.get("lan"), "name": s.get("lan_doc")} for s in subs]
    if not subs:
        hint = "该视频没有字幕。" if config.load_credential() else "未登录时通常拿不到 AI 字幕，可先 `bili auth login`。"
        raise BiliError("not_found", "没有可用字幕。", hint=hint, detail={"available": available})
    chosen = next((s for s in subs if s.get("lan") == lang), None) if lang else subs[0]
    if chosen is None:
        raise BiliError("not_found", f"没有语言为 {lang} 的字幕。", detail={"available": available})
    url = chosen.get("subtitle_url") or ""
    if url.startswith("//"):
        url = "https:" + url
    client = _get_http_client()
    resp = await client.get(url)
    resp.raise_for_status()
    body_items = resp.json().get("body") or []
    items = [{"from": i.get("from"), "to": i.get("to"), "content": i.get("content")} for i in body_items]
    result: dict[str, Any] = {
        "bvid": info.get("bvid"),
        "page": page,
        "lang": chosen.get("lan"),
        "available": available,
    }
    if text_only:
        result["text"] = "\n".join(i["content"] for i in items)
    else:
        result["items"] = items
    return result


async def _fast_video_watch(
    video_id: str,
    page: int,
    frames_n: int,
    comments_n: int,
    transcript: str,
    max_chars: int,
    record: bool,
) -> dict[str, Any]:
    if transcript not in ("auto", "subtitle", "none"):
        raise BiliError("invalid_argument", "--transcript 只能是 auto / subtitle / none。")
    if page < 1 or not (0 <= frames_n <= 30) or not (0 <= comments_n <= 20) or max_chars < 0:
        raise BiliError("invalid_argument", "watch 参数超出范围。")

    v, info = await _get_video_and_info(video_id)
    pg = cmd_video._pick_page(info, page)
    cid = pg["cid"]
    up_mid = (info.get("owner") or {}).get("mid")

    async def load_tags() -> list[Any]:
        return [t.get("tag_name") for t in await v.get_tags(cid=cid)][:12]

    async def load_ai_summary() -> str | None:
        try:
            ai = (await v.get_ai_conclusion(cid=cid, up_mid=up_mid)).get("model_result") or {}
            return ai.get("summary") or None
        except Exception:
            return None

    async def load_player_and_transcript() -> tuple[dict[str, Any], str, str | None]:
        player = await v.get_player_info(cid=cid)
        text, source = "", None
        if transcript != "none":
            subs = (player.get("subtitle") or {}).get("subtitles") or []
            if subs:
                url = subs[0].get("subtitle_url") or ""
                client = _get_http_client()
                resp = await client.get("https:" + url if url.startswith("//") else url)
                resp.raise_for_status()
                body_items = resp.json().get("body") or []
                text = "\n".join(i.get("content", "") for i in body_items)
                source = f"subtitle:{subs[0].get('lan')}"
            elif transcript == "auto":
                try:
                    eng = asr_engines.build("auto")
                except BiliError:
                    eng = None
                if eng is not None and (pg.get("duration") or 0) <= 60 * 60:
                    res = await asr_pipeline.transcribe(lambda: v.get_download_url(cid=cid), f"{info.get('bvid')}_p{page}", eng)
                    text = "\n".join(i["content"] for i in res["items"])
                    source = f"asr:{res['engine']}"
        return player, text, source

    async def load_comments() -> list[dict[str, Any]] | None:
        if not comments_n:
            return None
        data = await bili_comment.get_comments(
            info["aid"],
            bili_comment.CommentResourceType.VIDEO,
            order=bili_comment.OrderType.LIKE,
            credential=config.load_credential(),
        )
        return [
            {
                "user": (r.get("member") or {}).get("uname"),
                "content": (r.get("content") or {}).get("message"),
                "like": r.get("like"),
                "rpid": r.get("rpid"),
            }
            for r in (data.get("replies") or [])[:comments_n]
        ]

    async def load_frames_sheet() -> tuple[bool, str | None]:
        if not frames_n:
            return False, None
        times = fr.plan_times(float(pg.get("duration") or 0), count=frames_n)
        snap = await v.get_video_snapshot(cid=cid, json_index=True, pvideo=False)
        out_dir = config.home() / "frames" / f"{info.get('bvid')}_p{page}_preview"
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            items = await _grab_preview_parallel(snap, times, out_dir)
            sheet_path = await asyncio.to_thread(fr.contact_sheet, items, out_dir / "sheet.jpg")
            return True, str(sheet_path)
        except BiliError:
            return True, None

    tags, (player, text, source), ai_summary, hot_comments, (has_frames, frames_sheet) = await asyncio.gather(
        load_tags(),
        load_player_and_transcript(),
        load_ai_summary(),
        load_comments(),
        load_frames_sheet(),
    )

    result: dict[str, Any] = {"notice": cmd_video.WATCH_NOTICE, **cmd_video._summarize(info)}
    result["tags"] = tags
    result["chapters"] = [
        {"from": p.get("from"), "to": p.get("to"), "title": p.get("content")}
        for p in player.get("view_points") or []
    ]
    result["ai_summary"] = ai_summary

    if max_chars and len(text) > max_chars:
        full_len = len(text)
        text = text[:max_chars] + f"\n…（已截断，全文 {full_len} 字，用 `bili video subtitle` 或 `transcribe` 获取）"
    result["transcript"] = (
        {"source": source, "text": text}
        if source
        else {
            "source": None,
            "text": "",
            "hint": "没有字幕。配置转写引擎（`bili asr setup local`）后可自动转写；或用画面总览图理解内容。",
        }
    )

    if hot_comments is not None:
        result["hot_comments"] = hot_comments
    if has_frames:
        result["frames_sheet"] = frames_sheet

    if record:
        cred = config.require_credential()
        v.credential = cred
        await v.report_watch_history(progress=int(pg.get("duration") or 0), cid=cid)
        result["recorded_in_history"] = True
    cards.mark_seen(info.get("bvid"))
    result["next"] = "想发表看法：`bili comment post <BV> \"…\"`；想告诉主人：`bili comment post <BV> \"…\" --at owner` 或 `bili dm send owner \"…\"`。"
    return result


async def _fast_video_frames(
    video_id: str,
    page: int,
    count: int | None,
    every: float | None,
    at: list[str],
    by_chapter: bool,
    quality: str,
    sheet: bool,
    out: Path | None,
) -> dict[str, Any]:
    modes = sum(bool(x) for x in (count, every, at, by_chapter))
    if modes > 1:
        raise BiliError("invalid_argument", "--count / --every / --at / --chapters 只能选一种。")
    if quality not in ("preview", "hd"):
        raise BiliError("invalid_argument", "--quality 只能是 preview 或 hd。")

    v, info = await _get_video_and_info(video_id)
    pg = cmd_video._pick_page(info, page)
    duration = float(pg.get("duration") or 0)
    points = (await v.get_player_info(cid=pg["cid"])).get("view_points") or [] if by_chapter else []
    times = fr.plan_times(
        duration,
        count=count,
        every=every,
        at=[runtime.parse_seconds(a) for a in at] if at else None,
        chapter_starts=[p.get("from") or 0 for p in points] if by_chapter else None,
    )
    limit = fr.MAX_HD_FRAMES if quality == "hd" else fr.MAX_PREVIEW_FRAMES
    if len(times) > limit:
        raise BiliError("invalid_argument", f"{quality} 模式最多 {limit} 帧，当前会取 {len(times)} 帧。", hint="增大 --every 或减少 --count。")

    out_dir = (out or config.home() / "frames" / f"{info.get('bvid')}_p{page}_{quality}").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if quality == "preview":
        snap = await v.get_video_snapshot(cid=pg["cid"], json_index=True, pvideo=False)
        if not snap.get("image"):
            await asyncio.sleep(1)
            snap = await v.get_video_snapshot(cid=pg["cid"], json_index=True, pvideo=False)
        items = await _grab_preview_parallel(snap, times, out_dir)
    else:
        playurl = await v.get_download_url(cid=pg["cid"])
        items = await _grab_hd_striped(playurl, times, out_dir)

    titles = [(p.get("from") or 0, p.get("content")) for p in points]
    for it in items:
        it["time_str"] = fr.fmt_time(it["actual_time"])
        if titles:
            it["chapter"] = next((name for start, name in reversed(titles) if it["actual_time"] >= start), None)

    result: dict[str, Any] = {
        "bvid": info.get("bvid"),
        "page": page,
        "duration": duration,
        "quality": quality,
        "dir": str(out_dir),
        "frames": items,
    }
    if sheet and items:
        sheet_path = await asyncio.to_thread(fr.contact_sheet, items, out_dir / "sheet.jpg")
        result["sheet"] = str(sheet_path)
    return result


async def _fast_video_transcribe(
    video_id: str,
    page: int,
    engine: str,
    max_minutes: float,
    text_only: bool,
    hint: bool,
    no_cache: bool,
) -> dict[str, Any]:
    if engine not in ("auto", "local", "cloud"):
        raise BiliError("invalid_argument", "--engine 只能是 auto / local / cloud。")
    eng = asr_engines.build(engine)
    v, info = await _get_video_and_info(video_id)
    pg = cmd_video._pick_page(info, page)
    minutes = (pg.get("duration") or 0) / 60
    if minutes > max_minutes:
        raise BiliError(
            "invalid_argument",
            f"视频时长 {minutes:.0f} 分钟，超过 --max-minutes {max_minutes:.0f}。",
            hint="确认需要转写的话调大 --max-minutes。",
            detail={"minutes": round(minutes, 1)},
        )
    context = ""
    if hint:
        tags = [t.get("tag_name") for t in await v.get_tags(cid=pg["cid"])][:10]
        context = f"{info.get('title', '')} {' '.join(filter(None, tags))}".strip()
    res = await asr_pipeline.transcribe(
        lambda: v.get_download_url(cid=pg["cid"]),
        f"{info.get('bvid')}_p{page}",
        eng,
        context=context,
        use_cache=not no_cache,
    )
    out: dict[str, Any] = {"bvid": info.get("bvid"), "page": page, "duration": pg.get("duration"), **res}
    if text_only:
        out["text"] = "\n".join(i["content"] for i in out.pop("items"))
    try:
        if (await v.get_subtitle(cid=pg["cid"]) or {}).get("subtitles"):
            out["note"] = "该视频自带字幕，`bili video subtitle` 更快且免费。"
    except Exception:
        pass
    return out


async def _fast_me_stats(period: str) -> dict[str, Any]:
    if period not in cmd_me.STATS_PERIODS:
        raise BiliError("invalid_argument", f"--period 只能是 {' / '.join(cmd_me.STATS_PERIODS)} 之一。")
    cred = config.require_credential()
    p = cmd_me.STATS_PERIODS[period]
    overview, fans, source, compare, survey = await asyncio.gather(
        bili_cc.get_overview(cred, bili_cc.GraphPeriod(p)),
        bili_cc.get_fan_overview(cred, bili_cc.FanGraphPeriod(p)),
        bili_cc.get_video_source(cred),
        bili_cc.get_compare(cred),
        bili_cc.get_video_survey(cred),
    )
    return {"period": period, **cmd_me.summarize_stats(overview, fans, source, compare, survey), "per_video_with": "bili upload stats <BV>"}


async def _fast_user_info(who: str) -> dict[str, Any]:
    mid = await cmd_user.resolve_mid(who)
    u = bili_user.User(mid, credential=config.optional_credential())

    async def safe_up_stat() -> dict[str, Any]:
        try:
            return await u.get_up_stat()
        except Exception:
            return {}

    data, rel, up = await asyncio.gather(u.get_user_info(), u.get_relation_info(), safe_up_stat())
    official = data.get("official") or {}
    live = data.get("live_room") or {}
    out: dict[str, Any] = {
        "mid": data.get("mid"),
        "name": data.get("name"),
        "sign": data.get("sign") or None,
        "level": data.get("level"),
        "official": official.get("title") or None,
        "fans": rel.get("follower"),
        "following": rel.get("following"),
        "url": f"https://space.bilibili.com/{data.get('mid')}",
    }
    if up:
        out["total_views"] = (up.get("archive") or {}).get("view")
        out["total_likes"] = up.get("likes")
    if live.get("roomid"):
        out["live"] = {"live_now": live.get("liveStatus") == 1, "title": live.get("title"), "url": f"https://live.bilibili.com/{live.get('roomid')}"}
    out["videos_with"] = f"bili user videos {data.get('mid')}"
    return out


async def _try_fast_dispatch(clean_args: list[str], req_cwd: str | None) -> tuple[bool, Any]:
    """Match hot read-only command shapes; return (True, data) or (False, None) to fall back to Typer."""
    if not clean_args:
        return False, None
    # Never bypass Typer if global modifiers like --raw / --dry-run / --wait (global) are present
    opts_part, pos_part = _split_opts_and_pos(clean_args)
    if any(flag in opts_part for flag in ("--raw", "--dry-run")):
        return False, None

    if clean_args == ["--version"]:
        return True, {"version": bili_cli.__version__}
    if clean_args == ["asr", "status"]:
        return True, await _fast_asr_status()

    if len(clean_args) >= 3 and clean_args[0] == "video":
        sub = clean_args[1]
        sub_opts, sub_pos = _split_opts_and_pos(clean_args[2:])
        if sub == "info" and not sub_opts and len(sub_pos) == 1:
            _, info = await _get_video_and_info(sub_pos[0])
            return True, cmd_video._summarize(info)
        if sub == "stats" and not sub_opts and len(sub_pos) == 1:
            _, info = await _get_video_and_info(sub_pos[0])
            return True, {"bvid": info.get("bvid"), "title": info.get("title"), "stat": cmd_video._stat(info.get("stat") or {})}
        if sub == "chapters" and len(sub_pos) == 1:
            page = 1
            i = 0
            while i < len(sub_opts):
                if sub_opts[i] in ("--page", "-p") and i + 1 < len(sub_opts):
                    page = int(sub_opts[i + 1])
                    i += 2
                else:
                    return False, None
            if page < 1:
                return False, None
            v, info = await _get_video_and_info(sub_pos[0])
            cid = cmd_video._pick_page(info, page)["cid"]
            points = (await v.get_player_info(cid=cid)).get("view_points") or []
            return True, {
                "bvid": info.get("bvid"),
                "page": page,
                "chapters": [{"from": p.get("from"), "to": p.get("to"), "title": p.get("content")} for p in points],
            }
        if sub == "summary" and len(sub_pos) == 1:
            page = 1
            i = 0
            while i < len(sub_opts):
                if sub_opts[i] in ("--page", "-p") and i + 1 < len(sub_opts):
                    page = int(sub_opts[i + 1])
                    i += 2
                else:
                    return False, None
            if page < 1:
                return False, None
            v, info = await _get_video_and_info(sub_pos[0])
            cid = cmd_video._pick_page(info, page)["cid"]
            data = await v.get_ai_conclusion(cid=cid, up_mid=(info.get("owner") or {}).get("mid"))
            model = data.get("model_result") or {}
            if not model.get("summary"):
                raise BiliError("not_found", "该视频没有 AI 总结。", hint="可改用 `bili video subtitle --text` 自行总结。")
            return True, {
                "bvid": info.get("bvid"),
                "summary": model.get("summary"),
                "outline": [
                    {
                        "title": o.get("title"),
                        "start": o.get("timestamp"),
                        "points": [{"time": p.get("timestamp"), "content": p.get("content")} for p in o.get("part_outline") or []],
                    }
                    for o in model.get("outline") or []
                ],
            }
        if sub == "subtitle" and len(sub_pos) == 1:
            page, lang, text_only = 1, None, False
            i = 0
            while i < len(sub_opts):
                tok = sub_opts[i]
                if tok in ("--page", "-p") and i + 1 < len(sub_opts):
                    page = int(sub_opts[i + 1])
                    i += 2
                elif tok == "--lang" and i + 1 < len(sub_opts):
                    lang = sub_opts[i + 1]
                    i += 2
                elif tok == "--text":
                    text_only = True
                    i += 1
                else:
                    return False, None
            if page < 1:
                return False, None
            return True, await _fast_video_subtitle(sub_pos[0], page, lang, text_only)
        if sub == "watch" and len(sub_pos) == 1:
            page, frames_n, comments_n, transcript, max_chars, record = 1, 9, 5, "auto", 6000, False
            i = 0
            while i < len(sub_opts):
                tok = sub_opts[i]
                if tok in ("--page", "-p") and i + 1 < len(sub_opts):
                    page = int(sub_opts[i + 1])
                    i += 2
                elif tok == "--frames" and i + 1 < len(sub_opts):
                    frames_n = int(sub_opts[i + 1])
                    i += 2
                elif tok == "--comments" and i + 1 < len(sub_opts):
                    comments_n = int(sub_opts[i + 1])
                    i += 2
                elif tok == "--transcript" and i + 1 < len(sub_opts):
                    transcript = sub_opts[i + 1]
                    i += 2
                elif tok == "--max-chars" and i + 1 < len(sub_opts):
                    max_chars = int(sub_opts[i + 1])
                    i += 2
                elif tok == "--record":
                    record = True
                    i += 1
                else:
                    return False, None
            return True, await _fast_video_watch(sub_pos[0], page, frames_n, comments_n, transcript, max_chars, record)
        if sub == "frames" and len(sub_pos) == 1:
            page, count, every, by_chapter, quality, sheet, out_path = 1, None, None, False, "preview", True, None
            at_list: list[str] = []
            i = 0
            while i < len(sub_opts):
                tok = sub_opts[i]
                if tok in ("--page", "-p") and i + 1 < len(sub_opts):
                    page = int(sub_opts[i + 1])
                    i += 2
                elif tok in ("--count", "-n") and i + 1 < len(sub_opts):
                    count = int(sub_opts[i + 1])
                    i += 2
                elif tok == "--every" and i + 1 < len(sub_opts):
                    every = float(sub_opts[i + 1])
                    i += 2
                elif tok == "--at" and i + 1 < len(sub_opts):
                    at_list.append(sub_opts[i + 1])
                    i += 2
                elif tok == "--chapters":
                    by_chapter = True
                    i += 1
                elif tok in ("--quality", "-q") and i + 1 < len(sub_opts):
                    quality = sub_opts[i + 1]
                    i += 2
                elif tok == "--sheet":
                    sheet = True
                    i += 1
                elif tok == "--no-sheet":
                    sheet = False
                    i += 1
                elif tok == "--out" and i + 1 < len(sub_opts):
                    raw_out = Path(sub_opts[i + 1])
                    if not raw_out.is_absolute() and req_cwd:
                        raw_out = Path(req_cwd) / raw_out
                    out_path = raw_out
                    i += 2
                else:
                    return False, None
            if page < 1 or (count is not None and count < 1) or (every is not None and every < 1):
                return False, None
            return True, await _fast_video_frames(sub_pos[0], page, count, every, at_list, by_chapter, quality, sheet, out_path)
        if sub == "transcribe" and len(sub_pos) == 1:
            page, engine, max_minutes, text_only, hint, no_cache = 1, "auto", 60.0, False, False, False
            i = 0
            while i < len(sub_opts):
                tok = sub_opts[i]
                if tok in ("--page", "-p") and i + 1 < len(sub_opts):
                    page = int(sub_opts[i + 1])
                    i += 2
                elif tok in ("--engine", "-e") and i + 1 < len(sub_opts):
                    engine = sub_opts[i + 1]
                    i += 2
                elif tok == "--max-minutes" and i + 1 < len(sub_opts):
                    max_minutes = float(sub_opts[i + 1])
                    i += 2
                elif tok == "--text":
                    text_only = True
                    i += 1
                elif tok == "--hint":
                    hint = True
                    i += 1
                elif tok == "--no-cache":
                    no_cache = True
                    i += 1
                else:
                    return False, None
            if page < 1:
                return False, None
            return True, await _fast_video_transcribe(sub_pos[0], page, engine, max_minutes, text_only, hint, no_cache)

    if clean_args[:2] == ["me", "stats"]:
        sub_opts, sub_pos = _split_opts_and_pos(clean_args[2:])
        if not sub_pos and (not sub_opts or (len(sub_opts) == 2 and sub_opts[0] == "--period")):
            period = sub_opts[1] if len(sub_opts) == 2 else "week"
            return True, await _fast_me_stats(period)

    if clean_args[:2] == ["user", "info"]:
        sub_opts, sub_pos = _split_opts_and_pos(clean_args[2:])
        if not sub_opts and len(sub_pos) == 1:
            return True, await _fast_user_info(sub_pos[0])

    return False, None


async def _dispatch_typer(raw_args: list[str], req_cwd: str | None, is_write: bool) -> Any:
    hoisted = bili_main._hoist_global_flags(["--compact", *raw_args])
    box: list[Any] = []
    token = _CAPTURE_BOX.set(box)
    prev_cwd = None
    try:
        output.settings.pretty = False
        output.settings.raw = False
        output.settings.dry_run = False
        output.settings.wait = False
        if is_write and req_cwd and os.path.isdir(req_cwd):
            prev_cwd = os.getcwd()
            os.chdir(req_cwd)
        _CLICK_GROUP.main(args=hoisted, prog_name="bili", standalone_mode=False)
    except UsageError as exc:
        raise BiliError("invalid_argument", exc.format_message()) from exc
    except typer.Exit as exc:
        if exc.exit_code == 0 and "--version" in hoisted:
            return {"version": bili_cli.__version__}
        raise BiliError("internal_error", f"bili exited {exc.exit_code}") from exc
    finally:
        if prev_cwd is not None:
            try:
                os.chdir(prev_cwd)
            except OSError:
                pass
        _CAPTURE_BOX.reset(token)

    if not box:
        raise BiliError("invalid_argument", "未指定有效的子命令。")
    return await box[0]()


async def _execute_request(req: dict[str, Any]) -> None:
    req_id = req.get("id")
    raw_args = [str(a) for a in (req.get("args") or [])]
    clean_args = [a for a in raw_args if a not in ("--compact", "--pretty")]
    req_cwd = req.get("cwd") if isinstance(req.get("cwd"), str) else None
    is_write = bool(req.get("write"))

    if is_write:
        await _GATE.acquire_write()
    else:
        await _GATE.acquire_read()

    try:
        if is_write:
            _clear_mutable_caches()
            data = await _dispatch_typer(clean_args, req_cwd, is_write=True)
            _clear_mutable_caches()
        else:
            try:
                handled, data = await _try_fast_dispatch(clean_args, req_cwd)
            except ValueError:
                handled, data = False, None
            if not handled:
                data = await _dispatch_typer(clean_args, req_cwd, is_write=False)
        _send_ipc({"id": req_id, "ok": True, "data": data, "exit_code": 0})
    except BaseException as exc:
        err = from_exception(exc)
        _send_ipc({"id": req_id, "ok": False, "error": err.to_dict(), "exit_code": err.exit_code})
    finally:
        if is_write:
            await _GATE.release_write()
        else:
            await _GATE.release_read()


async def _main() -> None:
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    # Pre-warm GPU detection asynchronously so even the first diagnose call doesn't wait on nvidia-smi
    asyncio.create_task(_get_gpu_cached())

    def _stdin_reader() -> None:
        try:
            for raw_line in _IPC_IN:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except Exception as exc:
                    _send_ipc({"id": None, "ok": False, "error": {"code": "invalid_argument", "message": f"Invalid IPC JSON: {exc}"}, "exit_code": 2})
                    continue
                if msg.get("cmd") == "shutdown":
                    loop.call_soon_threadsafe(stop_event.set)
                    return
                loop.call_soon_threadsafe(lambda m=msg: asyncio.create_task(_execute_request(m)))
        except BaseException:
            pass
        finally:
            loop.call_soon_threadsafe(stop_event.set)

    reader_thread = threading.Thread(target=_stdin_reader, name="bili-daemon-stdin", daemon=True)
    reader_thread.start()
    _send_ipc({"type": "ready", "pid": os.getpid(), "version": bili_cli.__version__})

    await stop_event.wait()
    for client in list(_HTTPX_POOL.values()):
        try:
            await client.aclose()
        except Exception:
            pass
    _HTTPX_POOL.clear()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
    os._exit(0)
