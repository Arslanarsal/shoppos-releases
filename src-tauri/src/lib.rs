use pos_core::Core;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

struct AppCore(Arc<Core>);

#[tauri::command]
async fn call(core: State<'_, AppCore>, cmd: String, args: Value) -> Result<Value, String> {
    let c = core.0.clone();
    tauri::async_runtime::spawn_blocking(move || c.call(&cmd, args))
        .await
        .map_err(|e| e.to_string())
}

fn log_line(core: &Core, msg: &str) {
    let dir = core.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("updates.log")) {
        let _ = writeln!(f, "{} v{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), core.app_version, msg);
    }
}

#[tauri::command]
async fn update_run(app: AppHandle, core: State<'_, AppCore>) -> Result<Value, String> {
    let core = core.0.clone();
    if core.is_open() {
        return Ok(json!({ "status": "skipped", "message": "Updates are only applied at startup" }));
    }
    if std::env::var("SHOPPOS_NO_UPDATE").is_ok_and(|v| v == "1") {
        return Ok(json!({ "status": "disabled" }));
    }
    let endpoint: Option<tauri::Url> = std::env::var("SHOPPOS_UPDATE_URL").ok().and_then(|u| u.parse().ok());
    let make = |secs: u64| -> Result<tauri_plugin_updater::Updater, String> {
        let mut b = app.updater_builder().timeout(Duration::from_secs(secs));
        if let Some(u) = &endpoint {
            b = b.endpoints(vec![u.clone()]).map_err(|e| e.to_string())?;
        }
        b.build().map_err(|e| e.to_string())
    };
    let quick = match make(6) {
        Ok(u) => u,
        Err(e) => {
            log_line(&core, &format!("updater setup failed: {e}"));
            return Ok(json!({ "status": "error", "message": e }));
        }
    };
    match quick.check().await {
        Ok(Some(_)) => {}
        Ok(None) => {
            log_line(&core, "no update");
            return Ok(json!({ "status": "none" }));
        }
        Err(e) => {
            log_line(&core, &format!("update check failed: {e}"));
            return Ok(json!({ "status": "offline", "message": e.to_string() }));
        }
    }
    let update = match make(900)?.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Ok(json!({ "status": "none" })),
        Err(e) => {
            log_line(&core, &format!("update check failed: {e}"));
            return Ok(json!({ "status": "offline", "message": e.to_string() }));
        }
    };
    let version = update.version.clone();
    log_line(&core, &format!("downloading {version}"));
    let _ = app.emit("update-progress", json!({ "phase": "download", "version": version }));
    let app2 = app.clone();
    let mut got: u64 = 0;
    let res = update
        .download_and_install(
            move |chunk, total| {
                got += chunk as u64;
                let _ = app2.emit("update-progress", json!({ "phase": "download", "received": got, "total": total }));
            },
            || {},
        )
        .await;
    match res {
        Ok(()) => {
            log_line(&core, &format!("installed {version}, restarting"));
            let _ = app.emit("update-progress", json!({ "phase": "restart", "version": version }));
            app.restart();
        }
        Err(e) => {
            log_line(&core, &format!("update {version} rejected or failed: {e}"));
            Ok(json!({ "status": "failed", "version": version, "message": e.to_string() }))
        }
    }
}

fn serve_file(core: &Core, path: &str) -> Response<Vec<u8>> {
    let rel = percent_encoding::percent_decode_str(path.trim_start_matches('/')).decode_utf8_lossy().to_string();
    let rel = rel.replace('\\', "/");
    let ok_prefix = rel.starts_with("photos/") || rel.starts_with("branding/");
    if !ok_prefix || rel.split('/').any(|p| p == ".." || p.is_empty()) {
        return Response::builder().status(StatusCode::FORBIDDEN).body(Vec::new()).unwrap();
    }
    match std::fs::read(core.data_dir.join(&rel)) {
        Ok(bytes) => {
            let ct = match rel.rsplit('.').next().unwrap_or("") {
                "png" => "image/png",
                "webp" => "image/webp",
                "gif" => "image/gif",
                "bmp" => "image/bmp",
                _ => "image/jpeg",
            };
            Response::builder().header("Content-Type", ct).header("Cache-Control", "max-age=31536000, immutable").body(bytes).unwrap()
        }
        Err(_) => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = pos_core::default_data_dir();
    let core = Arc::new(Core::new(&data_dir, env!("CARGO_PKG_VERSION")));
    let for_files = core.clone();
    let for_backup = core.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppCore(core))
        .register_uri_scheme_protocol("shopfile", move |_ctx, req| serve_file(&for_files, req.uri().path()))
        .setup(move |app| {
            let c = for_backup.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(300));
                if c.is_open() {
                    let _ = c.dispatch("backup_if_due", &Value::Null);
                }
            });
            let _ = app.handle();
            Ok(())
        })
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::Destroyed = ev {
                if let Some(core) = w.app_handle().try_state::<AppCore>() {
                    core.0.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![call, update_run])
        .run(tauri::generate_context!())
        .expect("error while running ShopPOS");
}
