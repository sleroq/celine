//! Grammers 0.11 transport and native SQLite session ownership.
//!
//! Uses `grammers/session.sqlite` (0700 directory / 0600 file on Unix).
//! The parent serializes access and must not retain client clones across reset.
//! SQLite commits each awaited session mutation.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use grammers_client::{Client, SignInError, client::PasswordToken};
use grammers_mtsender::{ConnectionParams, NoRetries, SenderPool};
use grammers_session::{
    Session,
    storages::SqliteSession,
    types::{PeerAuth, PeerId, PeerInfo},
    updates::UpdatesLike,
};
use grammers_tl_types as tl;
use tokio::{sync::mpsc, task::JoinHandle};

use super::TelegramError;

const SESSION_DIRECTORY: &str = "grammers";
const SESSION_FILE: &str = "session.sqlite";

pub(super) enum Login {
    Qr { token: Vec<u8>, expires_at: u64 },
    Pending,
    Password { hint: Option<String> },
    Authorized,
}

pub(super) struct Connection {
    live: Option<Live>,
    sender: Option<JoinHandle<()>>,
    path: PathBuf,
    api_id: i32,
    api_hash: String,
    was_authorized: bool,
    login_updated: bool,
}

struct Live {
    client: Client,
    session: Arc<SqliteSession>,
    updates: mpsc::Receiver<UpdatesLike>,
}

impl Connection {
    pub(super) async fn open(
        data_dir: &Path,
        api_id: i32,
        api_hash: &str,
    ) -> Result<Self, TelegramError> {
        let path = prepare_store(data_dir)?;
        let session = Arc::new(
            SqliteSession::open(&path)
                .await
                .map_err(|_| storage_error())?,
        );
        let saved_user = session
            .peer(PeerId::self_user())
            .await
            .map_err(|_| storage_error())?;
        let was_authorized = saved_user.is_some();
        // Preserve the legacy account's identity even if its authorization was
        // revoked: QR re-login can replace SQLite, but must not reassign its library.
        if let Some(PeerInfo::User { id, .. }) = saved_user
            && !data_dir.join("identity").exists()
        {
            bind_identity(&data_dir.join("identity"), id)?;
        }
        let pool = SenderPool::with_configuration(
            Arc::clone(&session),
            api_id,
            ConnectionParams {
                device_model: "Celine".into(),
                system_version: std::env::consts::OS.into(),
                app_version: env!("CARGO_PKG_VERSION").into(),
                retry_policy: Box::new(NoRetries),
                ..Default::default()
            },
        );
        let client = Client::new(pool.handle);
        let sender = tokio::spawn(pool.runner.run());
        Ok(Self {
            live: Some(Live {
                client,
                session,
                updates: pool.updates,
            }),
            sender: Some(sender),
            path,
            api_id,
            api_hash: api_hash.into(),
            was_authorized,
            login_updated: false,
        })
    }

    pub(super) fn bind_identity(&self, id: i64) -> Result<(), TelegramError> {
        let path = self
            .path
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("identity");
        bind_identity(&path, id)
    }

    fn live(&self) -> &Live {
        self.live
            .as_ref()
            .expect("reset must succeed before using the connection")
    }

    /// Reset errors must be handled/retried before accessing the client.
    pub(super) fn client(&self) -> &Client {
        &self.live().client
    }

    pub(super) fn available_client(&self) -> Result<&Client, TelegramError> {
        self.live
            .as_ref()
            .map(|live| &live.client)
            .ok_or_else(storage_error)
    }

    pub(super) fn was_authorized(&self) -> bool {
        self.was_authorized
    }

    /// Stop and join all senders before touching the revoked session's files.
    /// On failure the connection remains stopped and reset can be retried.
    pub(super) async fn reset(&mut self) -> Result<(), TelegramError> {
        self.shutdown().await?;
        // Both Client and our Arc own the native SQLite connection. Release
        // them only after the runner and all child senders have exited.
        self.live = None;
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let path = self.path.with_file_name(format!("{SESSION_FILE}{suffix}"));
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(storage_error()),
            }
        }
        let data_dir = self
            .path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(storage_error)?;
        *self = Self::open(data_dir, self.api_id, &self.api_hash).await?;
        Ok(())
    }

    pub(super) async fn shutdown(&mut self) -> Result<(), TelegramError> {
        if let Some(live) = &self.live {
            live.client.disconnect();
        }
        if let Some(sender) = self.sender.as_mut() {
            let result = sender.await;
            self.sender = None;
            result.map_err(|_| {
                TelegramError::message(
                    "telegram.shutdown_failed",
                    "Telegram connection could not shut down cleanly.",
                )
            })?;
        }
        Ok(())
    }

    pub(super) async fn begin_qr(&mut self) -> Result<Login, TelegramError> {
        self.login_updated = false;
        self.export_qr().await
    }

    pub(super) async fn poll_qr(&mut self) -> Result<Login, TelegramError> {
        let live = self
            .live
            .as_mut()
            .expect("reset must succeed before polling");
        self.login_updated |= drain_login_updates(&mut live.updates);
        if !self.login_updated {
            return Ok(Login::Pending);
        }
        // Keep the signal on errors so a transient/flood failure can be retried.
        let result = self.export_qr().await?;
        self.login_updated = false;
        Ok(result)
    }

    async fn export_qr(&mut self) -> Result<Login, TelegramError> {
        let mut result = self
            .client()
            .invoke(&tl::functions::auth::ExportLoginToken {
                api_id: self.api_id,
                api_hash: self.api_hash.clone(),
                except_ids: Vec::new(),
            })
            .await;
        loop {
            match result {
                Err(error) if error.is("SESSION_PASSWORD_NEEDED") => {
                    let token = self.password_token().await?;
                    return Ok(Login::Password {
                        hint: token.hint().map(str::to_owned),
                    });
                }
                Err(error) => return Err(error.into()),
                Ok(tl::enums::auth::LoginToken::Token(token)) => {
                    return Ok(Login::Qr {
                        token: token.token,
                        expires_at: u64::try_from(token.expires).map_err(|_| {
                            TelegramError::message(
                                "telegram.qr_expiry_invalid",
                                "Telegram returned an invalid QR expiry.",
                            )
                        })?,
                    });
                }
                Ok(tl::enums::auth::LoginToken::MigrateTo(migration)) => {
                    // Password verification, if required, must also run in this DC.
                    self.live()
                        .session
                        .set_home_dc_id(migration.dc_id)
                        .await
                        .map_err(|_| storage_error())?;
                    result = self
                        .client()
                        .invoke(&tl::functions::auth::ImportLoginToken {
                            token: migration.token,
                        })
                        .await;
                }
                Ok(tl::enums::auth::LoginToken::Success(success)) => {
                    let tl::enums::auth::Authorization::Authorization(auth) = success.authorization
                    else {
                        return Err(TelegramError::message(
                            "telegram.account_signup_required",
                            "Create your Telegram account in the official app first.",
                        ));
                    };
                    self.persist_user(auth.user).await?;
                    self.was_authorized = true;
                    return Ok(Login::Authorized);
                }
            }
        }
    }

    async fn password_token(&self) -> Result<PasswordToken, TelegramError> {
        let password = self
            .client()
            .invoke(&tl::functions::account::GetPassword {})
            .await?;
        Ok(PasswordToken::new(password.into()))
    }

    pub(super) async fn submit_password(&mut self, password: &str) -> Result<Login, TelegramError> {
        // Fetch a fresh SRP challenge on every attempt, including retries after
        // transient failures; native check_password owns all SRP calculations.
        let token = self.password_token().await?;
        match self.client().check_password(token, password).await {
            Ok(_) => {
                // check_password awaits complete_login's native SQLite writes.
                self.was_authorized = true;
                Ok(Login::Authorized)
            }
            Err(SignInError::Other(error)) => Err(error.into()),
            Err(SignInError::InvalidPassword(_)) => Err(TelegramError::message(
                "telegram.password_incorrect",
                "Incorrect Telegram two-step verification password.",
            )),
            Err(_) => Err(TelegramError::message(
                "telegram.signin_failed",
                "Telegram could not complete sign-in. Please retry.",
            )),
        }
    }

    async fn persist_user(&self, raw: tl::enums::User) -> Result<(), TelegramError> {
        // complete_login is private in 0.11. QR success must explicitly cache
        // the authorized self user, just as that native helper does.
        let tl::enums::User::User(user) = raw else {
            return Err(TelegramError::message(
                "telegram.identity_unconfirmed",
                "Telegram could not confirm the signed-in account.",
            ));
        };
        let auth = user.access_hash.filter(|_| !user.min).ok_or_else(|| {
            TelegramError::message(
                "telegram.identity_unconfirmed",
                "Telegram could not confirm the signed-in account.",
            )
        })?;
        self.live()
            .session
            .cache_peer(PeerInfo::User {
                id: user.id,
                auth: Some(PeerAuth::from_hash(auth)),
                bot: Some(user.bot),
                is_self: Some(true),
            })
            .await
            .map_err(|_| storage_error())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Normal asynchronous teardown should call shutdown to join. Dropping
        // only signals quit; the runner then joins its child senders itself.
        if let Some(live) = &self.live {
            live.client.disconnect();
        }
    }
}

fn bind_identity(path: &Path, id: i64) -> Result<(), TelegramError> {
    match fs::read_to_string(path) {
        Ok(saved) if saved != id.to_string() => {
            return Err(TelegramError {
                info: crate::messages::MessageInfo::new("telegram.account_identity_mismatch"),
                message:
                    "This account belongs to another Telegram user. Log out and add a new account."
                        .into(),
                retry_after: None,
                unauthorized: true,
            });
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(storage_error()),
    }
    fs::write(path, id.to_string()).map_err(|_| storage_error())
}

fn drain_login_updates(receiver: &mut mpsc::Receiver<UpdatesLike>) -> bool {
    let mut found = false;
    while let Ok(update) = receiver.try_recv() {
        let updates = match update {
            UpdatesLike::ConnectionClosed => {
                // The next export reconnects and checks whether the code was accepted.
                found = true;
                continue;
            }
            UpdatesLike::Updates(updates) => updates,
            _ => continue,
        };
        found |= match updates {
            tl::enums::Updates::UpdateShort(short) => {
                matches!(short.update, tl::enums::Update::LoginToken)
            }
            tl::enums::Updates::Updates(updates) => updates
                .updates
                .iter()
                .any(|u| matches!(u, tl::enums::Update::LoginToken)),
            tl::enums::Updates::Combined(updates) => updates
                .updates
                .iter()
                .any(|u| matches!(u, tl::enums::Update::LoginToken)),
            _ => false,
        };
    }
    found
}

fn storage_error() -> TelegramError {
    TelegramError::message(
        "telegram.session_storage_failed",
        "Cannot read or save the local Telegram session.",
    )
}

fn prepare_store(data_dir: &Path) -> Result<PathBuf, TelegramError> {
    let directory = data_dir.join(SESSION_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|_| storage_error())?;
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| storage_error())?;
    let path = directory.join(SESSION_FILE);
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(&path).map_err(|_| storage_error())?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| storage_error())?;
    drop(file);
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn account_identity_is_bound_before_reusing_saved_settings() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = Connection::open(dir.path(), 1, "test").await.unwrap();
        connection.bind_identity(123).unwrap();
        connection.bind_identity(123).unwrap();
        assert!(connection.bind_identity(456).unwrap_err().unauthorized);
        assert_eq!(
            fs::read_to_string(dir.path().join("identity")).unwrap(),
            "123"
        );
        // A rejected QR login can already have cached the wrong user. Reopening
        // must still allow reset/logout, without rebinding the existing library.
        connection
            .live()
            .session
            .cache_peer(PeerInfo::User {
                id: 456,
                auth: Some(PeerAuth::from_hash(789)),
                bot: Some(false),
                is_self: Some(true),
            })
            .await
            .unwrap();
        connection.shutdown().await.unwrap();
        drop(connection);
        let mut connection = Connection::open(dir.path(), 1, "test").await.unwrap();
        assert!(connection.bind_identity(456).unwrap_err().unauthorized);
        connection.reset().await.unwrap();
        connection.bind_identity(123).unwrap();
        connection.shutdown().await.unwrap();
    }

    #[test]
    fn login_token_updates_are_detected_and_receiver_is_drained() {
        let (sender, mut receiver) = mpsc::channel(8);
        sender
            .try_send(UpdatesLike::Updates(tl::enums::Updates::UpdateShort(
                tl::types::UpdateShort {
                    update: tl::enums::Update::LoginToken,
                    date: 1,
                },
            )))
            .unwrap();
        sender.try_send(UpdatesLike::ConnectionClosed).unwrap();
        assert!(drain_login_updates(&mut receiver));
        assert!(!drain_login_updates(&mut receiver));

        sender
            .try_send(UpdatesLike::Updates(tl::enums::Updates::Updates(
                tl::types::Updates {
                    updates: vec![tl::enums::Update::LoginToken],
                    users: vec![],
                    chats: vec![],
                    date: 1,
                    seq: 1,
                },
            )))
            .unwrap();
        assert!(drain_login_updates(&mut receiver));
        sender
            .try_send(UpdatesLike::Updates(tl::enums::Updates::Combined(
                tl::types::UpdatesCombined {
                    updates: vec![tl::enums::Update::LoginToken],
                    users: vec![],
                    chats: vec![],
                    date: 1,
                    seq_start: 1,
                    seq: 1,
                },
            )))
            .unwrap();
        assert!(drain_login_updates(&mut receiver));
    }

    #[test]
    fn unrelated_updates_do_not_trigger_qr_export() {
        let (sender, mut receiver) = mpsc::channel(8);
        sender.try_send(UpdatesLike::MalformedUpdates).unwrap();
        sender
            .try_send(UpdatesLike::Updates(tl::enums::Updates::TooLong))
            .unwrap();
        sender
            .try_send(UpdatesLike::Updates(tl::enums::Updates::UpdateShort(
                tl::types::UpdateShort {
                    update: tl::enums::Update::PtsChanged,
                    date: 1,
                },
            )))
            .unwrap();
        assert!(!drain_login_updates(&mut receiver));
        assert!(receiver.is_empty());
        sender.try_send(UpdatesLike::ConnectionClosed).unwrap();
        assert!(drain_login_updates(&mut receiver));
    }

    #[tokio::test]
    async fn poll_without_login_update_does_not_invoke_telegram() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = Connection::open(directory.path(), 1, "unused")
            .await
            .unwrap();
        // A stopped sender would make any accidental invocation return Dropped.
        connection.shutdown().await.unwrap();
        assert!(matches!(
            connection.poll_qr().await.unwrap(),
            Login::Pending
        ));
    }

    #[tokio::test]
    async fn login_update_is_retried_after_connection_failure() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = Connection::open(directory.path(), 1, "unused")
            .await
            .unwrap();
        connection.shutdown().await.unwrap();
        let (sender, receiver) = mpsc::channel(1);
        connection.live.as_mut().unwrap().updates = receiver;
        sender.try_send(UpdatesLike::ConnectionClosed).unwrap();
        assert!(connection.poll_qr().await.is_err());
        assert!(connection.login_updated);
        assert!(connection.poll_qr().await.is_err());
    }

    #[tokio::test]
    async fn failed_reset_can_be_retried() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = Connection::open(directory.path(), 1, "unused")
            .await
            .unwrap();
        let journal = connection
            .path
            .with_file_name(format!("{SESSION_FILE}-journal"));
        // A directory at the sidecar path deterministically makes deletion fail.
        fs::create_dir(&journal).unwrap();
        assert!(connection.reset().await.is_err());
        assert!(connection.live.is_none());
        assert!(connection.sender.is_none());
        fs::remove_dir(journal).unwrap();
        connection.reset().await.unwrap();
        assert!(connection.live.is_some());
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn logout_after_failed_authorized_reset_returns_error() {
        let (_directory, mut telegram) = super::super::tests::offline_telegram().await;
        telegram.connection.was_authorized = true;
        let journal = telegram
            .connection
            .path
            .with_file_name(format!("{SESSION_FILE}-journal"));
        fs::create_dir(&journal).unwrap();
        assert!(telegram.connection.reset().await.is_err());
        assert_eq!(
            telegram.logout().await.unwrap_err().info.code,
            "telegram.session_storage_failed"
        );
        fs::remove_dir(journal).unwrap();
        telegram.connection.reset().await.unwrap();
        telegram.connection.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn session_is_private_and_preserves_native_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = prepare_store(directory.path()).unwrap();
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::write(&path, b"existing native session").unwrap();
        prepare_store(directory.path()).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"existing native session");
    }

    #[tokio::test]
    async fn native_session_survives_reopen_and_reset_replaces_it() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = Connection::open(directory.path(), 1, "unused")
            .await
            .unwrap();
        assert!(!connection.was_authorized());
        // Bare native User with both flags words and id zero, then fill the
        // fields returned in QR authorization. Exercise the actual QR save path.
        use tl::Deserializable;
        let mut user = tl::types::User::from_bytes(&[0; 16]).unwrap();
        user.id = 42;
        user.is_self = true;
        user.access_hash = Some(123);
        connection
            .persist_user(tl::enums::User::User(user))
            .await
            .unwrap();
        connection.shutdown().await.unwrap();
        drop(connection);

        let mut connection = Connection::open(directory.path(), 1, "unused")
            .await
            .unwrap();
        assert!(connection.was_authorized());
        // A legacy session has no identity file until reopen. This binding must
        // survive reset, before any network verification or new QR sign-in.
        assert_eq!(
            fs::read_to_string(directory.path().join("identity")).unwrap(),
            "42"
        );
        connection.reset().await.unwrap();
        assert!(connection.bind_identity(99).unwrap_err().unauthorized);
        assert!(!connection.was_authorized());
        assert!(
            connection
                .live()
                .session
                .peer(PeerId::self_user())
                .await
                .unwrap()
                .is_none()
        );
        connection.shutdown().await.unwrap();
    }
}
