//! File logging for Celine's own events. Third-party events are excluded because
//! they can contain Telegram session data or raw upstream responses.
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    sync::Mutex,
};

use anyhow::{Context, Result};
use tracing::{Level, Subscriber};
use tracing_subscriber::{Layer, filter::filter_fn, layer::SubscriberExt};

pub fn init(data_dir: &Path) -> Result<()> {
    let subscriber = file_subscriber(data_dir)?;
    tracing::subscriber::set_global_default(subscriber)
        .context("Cannot initialize Celine logging")?;
    println!("Celine logs: {}", data_dir.join("celine.log").display());
    Ok(())
}

fn file_subscriber(data_dir: &Path) -> Result<impl Subscriber + Send + Sync + 'static> {
    fs::create_dir_all(data_dir).context("Cannot create Celine data directory for logging")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))?;
    }
    let file = open_log(data_dir)?;
    let layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(Mutex::new(file))
        .with_filter(filter_fn(|metadata| {
            (metadata.target() == "celine" || metadata.target().starts_with("celine::"))
                && *metadata.level() <= Level::INFO
        }));
    Ok(tracing_subscriber::registry().with(layer))
}

fn open_log(data_dir: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(data_dir.join("celine.log"))
        .context("Cannot open Celine log file")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telegram_rpc_logs_method_and_wait_without_upstream_text() {
        use grammers_client::{InvocationError, tl};
        use grammers_tl_types::Identifiable;

        let dir = tempfile::tempdir().unwrap();
        let subscriber = file_subscriber(dir.path()).unwrap();
        let method = tl::functions::photos::UpdateProfilePhoto::CONSTRUCTOR_ID;
        tracing::subscriber::with_default(subscriber, || {
            for name in ["FLOOD_WAIT", "private upstream text"] {
                let error = InvocationError::Rpc(grammers_mtsender::RpcError {
                    code: 420,
                    name: name.into(),
                    value: Some(42),
                    caused_by: Some(method),
                });
                let _ = crate::telegram::TelegramError::from(error);
            }
            let _ = crate::telegram::TelegramError::from(InvocationError::Io(
                std::io::Error::other("private connection details"),
            ));
        });
        let log = fs::read_to_string(dir.path().join("celine.log")).unwrap();
        assert!(log.contains("rpc_code=420"));
        assert!(log.contains("rpc_name=\"FLOOD_WAIT\""));
        assert!(log.contains(tl::name_for_id(method)));
        assert!(log.contains("retry_after_seconds=Some(42)"));
        assert!(log.contains("rpc_name=\"other\""));
        assert!(!log.contains("private upstream text"));
        assert!(!log.contains("private connection details"));
    }

    #[tokio::test]
    async fn api_logs_route_and_result_without_request_content() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        use tracing::instrument::WithSubscriber;

        let dir = tempfile::tempdir().unwrap();
        let subscriber = file_subscriber(dir.path()).unwrap();
        let app = crate::app::App::open(dir.path().join("account"), None).unwrap();
        async {
            let request = Request::post("/api/auth/password?private=query_secret")
                .header("host", "127.0.0.1:7766")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"password":"password_secret"}"#))
                .unwrap();
            let response = crate::http::router(app.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::BAD_GATEWAY);

            let request = Request::post("/api/photos/history/refresh")
                .header("host", "127.0.0.1:7766")
                .body(Body::empty())
                .unwrap();
            let response = crate::http::router(app.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::NO_CONTENT);

            let request = Request::get("/api/photos/private_photo_id")
                .header("host", "127.0.0.1:7766")
                .body(Body::empty())
                .unwrap();
            let response = crate::http::router(app.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);

            let request = Request::post("/api/auth/password")
                .header("host", "127.0.0.1:7766")
                .header("content-type", "application/json")
                .body(Body::from("{invalid_json_secret"))
                .unwrap();
            let response = crate::http::router(app.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);

            let request = Request::post("/api/auth/password")
                .header("host", "127.0.0.1:7766")
                .header("content-type", "application/json")
                .body(Body::from("x".repeat(12 * 1024 * 1024 + 1)))
                .unwrap();
            let response = crate::http::router(app).oneshot(request).await.unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::PAYLOAD_TOO_LARGE);
        }
        .with_subscriber(subscriber)
        .await;
        let log = fs::read_to_string(dir.path().join("celine.log")).unwrap();
        assert!(log.contains("/api/auth/password"));
        assert!(log.contains("telegram.not_connected"));
        assert!(log.contains("/api/photos/history/refresh"));
        assert!(log.contains("API request completed"));
        assert!(log.contains("/api/photos/{id}"));
        assert_eq!(log.matches("API request rejected").count(), 2);
        assert!(log.contains("status=400"));
        assert!(log.contains("status=413"));
        assert!(!log.contains("password_secret"));
        assert!(!log.contains("query_secret"));
        assert!(!log.contains("private_photo_id"));
        assert!(!log.contains("invalid_json_secret"));
    }

    #[tokio::test]
    async fn startup_logs_lock_and_invalid_registry_without_file_contents() {
        use tracing::instrument::WithSubscriber;

        let dir = tempfile::tempdir().unwrap();
        let subscriber = file_subscriber(dir.path()).unwrap();
        let data_dir = dir.path().join("data");
        async {
            let accounts = crate::accounts::Accounts::open(data_dir.clone(), None).unwrap();
            assert!(crate::accounts::Accounts::open(data_dir.clone(), None).is_err());
            drop(accounts);
            fs::write(data_dir.join("accounts.json"), "private_registry_contents").unwrap();
            assert!(crate::accounts::Accounts::open(data_dir, None).is_err());
        }
        .with_subscriber(subscriber)
        .await;
        let log = fs::read_to_string(dir.path().join("celine.log")).unwrap();
        assert!(log.contains("Cannot acquire the data-directory lock"));
        assert!(log.contains("Account registry is invalid"));
        assert!(!log.contains("private_registry_contents"));
    }

    #[test]
    fn reports_when_the_log_cannot_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let not_a_directory = dir.path().join("file");
        fs::write(&not_a_directory, "").unwrap();
        assert!(file_subscriber(&not_a_directory).is_err());
    }

    #[test]
    fn writes_and_appends_only_celine_info_events() {
        let dir = tempfile::tempdir().unwrap();
        for message in ["first event", "second event"] {
            let subscriber = file_subscriber(dir.path()).unwrap();
            tracing::subscriber::with_default(subscriber, || {
                tracing::info!(message);
                tracing::debug!("debug events are not logged");
                tracing::warn!(target: "grammers_client", "third-party data is not logged");
            });
        }
        let log = fs::read_to_string(dir.path().join("celine.log")).unwrap();
        assert!(log.contains("first event"));
        assert!(log.contains("second event"));
        assert!(!log.contains("debug events"));
        assert!(!log.contains("third-party data"));
        assert!(!log.contains('\u{1b}'));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(dir.path().join("celine.log"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
