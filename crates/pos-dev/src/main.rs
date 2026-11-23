use pos_core::Core;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tiny_http::{Header, Method, Response, Server};

fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.split('?').next().unwrap_or("");
    let rel = percent_decode(rel);
    if rel.split(['/', '\\']).any(|p| p == "..") {
        return None;
    }
    Some(base.join(rel.trim_start_matches('/')))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5180);
    let data_dir = pos_core::default_data_dir();
    let dist: PathBuf = std::env::var("DIST").unwrap_or_else(|_| "dist".into()).into();
    let core = Arc::new(Core::new(&data_dir, env!("CARGO_PKG_VERSION")));
    core.open();
    {
        let core = core.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            if core.is_open() {
                let _ = core.dispatch("backup_if_due", &serde_json::Value::Null);
            }
        });
    }
    let server = Server::http(("127.0.0.1", port)).expect("port in use");
    println!("ShopPOS dev server on http://127.0.0.1:{port} data={}", data_dir.display());
    for mut req in server.incoming_requests() {
        let url = req.url().to_string();
        let json_h = Header::from_bytes("Content-Type", "application/json").unwrap();
        if let Some(cmd) = url.strip_prefix("/api/") {
            if *req.method() != Method::Post {
                let _ = req.respond(Response::from_string("POST only").with_status_code(405));
                continue;
            }
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let args: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
            let out = core.call(cmd, args);
            let _ = req.respond(Response::from_string(out.to_string()).with_header(json_h));
            continue;
        }
        let (base, rel) = match url.strip_prefix("/files/") {
            Some(r) => (data_dir.clone(), r.to_string()),
            None => (dist.clone(), url.clone()),
        };
        let mut path = match safe_join(&base, &rel) {
            Some(p) => p,
            None => {
                let _ = req.respond(Response::from_string("bad path").with_status_code(400));
                continue;
            }
        };
        if base == dist && (!path.is_file()) {
            path = dist.join("index.html");
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                let h = Header::from_bytes("Content-Type", content_type(&path)).unwrap();
                let _ = req.respond(Response::from_data(bytes).with_header(h));
            }
            Err(_) => {
                let _ = req.respond(Response::from_string("not found").with_status_code(404));
            }
        }
    }
}
