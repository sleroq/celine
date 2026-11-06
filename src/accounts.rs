use crate::messages::Message;
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::{sync::Mutex, task::JoinHandle};

use crate::app::{App, Credentials};

#[derive(Serialize, Deserialize)]
struct Registry {
    active_account_id: String,
    accounts: Vec<String>,
}
struct Account {
    app: Arc<App>,
    worker: JoinHandle<()>,
}
struct Inner {
    registry: Registry,
    accounts: BTreeMap<String, Account>,
}
pub struct Accounts {
    dir: PathBuf,
    credentials: Option<Credentials>,
    inner: Mutex<Inner>,
    _lock: fs::File,
}
impl Accounts {
    pub fn open(dir: PathBuf, credentials: Option<Credentials>) -> Result<Arc<Self>> {
        fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("celine.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .context("Celine is already using this data directory")?;
        let registry = match fs::read(dir.join("accounts.json")) {
            Ok(bytes) => serde_json::from_slice::<Registry>(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A fixed migration destination lets an interrupted migration resume.
                let id = "legacy".to_owned();
                let target = dir.join("accounts").join(&id);
                fs::create_dir_all(&target)?;
                for name in ["grammers", "library.json", "photos", "identity"] {
                    let source = dir.join(name);
                    if source.exists() {
                        fs::rename(source, target.join(name))?;
                    }
                }
                Registry {
                    active_account_id: id.clone(),
                    accounts: vec![id],
                }
            }
            Err(error) => return Err(error.into()),
        };
        if registry.accounts.is_empty() || !registry.accounts.contains(&registry.active_account_id)
        {
            bail!("Invalid account registry: active account is missing.");
        }
        let mut accounts = BTreeMap::new();
        for id in &registry.accounts {
            if id != "legacy" && uuid::Uuid::parse_str(id).is_err() {
                bail!("Invalid account id in registry");
            }
            let app = App::open(dir.join("accounts").join(id), credentials)?;
            let worker = tokio::spawn(app.clone().run());
            accounts.insert(id.clone(), Account { app, worker });
        }
        let inner = Inner { registry, accounts };
        Self::persist(&dir, &inner.registry)?;
        Ok(Arc::new(Self {
            dir,
            credentials,
            inner: Mutex::new(inner),
            _lock: lock,
        }))
    }
    fn persist(dir: &std::path::Path, registry: &Registry) -> Result<()> {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        file.write_all(&serde_json::to_vec_pretty(registry)?)?;
        file.as_file().sync_all()?;
        file.persist(dir.join("accounts.json"))?;
        Ok(())
    }
    pub async fn app(&self, id: Option<&str>) -> Option<(String, Arc<App>)> {
        let inner = self.inner.lock().await;
        let id = id.unwrap_or(&inner.registry.active_account_id);
        inner
            .accounts
            .get(id)
            .map(|account| (id.to_owned(), account.app.clone()))
    }
    pub async fn state(&self) -> serde_json::Value {
        let inner = self.inner.lock().await;
        let mut summaries = Vec::new();
        let mut active = serde_json::Value::Null;
        for (id, account) in &inner.accounts {
            let mut state = serde_json::to_value(account.app.state().await).unwrap();
            scope_media(&mut state, id);
            summaries.push(
                serde_json::json!({"id":id,"auth":state["auth"],"profile":state["profile"],
                "pending": self.pending(id)}),
            );
            if id == &inner.registry.active_account_id {
                active = state;
            }
        }
        active["active_account_id"] = inner.registry.active_account_id.clone().into();
        active["accounts"] = summaries.into();
        active
    }
    fn pending(&self, id: &str) -> bool {
        !self.dir.join("accounts").join(id).join("identity").exists()
    }
    pub async fn create(&self) -> Result<()> {
        let mut inner = self.inner.lock().await;
        if inner.registry.accounts.iter().any(|id| self.pending(id)) {
            bail!(Message::new(
                "account.pending_signin",
                "Finish signing in to the new account before adding another."
            ));
        }
        self.add(&mut inner)
    }
    fn add(&self, inner: &mut Inner) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let app = App::open(self.dir.join("accounts").join(&id), self.credentials)?;
        let mut registry = Registry {
            active_account_id: id.clone(),
            accounts: inner.registry.accounts.clone(),
        };
        registry.accounts.push(id.clone());
        Self::persist(&self.dir, &registry)?;
        let worker = tokio::spawn(app.clone().run());
        inner.accounts.insert(id, Account { app, worker });
        inner.registry = registry;
        Ok(())
    }
    pub async fn activate(&self, id: &str) -> Result<()> {
        let mut inner = self.inner.lock().await;
        if !inner.accounts.contains_key(id) {
            bail!(Message::new("account.not_found", "Account not found."));
        }
        let registry = Registry {
            active_account_id: id.into(),
            accounts: inner.registry.accounts.clone(),
        };
        Self::persist(&self.dir, &registry)?;
        inner.registry = registry;
        Ok(())
    }
    pub async fn remove(&self, id: &str) -> Result<()> {
        let mut inner = self.inner.lock().await;
        let account = inner
            .accounts
            .get(id)
            .context(Message::new("account.not_found", "Account not found."))?;
        let mut registry = Registry {
            active_account_id: inner.registry.active_account_id.clone(),
            accounts: inner
                .registry
                .accounts
                .iter()
                .filter(|saved| saved.as_str() != id)
                .cloned()
                .collect(),
        };
        let replacement = if registry.accounts.is_empty() {
            let id = uuid::Uuid::new_v4().to_string();
            let app = App::open(self.dir.join("accounts").join(&id), self.credentials)?;
            registry.accounts.push(id.clone());
            Some((id, app))
        } else {
            None
        };
        if registry.active_account_id == id {
            registry.active_account_id = registry.accounts[0].clone();
        }
        account.app.logout().await?;
        Self::persist(&self.dir, &registry)?;
        account.worker.abort();
        account.app.disconnect().await;
        inner.accounts.remove(id);
        if let Some((id, app)) = replacement {
            let worker = tokio::spawn(app.clone().run());
            inner.accounts.insert(id, Account { app, worker });
        }
        inner.registry = registry;
        Ok(())
    }
}
impl Drop for Accounts {
    fn drop(&mut self) {
        for account in self.inner.get_mut().accounts.values() {
            account.worker.abort();
        }
    }
}
pub fn scope_media(value: &mut serde_json::Value, id: &str) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                scope_media(value, id);
            }
        }
        serde_json::Value::Object(values) => {
            for (field, value) in values {
                if matches!(
                    field.as_str(),
                    "photo_url" | "media_url" | "cover_url" | "thumbnail_url"
                ) {
                    if let Some(url) = value.as_str().and_then(|url| url.strip_prefix("/api/"))
                        && !url.starts_with("accounts/")
                    {
                        *value = format!("/api/accounts/{id}/{url}").into();
                    }
                } else {
                    scope_media(value, id);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{library::Settings, telegram::TelegramError};

    #[test]
    fn scopes_only_media_urls_and_preserves_user_text() {
        let mut state = serde_json::json!({
            "profile": { "name": "/api/Alice", "photo_url": "/api/profile/photo?v=42",
                "emoji": { "label": "/api/star", "media_url": "/api/emojis/100/media" } },
            "photos": [{ "name": "/api/portrait.jpg" }],
            "choices": [{ "thumbnail_url": "/api/emojis/100/thumbnail" }],
            "sets": [{ "title": "/api/pack", "cover_url": "/api/emojis/sets/200/cover" }],
            "error": "/api/missing"
        });
        scope_media(&mut state, "personal");
        assert_eq!(state["profile"]["name"], "/api/Alice");
        assert_eq!(
            state["profile"]["photo_url"],
            "/api/accounts/personal/profile/photo?v=42"
        );
        assert_eq!(state["profile"]["emoji"]["label"], "/api/star");
        assert_eq!(
            state["profile"]["emoji"]["media_url"],
            "/api/accounts/personal/emojis/100/media"
        );
        assert_eq!(state["photos"][0]["name"], "/api/portrait.jpg");
        assert_eq!(
            state["choices"][0]["thumbnail_url"],
            "/api/accounts/personal/emojis/100/thumbnail"
        );
        assert_eq!(state["sets"][0]["title"], "/api/pack");
        assert_eq!(
            state["sets"][0]["cover_url"],
            "/api/accounts/personal/emojis/sets/200/cover"
        );
        assert_eq!(state["error"], "/api/missing");
        let scoped = state.clone();
        scope_media(&mut state, "personal");
        assert_eq!(state, scoped);
    }

    #[tokio::test]
    async fn accounts_isolate_data_cooldowns_and_restore_selection() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = Accounts::open(dir.path().into(), None).unwrap();
        assert!(Accounts::open(dir.path().into(), None).is_err());
        let (first, first_app) = accounts.app(None).await.unwrap();
        let settings = Settings {
            interval_secs: 42,
            ..Settings::default()
        };
        first_app.update_settings(settings).await.unwrap();
        first_app
            .repository
            .lock()
            .await
            .add_upload("First", b"jpeg", b"jpeg", None, true)
            .unwrap();
        first_app
            .record_telegram_error(&TelegramError {
                info: crate::messages::MessageInfo::new("error.unclassified"),
                message: "Wait".into(),
                retry_after: Some(60),
                unauthorized: false,
            })
            .await;
        fs::write(
            dir.path().join("accounts").join(&first).join("identity"),
            "123",
        )
        .unwrap();
        accounts.create().await.unwrap();
        let (second, second_app) = accounts.app(None).await.unwrap();
        assert_ne!(first, second);
        let state = second_app.state().await;
        assert!(state.library.photos.is_empty());
        assert!(state.library.telegram_not_before.is_none());
        assert_eq!(state.library.settings.interval_secs, 3600);
        accounts.activate(&first).await.unwrap();
        assert_eq!(accounts.state().await["active_account_id"], first);
        accounts.activate(&second).await.unwrap();
        accounts.remove(&second).await.unwrap();
        assert!(accounts.app(Some(&second)).await.is_none());
        assert_eq!(first_app.state().await.library.photos.len(), 1);
        assert!(accounts.activate("missing").await.is_err());
        drop(first_app);
        drop(second_app);
        drop(accounts);
        tokio::task::yield_now().await;
        let restored = Accounts::open(dir.path().into(), None).unwrap();
        let (id, app) = restored.app(None).await.unwrap();
        assert_eq!(id, first);
        let state = app.state().await;
        assert_eq!(state.library.settings.interval_secs, 42);
        assert_eq!(state.library.photos.len(), 1);
        assert!(state.library.telegram_not_before.is_some());
    }

    #[tokio::test]
    async fn cannot_add_another_account_until_the_new_one_signs_in() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = Accounts::open(dir.path().into(), None).unwrap();
        let (first, _) = accounts.app(None).await.unwrap();
        assert!(accounts.create().await.is_err());
        fs::write(
            dir.path().join("accounts").join(&first).join("identity"),
            "123",
        )
        .unwrap();
        accounts.create().await.unwrap();
        let (pending, _) = accounts.app(None).await.unwrap();
        assert_eq!(
            accounts.state().await["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|account| account["id"] == pending)
                .unwrap()["pending"],
            true
        );
        accounts.activate(&first).await.unwrap();
        assert!(accounts.create().await.is_err());
        fs::write(
            dir.path().join("accounts").join(&pending).join("identity"),
            "456",
        )
        .unwrap();
        accounts.create().await.unwrap();
    }

    #[tokio::test]
    async fn failed_removal_keeps_the_registered_account_worker_running() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = Accounts::open(dir.path().into(), None).unwrap();
        let (id, _) = accounts.app(None).await.unwrap();
        {
            let mut inner = accounts.inner.lock().await;
            let account = inner.accounts.get_mut(&id).unwrap();
            account.worker.abort();
            account.worker = tokio::spawn(std::future::pending());
        }
        // A directory at the atomic replacement destination makes persistence fail.
        fs::remove_file(dir.path().join("accounts.json")).unwrap();
        fs::create_dir(dir.path().join("accounts.json")).unwrap();
        assert!(accounts.remove(&id).await.is_err());
        let inner = accounts.inner.lock().await;
        assert!(inner.registry.accounts.contains(&id));
        assert!(!inner.accounts[&id].worker.is_finished());
    }

    #[tokio::test]
    async fn deleting_last_blank_account_replaces_it_and_retains_disk_data() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = Accounts::open(dir.path().into(), None).unwrap();
        let (old, app) = accounts.app(None).await.unwrap();
        app.repository
            .lock()
            .await
            .add_upload("Saved", b"jpeg", b"jpeg", None, true)
            .unwrap();
        accounts.remove(&old).await.unwrap();
        let state = accounts.state().await;
        assert_eq!(state["accounts"].as_array().unwrap().len(), 1);
        assert_ne!(state["active_account_id"], old);
        assert!(state["photos"].as_array().unwrap().is_empty());
        assert!(
            dir.path()
                .join("accounts")
                .join(old)
                .join("library.json")
                .exists()
        );
    }

    #[tokio::test]
    async fn migrates_legacy_data_and_refuses_to_fake_logout_without_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = App::open(dir.path().into(), None).unwrap();
        legacy
            .repository
            .lock()
            .await
            .add_upload("Legacy", b"jpeg", b"jpeg", None, true)
            .unwrap();
        drop(legacy);
        fs::create_dir(dir.path().join("grammers")).unwrap();
        fs::write(
            dir.path().join("grammers/session.sqlite"),
            b"session sentinel",
        )
        .unwrap();
        let accounts = Accounts::open(dir.path().into(), None).unwrap();
        let (id, app) = accounts.app(None).await.unwrap();
        assert_eq!(id, "legacy");
        assert_eq!(app.state().await.library.photos[0].name, "Legacy");
        assert_eq!(
            fs::read(dir.path().join("accounts/legacy/grammers/session.sqlite")).unwrap(),
            b"session sentinel"
        );
        assert!(accounts.remove(&id).await.is_err());
        assert!(accounts.app(Some(&id)).await.is_some());
    }
}
