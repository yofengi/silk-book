use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    Encoding(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("unmappable characters: {count}, first: {first}")]
    Unmappable { count: usize, first: char },
    #[error("read cancelled")]
    Cancelled,
    #[error("{0}")]
    Channel(String),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::Json(_) => "json",
            Self::InvalidArgument(_) => "invalidArgument",
            Self::Encoding(_) => "encoding",
            Self::Unsupported(_) => "unsupported",
            Self::Unmappable { .. } => "unmappable",
            Self::Cancelled => "cancelled",
            Self::Channel(_) => "channel",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut value = serializer.serialize_struct("AppError", 2)?;
        value.serialize_field("kind", self.kind())?;
        value.serialize_field("message", &self.to_string())?;
        value.end()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
