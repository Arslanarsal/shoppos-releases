use crate::error::{user, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string()
}

pub fn check_date(d: &str) -> Result<String> {
    match chrono::NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d") {
        Ok(v) => Ok(v.format("%Y-%m-%d").to_string()),
        Err(_) => user(format!("\"{d}\" is not a valid date")),
    }
}

pub fn opt_date(d: &Option<String>) -> Result<Option<String>> {
    match d {
        Some(s) if !s.trim().is_empty() => Ok(Some(check_date(s)?)),
        _ => Ok(None),
    }
}

pub fn sha256_bytes(b: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b);
    hex(&h.finalize())
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn mul_div_round(a: i64, b: i64, c: i64) -> i64 {
    if c == 0 {
        return 0;
    }
    let n = a as i128 * b as i128;
    let d = c as i128;
    let q = n / d;
    let r = n % d;
    let adj = if (r.abs() * 2) >= d.abs() {
        if (n < 0) != (d < 0) { -1 } else { 1 }
    } else {
        0
    };
    (q + adj) as i64
}

pub fn allocate(total: i64, weights: &[i64]) -> Vec<i64> {
    let sum: i64 = weights.iter().sum();
    if sum <= 0 || total == 0 {
        return vec![0; weights.len()];
    }
    let mut out: Vec<i64> = Vec::with_capacity(weights.len());
    let mut rems: Vec<(i128, usize)> = Vec::with_capacity(weights.len());
    for (i, w) in weights.iter().enumerate() {
        let n = total as i128 * *w as i128;
        out.push((n / sum as i128) as i64);
        rems.push((n % sum as i128, i));
    }
    let mut left = total - out.iter().sum::<i64>();
    rems.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    for (_, i) in rems {
        if left <= 0 {
            break;
        }
        out[i] += 1;
        left -= 1;
    }
    out
}

pub fn safe_name(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let t = t.trim().to_string();
    if t.is_empty() { "Shop".into() } else { t.chars().take(40).collect() }
}

pub fn copy_dir_files(src: &Path, dst: &Path) -> std::io::Result<u64> {
    let mut n = 0;
    if !src.exists() {
        return Ok(0);
    }
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let p = e.path();
        let t = dst.join(e.file_name());
        if p.is_dir() {
            n += copy_dir_files(&p, &t)?;
        } else {
            std::fs::copy(&p, &t)?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rounding_and_allocation() {
        assert_eq!(mul_div_round(10, 1, 3), 3);
        assert_eq!(mul_div_round(20, 1, 3), 7);
        assert_eq!(mul_div_round(-20, 1, 3), -7);
        let a = allocate(100, &[1, 1, 1]);
        assert_eq!(a.iter().sum::<i64>(), 100);
        assert_eq!(a, vec![34, 33, 33]);
        assert_eq!(allocate(0, &[5, 5]), vec![0, 0]);
    }
}
