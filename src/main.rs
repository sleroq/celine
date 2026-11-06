mod accounts;
mod app;
mod http;
mod library;
mod messages;
mod photo_cache;
mod photo_match;
mod telegram;

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use app::Credentials;

#[tokio::main]
async fn main() -> Result<()> {
    let credentials = Credentials::embedded();
    if credentials.is_none() {
        eprintln!(
            "Celine has no valid embedded Telegram API credentials. The web UI will explain how to rebuild; Telegram login is unavailable."
        );
    }
    let accounts = accounts::Accounts::open(data_directory()?, credentials)?;
    http::serve(accounts).await
}

fn data_directory() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("CELINE_DATA_DIR") {
        if path.is_empty() {
            bail!("CELINE_DATA_DIR must not be empty.");
        }
        return Ok(path.into());
    }
    directories::ProjectDirs::from("dev", "celine", "Celine")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .context("Cannot determine your platform data directory. Set CELINE_DATA_DIR to a writable directory.")
}
