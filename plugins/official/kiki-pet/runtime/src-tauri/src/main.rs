use std::{io::{self, BufRead, Read, Write}, sync::Mutex, path::PathBuf};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State, WebviewWindowBuilder, WebviewUrl};

struct PetState(Mutex<Value>);
fn send(value: Value) {
    let mut out = io::stdout().lock();
    if writeln!(out, "{value}").is_err() { std::process::exit(0); }
    let _ = out.flush();
}

#[tauri::command]
fn pet_snapshot(state: State<PetState>) -> Value { state.0.lock().unwrap().clone() }
#[tauri::command]
fn pet_heartbeat() { send(json!({"type":"heartbeat"})); }
#[tauri::command]
fn pet_dispatch(action: String, args: Option<Value>) -> Result<(), String> {
    if !["settings", "action", "say", "stop", "focus"].contains(&action.as_str()) { return Err("Unsupported pet action".into()); }
    let args = args.unwrap_or(json!({}));
    if args.to_string().len() > 2048 { return Err("Pet action is too large".into()); }
    send(json!({"type":"dispatch","action":action,"args":args}));
    Ok(())
}
#[tauri::command]
fn pet_resize(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() { return Err("Invalid size".into()); }
    window.set_size(tauri::LogicalSize::new(width.clamp(120.0, 700.0), height.clamp(120.0, 800.0))).map_err(|e|e.to_string())
}
#[tauri::command]
fn pet_move(window: tauri::WebviewWindow, dx: f64, dy: f64) -> Result<(), String> {
    if !dx.is_finite() || !dy.is_finite() { return Err("Invalid motion".into()); }
    let position = window.outer_position().map_err(|e|e.to_string())?;
    let size = window.outer_size().map_err(|e|e.to_string())?;
    let monitor = window.current_monitor().map_err(|e|e.to_string())?.ok_or("No current monitor")?;
    let area = monitor.work_area();
    let x = (position.x + dx.clamp(-24.0, 24.0) as i32).clamp(area.position.x, (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x));
    let y = (position.y + dy.clamp(-24.0, 24.0) as i32).clamp(area.position.y, (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y));
    window.set_position(tauri::PhysicalPosition::new(x,y)).map_err(|e|e.to_string())
}

fn decode_image() -> Result<(), String> {
    let mut bytes = Vec::new();
    io::stdin().take(12 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len() > 12 * 1024 * 1024 { return Err("Image exceeds 12 MiB".into()); }
    let mut reader = image::ImageReader::new(io::Cursor::new(bytes)).with_guessed_format().map_err(|e|e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(80 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|e|format!("Invalid image: {e}"))?;
    if img.width() as u64 * img.height() as u64 > 8_000_000 { return Err("Image exceeds 8 megapixels".into()); }
    send(json!({"width":img.width(),"height":img.height()}));
    Ok(())
}

fn main() {
    if std::env::args().any(|a|a == "--validate-image") {
        if let Err(error) = decode_image() { eprintln!("{error}"); std::process::exit(2); }
        return;
    }
    let data_dir = std::env::var_os("KIKI_PET_DATA_DIR").map(PathBuf::from).expect("Pet must be launched by its owning plugin");
    tauri::Builder::default()
        .manage(PetState(Mutex::new(Value::Null)))
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("index.html".into()))
                .title("Kiki Pet").inner_size(340.0,340.0).resizable(false).decorations(false)
                .transparent(true).always_on_top(true).skip_taskbar(true).shadow(false)
                .data_directory(data_dir.join("webview")).build()?;
            if let Some(monitor) = window.current_monitor()? {
                let area = monitor.work_area();
                let size = window.outer_size()?;
                window.set_position(tauri::PhysicalPosition::new(area.position.x + area.size.width as i32 - size.width as i32 - 32, area.position.y + area.size.height as i32 - size.height as i32 - 24))?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut input = io::BufReader::new(io::stdin());
                loop {
                    let mut line = Vec::new();
                    let read = input.by_ref().take(16 * 1024 * 1024).read_until(b'\n', &mut line);
                    if !matches!(read, Ok(n) if n > 0) || line.len() >= 16 * 1024 * 1024 { break; }
                    let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue; };
                    match message["type"].as_str() {
                        Some("state") => {
                            let state = message["state"].clone();
                            let owner = handle.state::<PetState>();
                            let mut stored = owner.0.lock().unwrap();
                            let mut cached = state.clone();
                            if cached["activePet"]["spriteUrl"].is_null() && stored["activePet"]["id"] == cached["activePet"]["id"] && stored["activePet"]["provenance"]["sha256"] == cached["activePet"]["provenance"]["sha256"] {
                                cached["activePet"]["spriteUrl"] = stored["activePet"]["spriteUrl"].clone();
                            }
                            *stored = cached;
                            drop(stored);
                            let _ = handle.emit("pet-state", state);
                        }
                        Some("shutdown") => break,
                        _ => ()
                    }
                }
                handle.exit(0);
            });
            send(json!({"type":"ready","protocol":1}));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pet_snapshot,pet_heartbeat,pet_dispatch,pet_resize,pet_move])
        .run(tauri::generate_context!())
        .expect("Pet window failed");
}
