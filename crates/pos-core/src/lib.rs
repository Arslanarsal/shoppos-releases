pub mod api;
pub mod backup;
pub mod catalog;
pub mod db;
pub mod error;
pub mod license;
pub mod reports;
pub mod search;
pub mod settings;
pub mod stock;
pub mod util;

pub use api::Core;

pub fn default_data_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("SHOPPOS_DATA_DIR") {
        if !d.trim().is_empty() {
            return d.into();
        }
    }
    #[cfg(windows)]
    {
        if let Ok(l) = std::env::var("LOCALAPPDATA") {
            return std::path::PathBuf::from(l).join("ShopPOS Data");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home).join(".local/share/ShopPOS Data")
}
