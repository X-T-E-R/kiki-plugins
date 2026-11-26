import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { gunzipSync } from 'node:zlib';
import { mapPointToTarget } from './frame-math.mjs';
import { encodePng } from './png-codec.mjs';

const PVE_HOST_RE = /^[A-Za-z0-9._-]+$/;
const PVE_VMID_RE = /^[1-9]\d{0,8}$/;
const PVE_PREFIX_RE = /^pve:/i;
const WORKER_IDLE_TTL_MS = 60_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_STATUS_CACHE_TTL_MS = 5_000;
const QMP_ABS_MAX = 32767;
const MAX_QGA_CLIPBOARD_BYTES = 2 * 1024 * 1024;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const REMOTE_PYTHON_BRIDGE = `
import base64, gzip, hashlib, json, os, re, socket, subprocess, sys, time

B64_RE = re.compile(r"^[A-Za-z0-9+/=]*$")

def choose_tmp_dir():
    if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK):
        return "/dev/shm"
    return "/tmp"

def parse_ppm_dims(head):
    tokens = []
    i = 0
    n = len(head)
    while i < n and len(tokens) < 4:
        b = head[i]
        if b in (9, 10, 13, 32):
            i += 1
        elif b == 35:
            while i < n and head[i] != 10:
                i += 1
        else:
            j = i
            while j < n and head[j] not in (9, 10, 13, 32, 35):
                j += 1
            tokens.append(head[i:j].decode("ascii", "replace"))
            i = j
    if len(tokens) >= 3 and tokens[0] == "P6":
        return int(tokens[1]), int(tokens[2])
    return None

def qmp_read_reply(f):
    while True:
        line = f.readline()
        if not line:
            raise RuntimeError("QMP socket closed unexpectedly")
        msg = json.loads(line.decode("utf-8", "replace"))
        if "event" in msg and "return" not in msg and "error" not in msg:
            continue
        if "error" in msg:
            err = msg["error"]
            raise RuntimeError(f"QMP error ({err.get('class', 'GenericError')}): {err.get('desc', '')}")
        return msg.get("return")

def qmp_open(vmid, timeout=6.0):
    sock_path = f"/var/run/qemu-server/{int(vmid)}.qmp"
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(sock_path)
    f = s.makefile("rwb", buffering=0)
    greeting = f.readline()
    if not greeting:
        s.close()
        raise RuntimeError(f"Empty QMP greeting from {sock_path}")
    f.write(b'{"execute":"qmp_capabilities"}\\n')
    qmp_read_reply(f)
    return s, f

def qmp_exec(f, cmd, args=None):
    payload = {"execute": cmd}
    if args is not None:
        payload["arguments"] = args
    f.write((json.dumps(payload, separators=(",", ":")) + "\\n").encode("utf-8"))
    return qmp_read_reply(f)

def handle_status(req):
    vmid = int(req["vmid"])
    vm_status = "unknown"
    qm_error = None
    try:
        proc = subprocess.run(["qm", "status", str(vmid)], capture_output=True, text=True, timeout=5)
        out = (proc.stdout or "").strip()
        if proc.returncode == 0 and out:
            for line in out.splitlines():
                if line.lower().startswith("status:"):
                    vm_status = line.split(":", 1)[1].strip().lower()
                    break
        else:
            qm_error = (proc.stderr or out or f"qm status exited {proc.returncode}").strip()
    except Exception as exc:
        qm_error = str(exc)

    vm_name = None
    running = vm_status == "running"
    width = None
    height = None
    vdagent_configured = False
    vdagent_connected = False

    if running or os.path.exists(f"/var/run/qemu-server/{vmid}.qmp"):
        s = None
        tmp_path = None
        try:
            s, f = qmp_open(vmid, timeout=5.0)
            st = qmp_exec(f, "query-status") or {}
            if isinstance(st, dict):
                if "status" in st:
                    vm_status = str(st["status"]).lower()
                if "running" in st:
                    running = bool(st["running"])
            nm = qmp_exec(f, "query-name") or {}
            if isinstance(nm, dict) and nm.get("name"):
                vm_name = str(nm["name"])
            try:
                chardevs = qmp_exec(f, "query-chardev") or []
                if isinstance(chardevs, list):
                    for dev in chardevs:
                        if not isinstance(dev, dict):
                            continue
                        fname = str(dev.get("filename") or "").lower()
                        lbl = str(dev.get("label") or "").lower()
                        if "vdagent" in fname or "vdagent" in lbl or "spicevmc" in fname or "spicevmc" in lbl:
                            vdagent_configured = True
                            if bool(dev.get("frontend-open")):
                                vdagent_connected = True
            except Exception:
                pass
            if running and req.get("probeResolution"):
                tmp_path = f"{choose_tmp_dir()}/kiki_pve_{vmid}_{os.getpid()}_dim.ppm"
                qmp_exec(f, "screendump", {"filename": tmp_path})
                with open(tmp_path, "rb") as pf:
                    dims = parse_ppm_dims(pf.read(160))
                if dims:
                    width, height = dims
        except Exception:
            pass
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            if s:
                try:
                    s.close()
                except OSError:
                    pass

    if vm_status == "unknown" and qm_error:
        raise RuntimeError(qm_error)

    return {
        "vmid": vmid,
        "vmStatus": vm_status,
        "running": running,
        "vmName": vm_name,
        "width": width,
        "height": height,
        "vdagentConfigured": vdagent_configured,
        "vdagentConnected": vdagent_connected,
    }

def handle_screendump(req):
    vmid = int(req["vmid"])
    last_hash = req.get("lastHash")
    tmp_path = f"{choose_tmp_dir()}/kiki_pve_{vmid}_{os.getpid()}.ppm"
    s = None
    try:
        s, f = qmp_open(vmid, timeout=6.0)
        qmp_exec(f, "screendump", {"filename": tmp_path})
        s.close()
        s = None
        with open(tmp_path, "rb") as pf:
            raw = pf.read()
        ppm_hash = hashlib.sha256(raw).hexdigest()
        if isinstance(last_hash, str) and last_hash and last_hash == ppm_hash:
            return {
                "unchanged": True,
                "hash": ppm_hash,
                "rawBytes": len(raw),
                "compressedBytes": 0,
            }
        gz = gzip.compress(raw, compresslevel=1)
        return {
            "unchanged": False,
            "hash": ppm_hash,
            "encoding": "ppm-gzip-base64",
            "data": base64.b64encode(gz).decode("ascii"),
            "rawBytes": len(raw),
            "compressedBytes": len(gz),
        }
    finally:
        if s:
            try:
                s.close()
            except OSError:
                pass
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

def handle_qmp_batch(req):
    vmid = int(req["vmid"])
    steps = req.get("steps") or []
    s = None
    executed = 0
    try:
        s, f = qmp_open(vmid, timeout=10.0)
        for step in steps:
            op = step.get("op")
            if op == "sleep":
                ms = max(0, min(10000, int(step.get("ms") or 0)))
                if ms > 0:
                    time.sleep(ms / 1000.0)
            elif op == "qmp":
                qmp_exec(f, step["execute"], step.get("arguments"))
                executed += 1
        return {"executed": executed}
    finally:
        if s:
            try:
                s.close()
            except OSError:
                pass

def handle_qga_probe(req):
    vmid = int(req["vmid"])
    sock_exists = os.path.exists(f"/var/run/qemu-server/{vmid}.qga")
    available = False
    os_type = "unknown"
    os_version = ""
    is_legacy_nt5 = False
    try:
        proc = subprocess.run(["qm", "agent", str(vmid), "ping"], capture_output=True, text=True, timeout=3)
        available = proc.returncode == 0
    except Exception:
        available = False
    if available:
        try:
            info = subprocess.run(["qm", "agent", str(vmid), "get-osinfo"], capture_output=True, text=True, timeout=3)
            if info.returncode == 0 and info.stdout:
                low = info.stdout.lower()
                if "windows" in low or "mswindows" in low:
                    os_type = "windows"
                    try:
                        parsed_info = json.loads(info.stdout)
                        if isinstance(parsed_info, dict):
                            os_version = str(parsed_info.get("version-id") or parsed_info.get("kernel-release") or "")
                    except Exception:
                        pass
                    if os_version.startswith("5.") or "xp" in low or "2003" in low:
                        is_legacy_nt5 = True
                elif "linux" in low or "ubuntu" in low or "debian" in low or "fedora" in low or "arch" in low:
                    os_type = "linux"
        except Exception:
            pass
    return {
        "available": available,
        "socketExists": sock_exists,
        "osType": os_type,
        "osVersion": os_version,
        "isLegacyNt5": is_legacy_nt5,
    }

def parse_guest_exec_output(proc):
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"qm guest exec exited {proc.returncode}").strip())
    raw = (proc.stdout or "").strip()
    if not raw:
        return {"exitcode": 0, "out-data": ""}
    data = json.loads(raw)
    if int(data.get("exitcode", 0)) != 0:
        err_msg = data.get("err-data") or f"guest exec exitcode={data.get('exitcode')}"
        raise RuntimeError(str(err_msg).strip())
    return data

def windows_mshta_clipboard_set(vmid, text_b64):
    raw_utf8 = base64.b64decode(text_b64).decode("utf-8", errors="replace")
    js_str = json.dumps(raw_utf8)
    hta_expr = f"javascript:try{{window.clipboardData.setData('Text',{js_str});}}catch(e){{}}close();"
    cmd = ["qm", "guest", "exec", str(vmid), "--", "mshta.exe", hta_expr]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
    parse_guest_exec_output(proc)
    return {"ok": True, "mode": "qga_mshta"}

def windows_mshta_clipboard_get(vmid):
    js = (
        "javascript:try{"
        "var fso=new ActiveXObject('Scripting.FileSystemObject');"
        "var sh=new ActiveXObject('WScript.Shell');"
        "var p=sh.ExpandEnvironmentStrings('%TEMP%')+'\\\\kiki_qga_clip.txt';"
        "var t=window.clipboardData.getData('Text')||'';"
        "var s=fso.CreateTextFile(p,true,true);s.Write(t);s.Close();"
        "}catch(e){}close();"
    )
    proc_hta = subprocess.run(["qm", "guest", "exec", str(vmid), "--", "mshta.exe", js], capture_output=True, text=True, timeout=8)
    parse_guest_exec_output(proc_hta)
    proc_read = subprocess.run(
        ["qm", "guest", "exec", str(vmid), "--", "cmd.exe", "/d", "/c", "type %TEMP%\\kiki_qga_clip.txt & del /f /q %TEMP%\\kiki_qga_clip.txt >nul 2>&1"],
        capture_output=True, text=True, timeout=6,
    )
    data = parse_guest_exec_output(proc_read)
    out_raw = str(data.get("out-data") or "")
    return {"textB64": base64.b64encode(out_raw.encode("utf-8")).decode("ascii"), "mode": "qga_mshta"}

def handle_qga_clipboard_set(req):
    vmid = int(req["vmid"])
    text_b64 = str(req.get("textB64") or "")
    if not B64_RE.match(text_b64):
        raise RuntimeError("Invalid base64 clipboard payload")
    os_type = str(req.get("osType") or "linux").lower()
    if os_type == "windows":
        if bool(req.get("isLegacyNt5")):
            return windows_mshta_clipboard_set(vmid, text_b64)
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            f"$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{text_b64}'));"
            "if([string]::IsNullOrEmpty($t)){[System.Windows.Forms.Clipboard]::Clear()}"
            "else{[System.Windows.Forms.Clipboard]::SetText($t)}"
        )
        ps_b64 = base64.b64encode(ps.encode("utf-16le")).decode("ascii")
        cmd = ["qm", "guest", "exec", str(vmid), "--", "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", ps_b64]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        try:
            parse_guest_exec_output(proc)
            return {"ok": True, "mode": "qga_powershell"}
        except Exception:
            return windows_mshta_clipboard_set(vmid, text_b64)
    cmd = [
        "qm", "guest", "exec", str(vmid), "--", "sh", "-c",
        'printf %s "$1" | base64 -d | (wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || xsel --clipboard --input)',
        "--", text_b64,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
    parse_guest_exec_output(proc)
    return {"ok": True, "mode": "qga_posix"}

def handle_qga_clipboard_get(req):
    vmid = int(req["vmid"])
    os_type = str(req.get("osType") or "linux").lower()
    if os_type == "windows":
        if bool(req.get("isLegacyNt5")):
            return windows_mshta_clipboard_get(vmid)
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$t='';if([System.Windows.Forms.Clipboard]::ContainsText()){$t=[System.Windows.Forms.Clipboard]::GetText()};"
            "[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)))"
        )
        ps_b64 = base64.b64encode(ps.encode("utf-16le")).decode("ascii")
        cmd = ["qm", "guest", "exec", str(vmid), "--", "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", ps_b64]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        try:
            data = parse_guest_exec_output(proc)
            out_b64 = str(data.get("out-data") or "").strip().replace("\\n", "").replace("\\r", "")
            return {"textB64": out_b64, "mode": "qga_powershell"}
        except Exception:
            return windows_mshta_clipboard_get(vmid)
    cmd = [
        "qm", "guest", "exec", str(vmid), "--", "sh", "-c",
        '(wl-paste -n 2>/dev/null || xclip -o -selection clipboard 2>/dev/null || xsel --clipboard --output) | base64 -w0',
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
    data = parse_guest_exec_output(proc)
    out_b64 = str(data.get("out-data") or "").strip().replace("\\n", "").replace("\\r", "")
    return {"textB64": out_b64, "mode": "qga_posix"}

for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue
    req_id = None
    try:
        req = json.loads(line)
        req_id = req.get("id")
        op = req.get("op")
        if op == "status":
            res = handle_status(req)
        elif op == "screendump":
            res = handle_screendump(req)
        elif op == "qmp_batch":
            res = handle_qmp_batch(req)
        elif op == "qga_probe":
            res = handle_qga_probe(req)
        elif op == "qga_clipboard_set":
            res = handle_qga_clipboard_set(req)
        elif op == "qga_clipboard_get":
            res = handle_qga_clipboard_get(req)
        elif op == "ping":
            res = {"pong": True}
        else:
            raise RuntimeError(f"Unsupported PVE bridge op: {op}")
        out = {"id": req_id, "ok": True, "result": res}
    except Exception as exc:
        out = {"id": req_id, "ok": False, "error": str(exc)}
    sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
`.trim();

const REMOTE_PYTHON_BRIDGE_B64 = Buffer.from(REMOTE_PYTHON_BRIDGE, 'utf8').toString('base64');

export function isPveTargetId(value) {
  return PVE_PREFIX_RE.test(String(value ?? '').trim());
}

export function assertValidPveHost(host) {
  const clean = String(host ?? '').trim();
  if (!clean || clean.length > 128 || clean.startsWith('-') || !PVE_HOST_RE.test(clean)) {
    throw new Error(
      `Invalid PVE SSH host "${String(host ?? '')}": must match ^[A-Za-z0-9._-]+$ and not start with "-".`,
    );
  }
  return clean;
}

export function assertValidPveVmid(vmid) {
  const clean = String(vmid ?? '').trim();
  if (!PVE_VMID_RE.test(clean)) {
    throw new Error(`Invalid PVE VMID "${String(vmid ?? '')}": must be a positive integer.`);
  }
  const num = Number(clean);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new Error(`Invalid PVE VMID "${String(vmid ?? '')}": must be a positive integer.`);
  }
  return num;
}

export function buildPveTargetId(sshHost, vmid) {
  const host = assertValidPveHost(sshHost);
  const idNum = assertValidPveVmid(vmid);
  return `pve:${host}:${idNum}`;
}

export function parsePveTargetId(value, { strict = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!PVE_PREFIX_RE.test(raw)) {
    if (strict) {
      throw new Error(`Invalid PVE target ID "${raw}": expected format pve:<ssh_host>:<vmid>.`);
    }
    return null;
  }
  const parts = raw.split(':');
  if (parts.length !== 3) {
    if (strict) {
      throw new Error(`Invalid PVE target ID "${raw}": expected format pve:<ssh_host>:<vmid>.`);
    }
    return null;
  }
  try {
    const sshHost = assertValidPveHost(parts[1]);
    const vmid = assertValidPveVmid(parts[2]);
    return {
      id: `pve:${sshHost}:${vmid}`,
      sshHost,
      vmid,
    };
  } catch (err) {
    if (strict) throw err;
    return null;
  }
}

export function normalizePveTargetId(value) {
  const parsed = parsePveTargetId(value, { strict: false });
  return parsed ? parsed.id : String(value ?? '').trim();
}

/**
 * Parse binary P6 PPM buffer into an RGBA image { width, height, data: Uint8Array }.
 * Handles arbitrary whitespace and '#' comment lines in the header per Netpbm P6 spec,
 * consuming strictly a single whitespace byte after maxval before raw RGB pixel data.
 */
export function parsePpmP6(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 11) {
    throw new Error('Invalid PPM buffer: too short.');
  }

  let pos = 0;
  const tokens = [];

  const isWs = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

  while (tokens.length < 4 && pos < buf.length) {
    // Skip whitespace & comments before each token
    while (pos < buf.length) {
      if (isWs(buf[pos])) {
        pos += 1;
      } else if (buf[pos] === 0x23) {
        // '#' comment until newline
        while (pos < buf.length && buf[pos] !== 0x0a) pos += 1;
      } else {
        break;
      }
    }
    if (pos >= buf.length) break;
    const start = pos;
    while (pos < buf.length && !isWs(buf[pos]) && buf[pos] !== 0x23) {
      pos += 1;
    }
    tokens.push(buf.toString('ascii', start, pos));
  }

  if (tokens.length < 4 || tokens[0] !== 'P6') {
    throw new Error(`Unsupported PPM header: expected P6, got "${tokens[0] || ''}".`);
  }

  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const maxval = Number(tokens[3]);

  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Invalid PPM dimensions: ${tokens[1]}x${tokens[2]}.`);
  }
  if (!Number.isInteger(maxval) || maxval <= 0 || maxval > 65535) {
    throw new Error(`Invalid PPM maxval: ${tokens[3]}.`);
  }

  // Netpbm P6 specifies a single whitespace character immediately after maxval
  if (pos >= buf.length || !isWs(buf[pos])) {
    throw new Error('Malformed PPM P6 header: missing whitespace delimiter after maxval.');
  }
  pos += 1;

  const pixelCount = width * height;
  const bytesPerSample = maxval > 255 ? 2 : 1;
  const expectedBytes = pixelCount * 3 * bytesPerSample;
  if (buf.length - pos < expectedBytes) {
    throw new Error(`Truncated PPM P6 pixel payload: got ${buf.length - pos}, expected ${expectedBytes}.`);
  }

  const rgba = new Uint8Array(pixelCount * 4);
  if (bytesPerSample === 1) {
    if (maxval === 255) {
      for (let i = 0, s = pos, d = 0; i < pixelCount; i += 1, s += 3, d += 4) {
        rgba[d] = buf[s];
        rgba[d + 1] = buf[s + 1];
        rgba[d + 2] = buf[s + 2];
        rgba[d + 3] = 255;
      }
    } else {
      const scale = 255 / maxval;
      for (let i = 0, s = pos, d = 0; i < pixelCount; i += 1, s += 3, d += 4) {
        rgba[d] = Math.round(buf[s] * scale);
        rgba[d + 1] = Math.round(buf[s + 1] * scale);
        rgba[d + 2] = Math.round(buf[s + 2] * scale);
        rgba[d + 3] = 255;
      }
    }
  } else {
    const scale = 255 / maxval;
    for (let i = 0, s = pos, d = 0; i < pixelCount; i += 1, s += 6, d += 4) {
      rgba[d] = Math.round(buf.readUInt16BE(s) * scale);
      rgba[d + 1] = Math.round(buf.readUInt16BE(s + 2) * scale);
      rgba[d + 2] = Math.round(buf.readUInt16BE(s + 4) * scale);
      rgba[d + 3] = 255;
    }
  }

  return { width, height, data: rgba };
}

export function ppmToPngBuffer(ppmBytes, { level = 3 } = {}) {
  const image = parsePpmP6(ppmBytes);
  return {
    width: image.width,
    height: image.height,
    image,
    pngBuffer: encodePng(image, { level }),
  };
}

/**
 * Convert coordinate in coordinateMode space into QEMU USB Tablet absolute coordinates [0..32767]
 * plus logical pixel/normalized_1000 readouts. Delegates to frame-math.mjs mapPointToTarget (Frame Audit B2).
 */
export function mapPointToQmpAbs({
  x,
  y,
  coordinateMode = 'normalized_1000',
  zoomRelative = false,
  screenSize = { width: 1024, height: 768 },
  lastObservation = null,
}) {
  const width = Math.max(1, Math.round(Number(screenSize?.width) || 1024));
  const height = Math.max(1, Math.round(Number(screenSize?.height) || 768));
  const bounds = { x: 0, y: 0, width, height };
  const mapped = mapPointToTarget({
    x,
    y,
    coordinateMode,
    zoomRelative,
    stageBounds: bounds,
    contentRect: bounds,
    lastObservation,
  });

  const absX = clamp(Math.round(mapped.norm01X * QMP_ABS_MAX), 0, QMP_ABS_MAX);
  const absY = clamp(Math.round(mapped.norm01Y * QMP_ABS_MAX), 0, QMP_ABS_MAX);

  return {
    x: mapped.x,
    y: mapped.y,
    normX: mapped.normX,
    normY: mapped.normY,
    norm01X: mapped.norm01X,
    norm01Y: mapped.norm01Y,
    absX,
    absY,
  };
}

// --- QEMU QKeyCode mapping ---

const QKEY_BY_NAME = new Map([
  ['ret', 'ret'],
  ['enter', 'ret'],
  ['return', 'ret'],
  ['esc', 'esc'],
  ['escape', 'esc'],
  ['tab', 'tab'],
  ['backspace', 'backspace'],
  ['bksp', 'backspace'],
  ['delete', 'delete'],
  ['del', 'delete'],
  ['insert', 'insert'],
  ['ins', 'insert'],
  ['space', 'spc'],
  ['spacebar', 'spc'],
  ['spc', 'spc'],
  ['up', 'up'],
  ['arrowup', 'up'],
  ['down', 'down'],
  ['arrowdown', 'down'],
  ['left', 'left'],
  ['arrowleft', 'left'],
  ['right', 'right'],
  ['arrowright', 'right'],
  ['home', 'home'],
  ['end', 'end'],
  ['pageup', 'pgup'],
  ['pgup', 'pgup'],
  ['pagedown', 'pgdn'],
  ['pgdn', 'pgdn'],
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['lctrl', 'ctrl'],
  ['rctrl', 'ctrl_r'],
  ['ctrl_r', 'ctrl_r'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['menu', 'alt'],
  ['lalt', 'alt'],
  ['ralt', 'alt_r'],
  ['alt_r', 'alt_r'],
  ['shift', 'shift'],
  ['lshift', 'shift'],
  ['rshift', 'shift_r'],
  ['shift_r', 'shift_r'],
  ['win', 'meta_l'],
  ['meta', 'meta_l'],
  ['super', 'meta_l'],
  ['command', 'meta_l'],
  ['cmd', 'meta_l'],
  ['lwin', 'meta_l'],
  ['meta_l', 'meta_l'],
  ['rwin', 'meta_r'],
  ['meta_r', 'meta_r'],
  ['capslock', 'caps_lock'],
  ['caps_lock', 'caps_lock'],
  ['numlock', 'num_lock'],
  ['num_lock', 'num_lock'],
  ['scrolllock', 'scroll_lock'],
  ['scroll_lock', 'scroll_lock'],
  ['printscreen', 'sysrq'],
  ['prtsc', 'sysrq'],
  ['sysrq', 'sysrq'],
  ['pause', 'pause'],
  ['apps', 'compose'],
  ['contextmenu', 'compose'],
  ['compose', 'compose'],
  ['-', 'minus'],
  ['minus', 'minus'],
  ['=', 'equal'],
  ['equal', 'equal'],
  ['[', 'bracket_left'],
  ['bracketleft', 'bracket_left'],
  ['bracket_left', 'bracket_left'],
  [']', 'bracket_right'],
  ['bracketright', 'bracket_right'],
  ['bracket_right', 'bracket_right'],
  [';', 'semicolon'],
  ['semicolon', 'semicolon'],
  ["'", 'apostrophe'],
  ['quote', 'apostrophe'],
  ['apostrophe', 'apostrophe'],
  ['`', 'grave_accent'],
  ['backquote', 'grave_accent'],
  ['grave_accent', 'grave_accent'],
  ['\\', 'backslash'],
  ['backslash', 'backslash'],
  [',', 'comma'],
  ['comma', 'comma'],
  ['.', 'dot'],
  ['period', 'dot'],
  ['dot', 'dot'],
  ['/', 'slash'],
  ['slash', 'slash'],
]);

for (let i = 1; i <= 12; i += 1) {
  QKEY_BY_NAME.set(`f${i}`, `f${i}`);
}

const ASCII_CHAR_TO_QKEYS = new Map([
  [' ', ['spc']],
  ['\n', ['ret']],
  ['\r', ['ret']],
  ['\t', ['tab']],
  ['-', ['minus']],
  ['=', ['equal']],
  ['[', ['bracket_left']],
  [']', ['bracket_right']],
  [';', ['semicolon']],
  ["'", ['apostrophe']],
  ['`', ['grave_accent']],
  ['\\', ['backslash']],
  [',', ['comma']],
  ['.', ['dot']],
  ['/', ['slash']],
  ['!', ['shift', '1']],
  ['@', ['shift', '2']],
  ['#', ['shift', '3']],
  ['$', ['shift', '4']],
  ['%', ['shift', '5']],
  ['^', ['shift', '6']],
  ['&', ['shift', '7']],
  ['*', ['shift', '8']],
  ['(', ['shift', '9']],
  [')', ['shift', '0']],
  ['_', ['shift', 'minus']],
  ['+', ['shift', 'equal']],
  ['{', ['shift', 'bracket_left']],
  ['}', ['shift', 'bracket_right']],
  [':', ['shift', 'semicolon']],
  ['"', ['shift', 'apostrophe']],
  ['~', ['shift', 'grave_accent']],
  ['|', ['shift', 'backslash']],
  ['<', ['shift', 'comma']],
  ['>', ['shift', 'dot']],
  ['?', ['shift', 'slash']],
]);

export function resolveQmpKeyToken(token) {
  const raw = String(token ?? '').trim();
  if (!raw) throw new Error('Empty QMP key token.');
  const lower = raw.toLowerCase();
  if (lower === 'plus' || raw === '+') {
    return ['shift', 'equal'];
  }
  if (QKEY_BY_NAME.has(lower)) {
    return [QKEY_BY_NAME.get(lower)];
  }
  if (/^[a-z]$/i.test(raw)) {
    return [lower];
  }
  if (/^[0-9]$/.test(raw)) {
    return [raw];
  }
  throw new Error(`Unsupported QMP key token: "${raw}"`);
}

export function normalizeQmpKeyChord(keysOrKey) {
  let rawTokens;
  if (Array.isArray(keysOrKey)) {
    rawTokens = keysOrKey
      .flatMap((part) => {
        const s = String(part ?? '').trim();
        return s === '+' ? ['+'] : s.split('+');
      })
      .map((part) => part.trim())
      .filter(Boolean);
    if (rawTokens.length === 0) throw new Error('QMP key chord array cannot be empty.');
  } else {
    const str = String(keysOrKey ?? '').trim();
    if (!str) throw new Error('QMP key chord string cannot be empty.');
    if (str === '+') {
      rawTokens = ['+'];
    } else if (str.endsWith('++')) {
      const prefix = str.slice(0, -2).split('+').map((p) => p.trim()).filter(Boolean);
      rawTokens = [...prefix, '+'];
    } else {
      rawTokens = str
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (rawTokens.length === 0) throw new Error(`Invalid QMP key chord: "${str}"`);
  }

  const out = [];
  for (const tok of rawTokens) {
    for (const qcode of resolveQmpKeyToken(tok)) {
      if (!out.includes(qcode)) out.push(qcode);
    }
  }
  return out;
}

export function asciiCharToQmpKeys(ch) {
  if (/^[a-z0-9]$/.test(ch)) return [ch];
  if (/^[A-Z]$/.test(ch)) return ['shift', ch.toLowerCase()];
  if (ASCII_CHAR_TO_QKEYS.has(ch)) return ASCII_CHAR_TO_QKEYS.get(ch);
  throw new Error(
    `PVE QMP keyboard input only supports ASCII characters; unsupported character "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}).`,
  );
}

export function buildQmpMoveStep(absX, absY) {
  return {
    op: 'qmp',
    execute: 'input-send-event',
    arguments: {
      events: [
        { type: 'abs', data: { axis: 'x', value: clamp(Math.round(absX), 0, QMP_ABS_MAX) } },
        { type: 'abs', data: { axis: 'y', value: clamp(Math.round(absY), 0, QMP_ABS_MAX) } },
      ],
    },
  };
}

export function buildQmpButtonStep(button, down) {
  const valid = new Set(['left', 'right', 'middle', 'wheel-up', 'wheel-down', 'wheel-left', 'wheel-right']);
  if (!valid.has(button)) {
    throw new Error(`Unsupported QMP mouse button: "${String(button)}"`);
  }
  return {
    op: 'qmp',
    execute: 'input-send-event',
    arguments: {
      events: [
        { type: 'btn', data: { button, down: Boolean(down) } },
      ],
    },
  };
}

export function buildQmpKeyEventStep(qcode, down) {
  return {
    op: 'qmp',
    execute: 'input-send-event',
    arguments: {
      events: [
        { type: 'key', data: { key: { type: 'qcode', data: qcode }, down: Boolean(down) } },
      ],
    },
  };
}

export function buildQmpSendKeyStep(qcodes, holdTimeMs = 40) {
  const hold = clamp(Math.round(Number(holdTimeMs) || 40), 10, 10_000);
  return {
    op: 'qmp',
    execute: 'send-key',
    arguments: {
      keys: qcodes.map((qcode) => ({ type: 'qcode', data: qcode })),
      'hold-time': hold,
    },
  };
}

/**
 * Compile one high-level UU/CUA action into deterministic QMP batch steps.
 */
export function buildQmpStepsForAction(item, {
  coordinateMode = 'normalized_1000',
  zoomRelative = false,
  screenSize = { width: 1024, height: 768 },
  lastObservation = null,
} = {}) {
  const kind = item.kind;
  const steps = [];

  if (kind === 'move') {
    const pt = mapPointToQmpAbs({ x: item.x, y: item.y, coordinateMode, zoomRelative, screenSize, lastObservation });
    steps.push(buildQmpMoveStep(pt.absX, pt.absY));
    return { steps, point: pt, meta: { kind: 'move' } };
  }

  if (
    kind === 'click' ||
    kind === 'double_click' ||
    kind === 'right_click' ||
    kind === 'mouse_down' ||
    kind === 'mouse_up'
  ) {
    const button = kind === 'right_click' ? 'right' : (item.button || 'left');
    const count = kind === 'double_click'
      ? 2
      : kind === 'right_click'
        ? 1
        : clamp(Math.round(Number(item.count) || 1), 1, 3);

    let pt = null;
    if (item.x !== undefined && item.y !== undefined) {
      pt = mapPointToQmpAbs({ x: item.x, y: item.y, coordinateMode, zoomRelative, screenSize, lastObservation });
      steps.push(buildQmpMoveStep(pt.absX, pt.absY));
      steps.push({ op: 'sleep', ms: 16 });
    }

    const modQcodes = Array.isArray(item.modifiers) && item.modifiers.length > 0
      ? normalizeQmpKeyChord(item.modifiers)
      : [];
    for (const qcode of modQcodes) {
      steps.push(buildQmpKeyEventStep(qcode, true));
    }

    if (kind === 'mouse_down') {
      steps.push(buildQmpButtonStep(button, true));
    } else if (kind === 'mouse_up') {
      steps.push(buildQmpButtonStep(button, false));
    } else {
      for (let c = 0; c < count; c += 1) {
        steps.push(buildQmpButtonStep(button, true));
        steps.push({ op: 'sleep', ms: 28 });
        steps.push(buildQmpButtonStep(button, false));
        if (c + 1 < count) {
          steps.push({ op: 'sleep', ms: 55 });
        }
      }
    }

    for (let m = modQcodes.length - 1; m >= 0; m -= 1) {
      steps.push(buildQmpKeyEventStep(modQcodes[m], false));
    }

    return {
      steps,
      point: pt,
      meta: { kind, button, count: (kind === 'mouse_down' || kind === 'mouse_up') ? undefined : count },
    };
  }

  if (kind === 'drag') {
    const startPt = mapPointToQmpAbs({
      x: item.startX,
      y: item.startY,
      coordinateMode,
      zoomRelative,
      screenSize,
      lastObservation,
    });
    const endPt = mapPointToQmpAbs({
      x: item.endX,
      y: item.endY,
      coordinateMode,
      zoomRelative,
      screenSize,
      lastObservation,
    });
    const button = item.button || 'left';
    const durationMs = clamp(Math.round(Number(item.durationMs) || 260), 80, 5000);
    const segments = clamp(Math.round(durationMs / 25), 5, 20);
    const stepSleep = Math.max(10, Math.round(durationMs / segments));

    steps.push(buildQmpMoveStep(startPt.absX, startPt.absY));
    steps.push({ op: 'sleep', ms: 20 });
    steps.push(buildQmpButtonStep(button, true));
    steps.push({ op: 'sleep', ms: 24 });
    for (let s = 1; s <= segments; s += 1) {
      const t = s / segments;
      const ix = Math.round(startPt.absX + (endPt.absX - startPt.absX) * t);
      const iy = Math.round(startPt.absY + (endPt.absY - startPt.absY) * t);
      steps.push(buildQmpMoveStep(ix, iy));
      steps.push({ op: 'sleep', ms: stepSleep });
    }
    steps.push(buildQmpButtonStep(button, false));

    return {
      steps,
      point: endPt,
      startPoint: startPt,
      meta: { kind: 'drag', button, durationMs },
    };
  }

  if (kind === 'scroll') {
    let pt = null;
    if (item.x !== undefined && item.y !== undefined) {
      pt = mapPointToQmpAbs({ x: item.x, y: item.y, coordinateMode, zoomRelative, screenSize, lastObservation });
      steps.push(buildQmpMoveStep(pt.absX, pt.absY));
      steps.push({ op: 'sleep', ms: 16 });
    }
    const rawDy = Number(item.deltaY) || 0;
    const rawDx = Number(item.deltaX) || 0;
    const toTicks = (delta) => {
      if (delta === 0) return 0;
      const mag = Math.abs(delta);
      return clamp(mag <= 20 ? Math.round(mag) : Math.max(1, Math.round(mag / 120)), 1, 20);
    };
    const yTicks = toTicks(rawDy);
    const yBtn = rawDy > 0 ? 'wheel-down' : 'wheel-up';
    for (let i = 0; i < yTicks; i += 1) {
      steps.push(buildQmpButtonStep(yBtn, true));
      steps.push(buildQmpButtonStep(yBtn, false));
      if (i + 1 < yTicks) steps.push({ op: 'sleep', ms: 18 });
    }
    const xTicks = toTicks(rawDx);
    const xBtn = rawDx > 0 ? 'wheel-right' : 'wheel-left';
    for (let i = 0; i < xTicks; i += 1) {
      steps.push(buildQmpButtonStep(xBtn, true));
      steps.push(buildQmpButtonStep(xBtn, false));
      if (i + 1 < xTicks) steps.push({ op: 'sleep', ms: 18 });
    }
    return {
      steps,
      point: pt,
      meta: { kind: 'scroll', deltaX: rawDx, deltaY: rawDy, yTicks, xTicks },
    };
  }

  if (kind === 'key') {
    const chordInput = item.keys !== undefined ? item.keys : item.key;
    const qcodes = normalizeQmpKeyChord(chordInput);
    steps.push(buildQmpSendKeyStep(qcodes, 40));
    return { steps, point: null, meta: { kind: 'key', keys: qcodes } };
  }

  if (kind === 'hold_key') {
    const chordInput = item.keys !== undefined ? item.keys : item.key;
    const qcodes = normalizeQmpKeyChord(chordInput);
    const holdMs = clamp(Math.round(Number(item.durationMs) || 300), 20, 10_000);
    steps.push(buildQmpSendKeyStep(qcodes, holdMs));
    return { steps, point: null, meta: { kind: 'hold_key', keys: qcodes, durationMs: holdMs } };
  }

  if (kind === 'type') {
    const text = String(item.text ?? '');
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\r' && text[i + 1] === '\n') continue;
      const qcodes = asciiCharToQmpKeys(ch);
      steps.push(buildQmpSendKeyStep(qcodes, 20));
      if (i + 1 < text.length) {
        steps.push({ op: 'sleep', ms: 12 });
      }
    }
    if (item.submit) {
      if (steps.length > 0) steps.push({ op: 'sleep', ms: 20 });
      steps.push(buildQmpSendKeyStep(['ret'], 30));
    }
    return {
      steps,
      point: null,
      meta: { kind: 'type', length: text.length, submit: Boolean(item.submit) },
    };
  }

  throw new Error(`Unsupported PVE QMP action kind: "${String(kind)}"`);
}

export function buildSshBridgeArgs(sshHost, { connectTimeoutSec = 8 } = {}) {
  const host = assertValidPveHost(sshHost);
  // Keep remote command short and double-quote-free for Windows OpenSSH / MSYS2 / POSIX parity;
  // the base64-encoded bridge script is written on line 1 of stdin before NDJSON requests.
  const remoteCmd = "python3 -u -c 'import sys,base64;exec(base64.b64decode(sys.stdin.readline()))'";
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${clamp(Math.round(Number(connectTimeoutSec) || 8), 2, 30)}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '--',
    host,
    remoteCmd,
  ];
}

/**
 * Persistent per-SSH-host QMP driver using Node child_process -> system `ssh` + inline Python 3 bridge.
 * Opens/closes the local UNIX QMP socket per request (no QMP contention with `qm` or PVE Web UI)
 * while keeping the SSH session warm with automatic idle teardown and timeout watchdog.
 */
export function createPveQmpDriver({
  spawnProcess = spawn,
  sshBinary = 'ssh',
  hostPlatform = process.platform,
  workerIdleMs = WORKER_IDLE_TTL_MS,
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  statusCacheTtlMs = DEFAULT_STATUS_CACHE_TTL_MS,
  nowFn = Date.now,
} = {}) {
  const workersByHost = new Map();
  const statusCacheByKey = new Map();
  const lastFrameByKey = new Map();
  const qgaCacheByKey = new Map();
  let reqSeq = 0;

  function clearHostCaches(sshHost) {
    const prefix = `${sshHost}:`;
    for (const key of [...statusCacheByKey.keys()]) {
      if (key.startsWith(prefix)) statusCacheByKey.delete(key);
    }
    for (const key of [...lastFrameByKey.keys()]) {
      if (key.startsWith(prefix)) lastFrameByKey.delete(key);
    }
    for (const key of [...qgaCacheByKey.keys()]) {
      if (key.startsWith(prefix)) qgaCacheByKey.delete(key);
    }
  }

  function killProcessTree(proc) {
    if (!proc) return;
    if (hostPlatform === 'win32' && proc.pid) {
      try {
        const killer = spawnProcess('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer?.on?.('error', () => {});
        killer?.unref?.();
      } catch {}
    }
    try { proc.kill(); } catch {}
  }

  function teardownHostWorker(sshHost, reasonError = null) {
    const entry = workersByHost.get(sshHost);
    if (!entry) return;
    workersByHost.delete(sshHost);
    if (reasonError) {
      clearHostCaches(sshHost);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    for (const [id, pending] of entry.pending.entries()) {
      clearTimeout(pending.timer);
      entry.pending.delete(id);
      pending.reject(reasonError || new Error(`PVE SSH worker for "${sshHost}" closed.`));
    }
    try { entry.rl?.close(); } catch {}
    try { entry.proc?.stdin?.end(); } catch {}
    killProcessTree(entry.proc);
  }

  function touchHostIdle(entry) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (workerIdleMs > 0) {
      entry.idleTimer = setTimeout(() => {
        if (entry.pending.size === 0) {
          teardownHostWorker(entry.sshHost);
        } else {
          touchHostIdle(entry);
        }
      }, workerIdleMs);
      entry.idleTimer.unref?.();
    }
  }

  function ensureHostWorker(sshHost) {
    const existing = workersByHost.get(sshHost);
    if (existing && existing.proc && !existing.proc.killed && existing.proc.exitCode === null) {
      touchHostIdle(existing);
      return existing;
    }

    const args = buildSshBridgeArgs(sshHost);
    const proc = spawnProcess(sshBinary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.unref?.();

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    const entry = {
      sshHost,
      proc,
      rl,
      pending: new Map(),
      stderrTail: '',
      idleTimer: null,
    };

    proc.stderr?.on('data', (chunk) => {
      entry.stderrTail = (entry.stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      const pending = entry.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      entry.pending.delete(msg.id);
      if (entry.pending.size === 0) {
        entry.proc?.unref?.();
      }
      touchHostIdle(entry);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || `PVE QMP RPC error on ${sshHost}`));
      }
    });

    const onTermination = (detail) => {
      if (workersByHost.get(sshHost) !== entry) return;
      const errMsg = entry.stderrTail.trim()
        ? `PVE SSH connection to "${sshHost}" failed (${detail}): ${entry.stderrTail.trim()}`
        : `PVE SSH connection to "${sshHost}" closed (${detail}).`;
      teardownHostWorker(sshHost, new Error(errMsg));
    };

    proc.on('error', (err) => onTermination(err?.message || String(err)));
    proc.on('exit', (code, signal) => onTermination(`exit=${code ?? 'null'} signal=${signal ?? 'none'}`));

    workersByHost.set(sshHost, entry);
    touchHostIdle(entry);
    try {
      proc.stdin.write(REMOTE_PYTHON_BRIDGE_B64 + '\n');
    } catch (err) {
      teardownHostWorker(sshHost, err);
    }
    return entry;
  }

  function callHost(sshHost, payload, { timeoutMs = rpcTimeoutMs, signal } = {}) {
    const validHost = assertValidPveHost(sshHost);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('Aborted'));
        return;
      }
      const entry = ensureHostWorker(validHost);
      const id = ++reqSeq;
      const effectiveTimeout = Math.max(500, Math.round(Number(timeoutMs) || rpcTimeoutMs));

      const onAbort = () => {
        if (!entry.pending.has(id)) return;
        const err = signal?.reason || new Error(`PVE QMP RPC aborted on ${validHost}`);
        teardownHostWorker(validHost, err);
      };

      const timer = setTimeout(() => {
        if (!entry.pending.has(id)) return;
        const err = new Error(`PVE QMP RPC "${payload.op}" on "${validHost}" timed out after ${effectiveTimeout}ms.`);
        teardownHostWorker(validHost, err);
      }, effectiveTimeout);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      entry.proc?.ref?.();
      entry.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener?.('abort', onAbort);
          reject(err);
        },
        timer,
      });

      try {
        entry.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
      } catch (err) {
        signal?.removeEventListener?.('abort', onAbort);
        clearTimeout(timer);
        entry.pending.delete(id);
        teardownHostWorker(validHost, err);
        reject(err);
      }
    });
  }

  function resolveTargetKey(targetOrId) {
    const target = typeof targetOrId === 'string'
      ? parsePveTargetId(targetOrId, { strict: true })
      : { sshHost: assertValidPveHost(targetOrId.sshHost), vmid: assertValidPveVmid(targetOrId.vmid) };
    return { target, key: `${target.sshHost}:${target.vmid}` };
  }

  async function probeStatus(targetOrId, {
    probeResolution = false,
    forceRefresh = false,
    timeoutMs = 10_000,
    signal,
  } = {}) {
    const { target, key } = resolveTargetKey(targetOrId);
    const cached = statusCacheByKey.get(key);
    if (
      !forceRefresh &&
      statusCacheTtlMs > 0 &&
      cached &&
      nowFn() - cached.atMs < statusCacheTtlMs &&
      (!probeResolution || (cached.value?.width > 0 && cached.value?.height > 0))
    ) {
      return cached.value;
    }
    try {
      const value = await callHost(
        target.sshHost,
        { op: 'status', vmid: target.vmid, probeResolution: Boolean(probeResolution) },
        { timeoutMs, signal },
      );
      if (statusCacheTtlMs > 0) {
        statusCacheByKey.set(key, { atMs: nowFn(), value });
      }
      return value;
    } catch (err) {
      statusCacheByKey.delete(key);
      throw err;
    }
  }

  async function captureScreen(targetOrId, { timeoutMs = 12_000, forceFull = false, signal } = {}) {
    const { target, key } = resolveTargetKey(targetOrId);
    const cached = !forceFull ? lastFrameByKey.get(key) : null;
    const res = await callHost(
      target.sshHost,
      { op: 'screendump', vmid: target.vmid, ...(cached?.hash ? { lastHash: cached.hash } : {}) },
      { timeoutMs, signal },
    );
    if (res?.unchanged === true && cached && (!res.hash || res.hash === cached.hash)) {
      return {
        ...cached,
        unchanged: true,
        compressedBytes: 0,
      };
    }
    if (!res || typeof res.data !== 'string') {
      throw new Error(`Empty screendump response from ${target.sshHost}:${target.vmid}`);
    }
    const compressed = Buffer.from(res.data, 'base64');
    const ppmBuffer = res.encoding === 'ppm-gzip-base64' ? gunzipSync(compressed) : compressed;
    const image = parsePpmP6(ppmBuffer);
    const frame = {
      width: image.width,
      height: image.height,
      image,
      stageBounds: { x: 0, y: 0, width: image.width, height: image.height },
      hash: res.hash || null,
      unchanged: false,
      rawBytes: res.rawBytes ?? ppmBuffer.length,
      compressedBytes: res.compressedBytes ?? compressed.length,
    };
    if (frame.hash) {
      lastFrameByKey.set(key, frame);
    }
    return frame;
  }

  async function sendQmpSteps(targetOrId, steps, { timeoutMs = 15_000, signal } = {}) {
    const { target } = resolveTargetKey(targetOrId);
    if (!Array.isArray(steps) || steps.length === 0) {
      return { executed: 0 };
    }
    return callHost(
      target.sshHost,
      { op: 'qmp_batch', vmid: target.vmid, steps },
      { timeoutMs, signal },
    );
  }

  async function releaseAllInputs(targetOrId, { timeoutMs = 6_000, signal } = {}) {
    const steps = [
      ...['shift', 'shift_r', 'ctrl', 'ctrl_r', 'alt', 'alt_r', 'meta_l', 'meta_r'].map((q) => buildQmpKeyEventStep(q, false)),
      ...['left', 'right', 'middle'].map((b) => buildQmpButtonStep(b, false)),
    ];
    await sendQmpSteps(targetOrId, steps, { timeoutMs, signal });
    return { ok: true, released: true };
  }

  async function probeQga(targetOrId, { forceRefresh = false, timeoutMs = 6_000, signal } = {}) {
    const { target, key } = resolveTargetKey(targetOrId);
    if (!forceRefresh && qgaCacheByKey.has(key)) {
      return qgaCacheByKey.get(key);
    }
    try {
      const res = await callHost(
        target.sshHost,
        { op: 'qga_probe', vmid: target.vmid },
        { timeoutMs, signal },
      );
      const normalized = {
        available: Boolean(res?.available),
        socketExists: Boolean(res?.socketExists),
        osType: String(res?.osType || 'unknown'),
        osVersion: String(res?.osVersion || ''),
        isLegacyNt5: Boolean(res?.isLegacyNt5),
      };
      qgaCacheByKey.set(key, normalized);
      return normalized;
    } catch {
      const fallback = { available: false, socketExists: false, osType: 'unknown', osVersion: '', isLegacyNt5: false };
      qgaCacheByKey.set(key, fallback);
      return fallback;
    }
  }

  async function qgaClipboardSet(targetOrId, text, { osType, isLegacyNt5, timeoutMs = 10_000, signal } = {}) {
    const { target, key } = resolveTargetKey(targetOrId);
    const str = String(text ?? '');
    const byteLen = Buffer.byteLength(str, 'utf8');
    if (byteLen > MAX_QGA_CLIPBOARD_BYTES) {
      throw new Error(`Clipboard payload (${byteLen} bytes) exceeds 2 MiB limit.`);
    }
    const cachedQga = qgaCacheByKey.get(key) || await probeQga(target, { signal });
    if (!cachedQga.available) {
      throw Object.assign(new Error(`QEMU Guest Agent is unavailable on ${target.sshHost}:${target.vmid}.`), {
        code: 'unicode_input_unsupported',
      });
    }
    const textB64 = Buffer.from(str, 'utf8').toString('base64');
    const res = await callHost(
      target.sshHost,
      {
        op: 'qga_clipboard_set',
        vmid: target.vmid,
        textB64,
        osType: osType || cachedQga.osType || 'linux',
        isLegacyNt5: isLegacyNt5 !== undefined ? Boolean(isLegacyNt5) : Boolean(cachedQga.isLegacyNt5),
      },
      { timeoutMs, signal },
    );
    return { ok: true, length: str.length, mode: res?.mode || 'qga_guest_exec' };
  }

  async function qgaClipboardGet(targetOrId, { osType, isLegacyNt5, timeoutMs = 10_000, signal } = {}) {
    const { target, key } = resolveTargetKey(targetOrId);
    const cachedQga = qgaCacheByKey.get(key) || await probeQga(target, { signal });
    if (!cachedQga.available) {
      throw Object.assign(new Error(`QEMU Guest Agent is unavailable on ${target.sshHost}:${target.vmid}.`), {
        code: 'unicode_input_unsupported',
      });
    }
    const res = await callHost(
      target.sshHost,
      {
        op: 'qga_clipboard_get',
        vmid: target.vmid,
        osType: osType || cachedQga.osType || 'linux',
        isLegacyNt5: isLegacyNt5 !== undefined ? Boolean(isLegacyNt5) : Boolean(cachedQga.isLegacyNt5),
      },
      { timeoutMs, signal },
    );
    const text = res?.textB64 ? Buffer.from(String(res.textB64), 'base64').toString('utf8') : '';
    return { ok: true, text, mode: res?.mode || 'qga_guest_exec' };
  }

  async function disconnectHost(sshHost) {
    const host = assertValidPveHost(sshHost);
    clearHostCaches(host);
    teardownHostWorker(host);
  }

  async function dispose() {
    statusCacheByKey.clear();
    lastFrameByKey.clear();
    qgaCacheByKey.clear();
    for (const host of [...workersByHost.keys()]) {
      teardownHostWorker(host);
    }
  }

  return {
    probeStatus,
    captureScreen,
    sendQmpSteps,
    releaseAllInputs,
    probeQga,
    qgaClipboardSet,
    qgaClipboardGet,
    disconnectHost,
    dispose,
  };
}
