use serde_json::{json, Value};

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("{0}")]
    User(String),
    #[error("{0}")]
    NotFound(String),
    #[error("Database problem: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("File problem: {0}")]
    Io(#[from] std::io::Error),
    #[error("Bad request: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn user<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error::User(msg.into()))
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::User(_) => "user",
            Error::NotFound(_) => "not_found",
            Error::Db(_) => "db",
            Error::Io(_) => "io",
            Error::Json(_) => "request",
        }
    }

    pub fn to_json(&self) -> Value {
        let message = match self {
            Error::Db(rusqlite::Error::SqliteFailure(_, Some(m))) if m.contains("cannot be") => m.clone(),
            other => other.to_string(),
        };
        json!({ "code": self.code(), "message": message })
    }
}
