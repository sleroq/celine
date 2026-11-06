use serde::Serialize;
use serde_json::{Value, json};

/// Stable client translation key and interpolation values, never external error text.
#[derive(Clone, Debug, Serialize)]
pub struct MessageInfo {
    pub code: &'static str,
    pub params: Value,
}
impl MessageInfo {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            params: json!({}),
        }
    }
    pub fn parameter(code: &'static str, name: &str, value: impl Into<Value>) -> Self {
        Self {
            code,
            params: json!({name: value.into()}),
        }
    }
    pub fn from_error(error: &anyhow::Error) -> Self {
        error
            .downcast_ref::<Message>()
            .map(|message| message.info.clone())
            .unwrap_or_else(|| Self::new("error.unclassified"))
    }
}

#[derive(Debug)]
pub struct Message {
    pub info: MessageInfo,
    english: &'static str,
}
impl Message {
    pub fn new(code: &'static str, english: &'static str) -> Self {
        Self {
            info: MessageInfo::new(code),
            english,
        }
    }
}
impl std::fmt::Display for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.english)
    }
}
impl std::error::Error for Message {}

#[derive(Clone)]
pub struct LocalizedMessage {
    pub english: String,
    pub info: MessageInfo,
}
impl LocalizedMessage {
    pub fn new(english: impl Into<String>, info: MessageInfo) -> Self {
        Self {
            english: english.into(),
            info,
        }
    }
}
#[cfg(test)]
impl From<&str> for LocalizedMessage {
    fn from(english: &str) -> Self {
        Self::new(english, MessageInfo::new("error.unclassified"))
    }
}
