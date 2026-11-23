use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const PUBLIC_KEY_HEX: &str = "bcabe1808a4cbc48985617e1c774f551fcb395150e2fe5728d4905af6866d88f";

pub fn computer_code(machine_id: &str) -> String {
    let h = Sha256::digest(format!("shoppos-computer-v1:{}", machine_id.trim().to_lowercase()).as_bytes());
    let hex: String = h.iter().take(8).map(|b| format!("{b:02X}")).collect();
    hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join("-")
}

fn message(code: &str) -> Vec<u8> {
    format!("shoppos-license-v1:{}", code.trim().to_uppercase()).into_bytes()
}

fn clean_activation(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

pub fn verify_with(public_hex: &str, code: &str, activation: &str) -> bool {
    let Ok(pk) = (0..public_hex.len()).step_by(2).map(|i| u8::from_str_radix(&public_hex[i..i + 2], 16)).collect::<Result<Vec<u8>, _>>() else {
        return false;
    };
    let Ok(pk) = <[u8; 32]>::try_from(pk.as_slice()) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else { return false };
    let Ok(sig) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(clean_activation(activation)) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::try_from(sig.as_slice()) else { return false };
    key.verify(&message(code), &Signature::from_bytes(&sig)).is_ok()
}

pub fn verify(code: &str, activation: &str) -> bool {
    verify_with(PUBLIC_KEY_HEX, code, activation)
}

pub fn license_file(dir: &Path) -> PathBuf {
    dir.join("license.txt")
}

pub fn status(dir: &Path, machine_id: &str) -> Value {
    let code = computer_code(machine_id);
    let saved = std::fs::read_to_string(license_file(dir)).unwrap_or_default();
    json!({ "ok": verify(&code, &saved), "computer_code": code })
}

pub fn activate(dir: &Path, machine_id: &str, activation: &str) -> crate::error::Result<Value> {
    let code = computer_code(machine_id);
    if !verify(&code, activation) {
        return Err(crate::error::Error::User("This activation code is not for this computer. Please check it and try again, or call your developer.".into()));
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(license_file(dir), clean_activation(activation))?;
    Ok(status(dir, machine_id))
}
