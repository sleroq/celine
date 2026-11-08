mod accounts;
mod app;
mod http;
mod library;
mod logging;
mod messages;
mod photo_cache;
mod photo_match;
mod telegram;

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use app::Credentials;

#[tokio::main]
async fn main() -> Result<()> {
    let dir = data_directory()?;
    if let Err(error) = logging::init(&dir) {
        eprintln!("Celine could not initialize file logging: {error:#}");
    }
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "Celine starting");
    let credentials = Credentials::load()?;
    if credentials.is_none() {
        tracing::warn!("Telegram API credentials are not configured");
        eprintln!(
            "Celine has no valid embedded Telegram API credentials. The web UI will explain how to rebuild; Telegram login is unavailable."
        );
    }
    let accounts = match accounts::Accounts::open(dir, credentials) {
        Ok(accounts) => accounts,
        Err(error) => {
            tracing::error!(
                io_kind = ?error.downcast_ref::<std::io::Error>().map(std::io::Error::kind),
                "Cannot open the account registry"
            );
            return Err(error);
        }
    };
    let result = http::serve(accounts).await;
    match &result {
        Ok(()) => tracing::info!("Celine stopped"),
        Err(error) => tracing::error!(
            io_kind = ?error.downcast_ref::<std::io::Error>().map(std::io::Error::kind),
            "Celine HTTP server stopped with an error"
        ),
    }
    result
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
