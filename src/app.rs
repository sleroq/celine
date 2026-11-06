use crate::messages::{LocalizedMessage, Message, MessageInfo};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::sync::{Mutex, MutexGuard, RwLock};

use crate::{
    library::{Library, Photo, Repository, Settings},
    telegram::{AuthState, EmojiChoice, Profile, Telegram, TelegramError},
};

trait PhotoClient {
    async fn current_photo(&mut self) -> Result<Option<(String, Vec<u8>)>, TelegramError>;
    async fn use_history_photo(&mut self, id: &str) -> Result<bool, TelegramError>;
    async fn matching_photo(&mut self, jpeg: &[u8]) -> Result<Option<String>, TelegramError>;
    async fn set_photo(&mut self, path: &std::path::Path) -> Result<String, TelegramError>;
}

impl PhotoClient for Telegram {
    async fn current_photo(&mut self) -> Result<Option<(String, Vec<u8>)>, TelegramError> {
        Telegram::current_photo(self).await
    }
    async fn use_history_photo(&mut self, id: &str) -> Result<bool, TelegramError> {
        Telegram::use_history_photo(self, id).await
    }
    async fn matching_photo(&mut self, jpeg: &[u8]) -> Result<Option<String>, TelegramError> {
        Telegram::matching_photo(self, jpeg).await
    }
    async fn set_photo(&mut self, path: &std::path::Path) -> Result<String, TelegramError> {
        Telegram::set_photo(self, path).await
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Copy)]
pub struct Credentials {
    pub id: i32,
    pub hash: &'static str,
}
impl Credentials {
    pub fn embedded() -> Option<Self> {
        let id = option_env!("CELINE_API_ID")?
            .parse::<i32>()
            .ok()
            .filter(|id| *id > 0)?;
        let hash = option_env!("CELINE_API_HASH")?;
        (hash.len() == 32 && hash.bytes().all(|c| c.is_ascii_hexdigit()))
            .then_some(Self { id, hash })
    }
}

#[derive(Serialize)]
pub struct State {
    pub auth: AuthState,
    pub profile: Option<Profile>,
    #[serde(flatten)]
    pub library: Library,
    pub selected_emoji_ids: Vec<String>,
    pub current_photo_id: Option<String>,
    pub last_error: Option<String>,
    pub last_error_info: Option<MessageInfo>,
}

#[derive(Clone, Copy)]
pub enum ScheduleAction {
    Apply,
    Start,
    Stop,
}

pub struct App {
    pub repository: Mutex<Repository>,
    telegram: Mutex<Option<Telegram>>,
    pub auth: RwLock<AuthState>,
    profile: RwLock<Option<Profile>>,
    pub choices: Mutex<Vec<EmojiChoice>>,
    pub last_error: RwLock<Option<LocalizedMessage>>,
    photo_error: RwLock<Option<LocalizedMessage>>,
    emoji_error: RwLock<Option<LocalizedMessage>>,
    credentials: Option<Credentials>,
    dir: PathBuf,
}
impl App {
    pub fn open(dir: PathBuf, credentials: Option<Credentials>) -> Result<Arc<Self>> {
        let repository = Repository::open(dir.clone())?;
        let choices = repository.data.selected_emojis.clone();
        let auth = AuthState {
            message_info: Some(MessageInfo::new(if credentials.is_some() { "auth.connecting" } else { "auth.unconfigured" })),
            status: if credentials.is_some() { "disconnected" } else { "unconfigured" }.into(),
            qr_svg: None, expires_at: None, name: None, premium: false,
            message: Some(if credentials.is_some() { "Connecting to Telegram…" } else { "This binary has no valid Telegram application credentials. Rebuild with CELINE_API_ID and CELINE_API_HASH." }.into()),
        };
        Ok(Arc::new(Self {
            repository: Mutex::new(repository),
            telegram: Mutex::new(None),
            auth: RwLock::new(auth),
            profile: RwLock::new(None),
            choices: Mutex::new(choices),
            last_error: RwLock::new(None),
            photo_error: RwLock::new(None),
            emoji_error: RwLock::new(None),
            credentials,
            dir,
        }))
    }
    pub async fn logout(&self) -> Result<(), TelegramError> {
        let mut connection = self.connection().await?;
        if let Some(telegram) = connection.as_mut() {
            telegram.logout().await?;
        } else if let Some(credentials) = self.credentials {
            let mut telegram =
                Telegram::connect(&self.dir, credentials.id, credentials.hash).await?;
            telegram.logout().await?;
        }
        if self.credentials.is_none() && self.dir.join("grammers/session.sqlite").exists() {
            return Err(unavailable());
        }
        *connection = None;
        {
            let mut auth = self.auth.write().await;
            auth.status = "disconnected".into();
            auth.qr_svg = None;
            auth.expires_at = None;
            auth.message = None;
            auth.message_info = None;
        }
        *self.profile.write().await = None;
        Ok(())
    }
    pub async fn disconnect(&self) {
        *self.telegram.lock().await = None;
    }
    pub async fn state(&self) -> State {
        let auth = self.auth.read().await.clone();
        let library = self.repository.lock().await.data.clone();
        let selected_emoji_ids = library
            .selected_emojis
            .iter()
            .map(|choice| choice.id.clone())
            .collect();
        let last_error = self
            .last_error
            .read()
            .await
            .clone()
            .or(self.photo_error.read().await.clone())
            .or(self.emoji_error.read().await.clone());
        State {
            auth,
            profile: self.profile.read().await.clone(),
            current_photo_id: library
                .applied_settings
                .as_ref()
                .and(library.last_photo_id.clone()),
            library,
            selected_emoji_ids,
            last_error: last_error.as_ref().map(|message| message.english.clone()),
            last_error_info: last_error.map(|message| message.info),
        }
    }
    pub async fn update_settings(&self, mut settings: Settings) -> Result<()> {
        settings.validate()?;
        self.repository.lock().await.update(|library| {
            settings.enabled = library.settings.enabled;
            library.settings = settings;
            Ok(())
        })?;
        *self.photo_error.write().await = None;
        Ok(())
    }
    pub async fn update_emoji_settings(&self, mut settings: Settings) -> Result<()> {
        settings.validate()?;
        self.repository.lock().await.update(|library| {
            settings.enabled = library.emoji_settings.enabled;
            library.emoji_settings = settings;
            Ok(())
        })?;
        *self.emoji_error.write().await = None;
        Ok(())
    }
    pub async fn schedule(&self, emoji: bool, action: ScheduleAction) -> Result<()> {
        let mut repository = self.repository.lock().await;
        let (saved, running) = if emoji {
            (
                &repository.data.emoji_settings,
                repository.data.applied_emoji_settings.is_some(),
            )
        } else {
            (
                &repository.data.settings,
                repository.data.applied_settings.is_some(),
            )
        };
        let mut settings = saved.clone();
        settings.enabled = match action {
            ScheduleAction::Apply => running,
            ScheduleAction::Start => true,
            ScheduleAction::Stop => false,
        };
        if settings.enabled {
            let auth = self.auth.read().await;
            if auth.status != "authorized" {
                bail!(Message::new(
                    "rotation.login_required",
                    "Log in to Telegram before starting rotation."
                ));
            }
            if emoji && !auth.premium {
                bail!(Message::new(
                    "rotation.premium_required_to_start",
                    "Telegram Premium is required for emoji status rotation."
                ));
            }
        }
        if emoji {
            repository.update(|library| library.update_emoji_settings(settings, now()))?;
        } else {
            let starting = matches!(action, ScheduleAction::Start);
            repository.schedule_photos(settings, now())?;
            repository.update(|library| {
                library.photo_start_pending = starting;
                if starting {
                    library.last_photo_id = None;
                    library.pending_photo_id = None;
                    library.next_rotation_at = Some(now());
                }
                Ok(())
            })?;
        }
        if emoji {
            *self.emoji_error.write().await = None;
        } else {
            *self.photo_error.write().await = None;
        }
        Ok(())
    }
    pub async fn select_emojis(&self, ids: &[String]) -> Result<()> {
        let choices = self.choices.lock().await;
        let mut selected = Vec::new();
        for id in ids {
            let choice = choices
                .iter()
                .find(|choice| &choice.id == id)
                .context(Message::new(
                    "emoji.catalog_refresh_required",
                    "Refresh the emoji catalog before selecting this emoji.",
                ))?;
            if !selected.iter().any(|item: &EmojiChoice| item.id == *id) {
                selected.push(choice.clone());
            }
        }
        self.repository.lock().await.update(|library| {
            library.select_emojis(selected);
            Ok(())
        })?;
        *self.emoji_error.write().await = None;
        Ok(())
    }
    pub async fn remember_choices(&self, incoming: &[EmojiChoice]) {
        let mut choices = self.choices.lock().await;
        for choice in incoming {
            if let Some(old) = choices.iter_mut().find(|old| old.id == choice.id) {
                *old = choice.clone();
            } else {
                choices.push(choice.clone());
            }
        }
    }
    pub async fn lock_telegram(&self) -> MutexGuard<'_, Option<Telegram>> {
        self.telegram.lock().await
    }
    pub async fn connection(&self) -> Result<MutexGuard<'_, Option<Telegram>>, TelegramError> {
        let not_before = self
            .repository
            .lock()
            .await
            .data
            .telegram_not_before
            .unwrap_or(0);
        let remaining = not_before.saturating_sub(now());
        if remaining > 0 {
            return Err(TelegramError {
                message: format!("Telegram requested a cooldown. Retry in {remaining} seconds."),
                info: crate::messages::MessageInfo::new("telegram.cooldown"),
                retry_after: Some(remaining),
                unauthorized: false,
            });
        }
        Ok(self.telegram.lock().await)
    }
    pub async fn login_qr(&self) -> Result<(), TelegramError> {
        let mut telegram = self.connection().await?;
        let Some(telegram) = telegram.as_mut() else {
            return Err(unavailable());
        };
        let auth = telegram.begin_qr().await?;
        *self.auth.write().await = auth;
        *self.profile.write().await = telegram.profile();
        Ok(())
    }
    pub async fn login_password(&self, password: &str) -> Result<(), TelegramError> {
        let mut telegram = self.connection().await?;
        let Some(telegram) = telegram.as_mut() else {
            return Err(unavailable());
        };
        let auth = telegram.submit_password(password).await?;
        *self.auth.write().await = auth;
        *self.profile.write().await = telegram.profile();
        Ok(())
    }
    pub async fn record_telegram_error(&self, error: &TelegramError) {
        *self.last_error.write().await = Some(LocalizedMessage::new(
            error.message.clone(),
            error.message_info(),
        ));
        if let Some(wait) = error.retry_after {
            let until = now().saturating_add(wait);
            let mut repository = self.repository.lock().await;
            if until > repository.data.telegram_not_before.unwrap_or(0)
                && repository
                    .update(|library| {
                        library.defer_telegram(until);
                        Ok(())
                    })
                    .is_err()
            {
                *self.last_error.write().await = Some(LocalizedMessage::new(
                    "Telegram requested a cooldown, but Celine could not persist it. Check disk space and directory permissions before restarting.",
                    MessageInfo::parameter("storage.cooldown_save_failed", "seconds", wait),
                ));
            }
        }
        if error.unauthorized {
            *self.profile.write().await = None;
            let mut auth = self.auth.write().await;
            auth.status = "disconnected".into();
            auth.qr_svg = None;
            auth.message =
                Some("Telegram authorization expired or was revoked. Log in again.".into());
            auth.message_info = Some(MessageInfo::new("auth.authorization_expired"));
        }
    }
    pub async fn run(self: Arc<Self>) {
        let Some(credentials) = self.credentials else {
            return;
        };
        let mut retry_at = 0;
        loop {
            if now() >= retry_at {
                match self.tick(credentials).await {
                    Ok(()) => {}
                    Err(error) => {
                        self.record_telegram_error(&error).await;
                        retry_at = now().saturating_add(error.retry_after.unwrap_or(30).max(2));
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    async fn tick(&self, credentials: Credentials) -> Result<(), TelegramError> {
        let mut connection = self.connection().await?;
        if connection.is_none() {
            *connection =
                Some(Telegram::connect(&self.dir, credentials.id, credentials.hash).await?);
        }
        let telegram = connection.as_mut().expect("connection was initialized");
        let auth = telegram.poll_auth().await?;
        *self.last_error.write().await = None;
        let authorized = auth.status == "authorized";
        let premium = auth.premium;
        *self.auth.write().await = auth;
        *self.profile.write().await = if authorized { telegram.profile() } else { None };
        if authorized {
            if !premium {
                self.stop_nonpremium_emoji_rotation().await?;
            }
            if let Err(mut error) = self.rotate_photos_if_due(telegram).await {
                error.info.params["context"] = "photo".into();
                *self.photo_error.write().await = Some(LocalizedMessage::new(
                    format!("Photo rotation: {}", error.message),
                    error.message_info(),
                ));
                self.record_telegram_error(&error).await;
                if blocks_telegram(&error) {
                    return Err(error);
                }
            }
            if let Err(mut error) = self.rotate_emojis_if_due(telegram).await {
                error.info.params["context"] = "emoji".into();
                *self.emoji_error.write().await = Some(LocalizedMessage::new(
                    format!("Emoji rotation: {}", error.message),
                    error.message_info(),
                ));
                self.record_telegram_error(&error).await;
                if blocks_telegram(&error) {
                    return Err(error);
                }
            }
            *self.profile.write().await = telegram.profile();
        }
        Ok(())
    }
    async fn stop_nonpremium_emoji_rotation(&self) -> Result<(), TelegramError> {
        let mut repository = self.repository.lock().await;
        if repository.data.applied_emoji_settings.is_some() {
            repository
                .update(|library| {
                    library.emoji_settings.enabled = false;
                    library.applied_emoji_settings = None;
                    library.next_emoji_rotation_at = None;
                    Ok(())
                })
                .map_err(storage_error)?;
            *self.emoji_error.write().await = None;
            *self.last_error.write().await = Some(LocalizedMessage::new(
                "Telegram Premium is required. Emoji rotation has stopped.",
                MessageInfo::new("rotation.premium_required"),
            ));
        }
        Ok(())
    }
    async fn rotate_photos_if_due(
        &self,
        telegram: &mut impl PhotoClient,
    ) -> Result<(), TelegramError> {
        self.resume_photos(telegram).await?;
        let mut skipped = Vec::new();
        let mut after = None;
        let revision = self.repository.lock().await.photo_schedule_revision();
        loop {
            let photo = {
                let mut repository = self.repository.lock().await;
                if !repository.photo_schedule_is_current(revision) {
                    return Ok(());
                }
                repository
                    .prepare_photo_rotation(now(), after.as_deref(), &skipped)
                    .map_err(storage_error)?
            };
            let Some(photo) = photo else { return Ok(()) };
            match self.rotate_photo(telegram, &photo).await {
                Ok(true) => {
                    self.repository
                        .lock()
                        .await
                        .complete_photo_rotation(&photo.id)
                        .map_err(storage_error)?;
                    *self.photo_error.write().await = None;
                    return Ok(());
                }
                Ok(false) => {
                    after = Some(photo.id.clone());
                    skipped.push(photo.id);
                }
                Err(error) => {
                    self.repository
                        .lock()
                        .await
                        .retry_photo_rotation(
                            revision,
                            now(),
                            error.retry_after.unwrap_or(30).max(2),
                        )
                        .map_err(storage_error)?;
                    return Err(error);
                }
            }
        }
    }

    async fn resume_photos(&self, telegram: &mut impl PhotoClient) -> Result<(), TelegramError> {
        let (revision, photos) = {
            let repository = self.repository.lock().await;
            if !repository.data.photo_start_pending || repository.data.applied_settings.is_none() {
                return Ok(());
            }
            (
                repository.photo_schedule_revision(),
                repository.data.photos.clone(),
            )
        };
        let current = telegram.current_photo().await?;
        let mut matched = None;
        if let Some((id, bytes)) = &current {
            matched = photos
                .iter()
                .find(|photo| photo.telegram_id.as_ref() == Some(id))
                .map(|photo| photo.id.clone());
            if matched.is_none() {
                let fingerprint = crate::photo_match::Fingerprint::decode(bytes)
                    .map_err(|error| storage_error(error.into()))?;
                for photo in &photos {
                    let path = self
                        .repository
                        .lock()
                        .await
                        .photo_path(&photo.id)
                        .map_err(storage_error)?;
                    let bytes = match tokio::fs::read(path).await {
                        Ok(bytes) => bytes,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(storage_error(error.into())),
                    };
                    if crate::photo_match::Fingerprint::decode(&bytes)
                        .is_ok_and(|local| fingerprint.is_close(&local))
                    {
                        matched = Some(photo.id.clone());
                        break;
                    }
                }
            }
        }
        let mut repository = self.repository.lock().await;
        if !repository.photo_schedule_is_current(revision) {
            return Ok(());
        }
        repository
            .update(|library| {
                library.photo_start_pending = false;
                library.last_photo_id = matched.clone();
                if let Some(matched) = matched {
                    let photo = library
                        .photos
                        .iter_mut()
                        .find(|photo| photo.id == matched)
                        .unwrap();
                    photo.telegram_id = current.map(|(id, _)| id);
                    photo.history_checked = true;
                    library.next_rotation_at =
                        Some(library.applied_settings.as_ref().unwrap().next_at(now()));
                } else {
                    library.pending_photo_id = library.photos.first().map(|photo| photo.id.clone());
                }
                Ok(())
            })
            .map_err(storage_error)
    }

    async fn rotate_photo(
        &self,
        telegram: &mut impl PhotoClient,
        photo: &Photo,
    ) -> Result<bool, TelegramError> {
        if let Some(id) = &photo.telegram_id {
            return telegram.use_history_photo(id).await;
        }
        let path = self
            .repository
            .lock()
            .await
            .photo_path(&photo.id)
            .map_err(storage_error)?;
        let jpeg = match tokio::fs::read(&path).await {
            Ok(jpeg) => jpeg,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(storage_error(error.into())),
        };
        if !photo.history_checked
            && let Some(id) = telegram.matching_photo(&jpeg).await?
        {
            self.repository
                .lock()
                .await
                .link_telegram_photo(&photo.id, id.clone())
                .map_err(storage_error)?;
            return telegram.use_history_photo(&id).await;
        }
        self.repository
            .lock()
            .await
            .mark_photo_uploading(&photo.id)
            .map_err(storage_error)?;
        let id = telegram.set_photo(&path).await?;
        self.repository
            .lock()
            .await
            .link_telegram_photo(&photo.id, id)
            .map_err(storage_error)?;
        Ok(true)
    }
    async fn rotate_emojis_if_due(&self, telegram: &mut Telegram) -> Result<(), TelegramError> {
        let id = {
            let mut repository = self.repository.lock().await;
            if !emoji_rotation_due(&repository.data, now()) {
                return Ok(());
            }
            let Some(emoji) = repository.data.next_emoji() else {
                return Ok(());
            };
            let id = emoji.id.clone();
            repository
                .update(|library| {
                    library.next_emoji_rotation_at = Some(
                        library
                            .applied_emoji_settings
                            .as_ref()
                            .unwrap()
                            .next_at(now()),
                    );
                    Ok(())
                })
                .map_err(storage_error)?;
            id
        };
        let document_id = id.parse::<i64>().map_err(|_| TelegramError {
            info: crate::messages::MessageInfo::new("rotation.emoji_invalid"),
            message: "Invalid saved emoji. Reload the emoji catalog and select it again.".into(),
            retry_after: None,
            unauthorized: false,
        })?;
        telegram.set_emoji_status(document_id).await?;
        self.repository
            .lock()
            .await
            .update(|library| {
                library.last_emoji_id = Some(id);
                Ok(())
            })
            .map_err(storage_error)?;
        *self.emoji_error.write().await = None;
        Ok(())
    }
}
fn blocks_telegram(error: &TelegramError) -> bool {
    error.unauthorized || error.retry_after.is_some()
}
pub fn unavailable() -> TelegramError {
    TelegramError {
        info: crate::messages::MessageInfo::new("telegram.not_connected"),
        message: "Telegram is not connected. Check the connection and build-time credentials."
            .into(),
        retry_after: None,
        unauthorized: false,
    }
}
fn storage_error(_: anyhow::Error) -> TelegramError {
    TelegramError {
        info: crate::messages::MessageInfo::new("storage.state_save_failed"),
        message:
            "Cannot save Celine state. Check available disk space and data-directory permissions."
                .into(),
        retry_after: Some(60),
        unauthorized: false,
    }
}
fn emoji_rotation_due(library: &Library, now: u64) -> bool {
    library.applied_emoji_settings.is_some()
        && library.next_emoji_rotation_at.is_none_or(|due| due <= now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    enum PhotoCall {
        Current(Option<(&'static str, Vec<u8>)>),
        Use(&'static str, Result<bool, TelegramError>),
        Match(Option<&'static str>),
        Upload(&'static str),
    }

    struct FakePhotos(VecDeque<PhotoCall>);

    impl FakePhotos {
        fn new(calls: impl IntoIterator<Item = PhotoCall>) -> Self {
            Self(calls.into_iter().collect())
        }
        fn assert_finished(&self) {
            assert!(self.0.is_empty(), "expected photo calls were not made");
        }
    }

    impl PhotoClient for FakePhotos {
        async fn current_photo(&mut self) -> Result<Option<(String, Vec<u8>)>, TelegramError> {
            let Some(PhotoCall::Current(photo)) = self.0.pop_front() else {
                panic!("unexpected current photo request")
            };
            Ok(photo.map(|(id, bytes)| (id.into(), bytes)))
        }
        async fn use_history_photo(&mut self, id: &str) -> Result<bool, TelegramError> {
            let Some(PhotoCall::Use(expected, result)) = self.0.pop_front() else {
                panic!("unexpected history request for {id}");
            };
            assert_eq!(id, expected);
            result
        }
        async fn matching_photo(&mut self, jpeg: &[u8]) -> Result<Option<String>, TelegramError> {
            let Some(PhotoCall::Match(id)) = self.0.pop_front() else {
                panic!("unexpected history matching");
            };
            assert_eq!(jpeg, b"local jpeg");
            Ok(id.map(String::from))
        }
        async fn set_photo(&mut self, path: &std::path::Path) -> Result<String, TelegramError> {
            let Some(PhotoCall::Upload(id)) = self.0.pop_front() else {
                panic!("unexpected upload");
            };
            assert_eq!(std::fs::read(path).unwrap(), b"local jpeg");
            Ok(id.into())
        }
    }

    struct TransitioningPhoto {
        app: Arc<App>,
        action: ScheduleAction,
        fail: bool,
    }

    impl PhotoClient for TransitioningPhoto {
        async fn current_photo(&mut self) -> Result<Option<(String, Vec<u8>)>, TelegramError> {
            Ok(None)
        }
        async fn use_history_photo(&mut self, _: &str) -> Result<bool, TelegramError> {
            self.app.schedule(false, self.action).await.unwrap();
            if self.fail {
                Err(unavailable())
            } else {
                Ok(false)
            }
        }
        async fn matching_photo(&mut self, _: &[u8]) -> Result<Option<String>, TelegramError> {
            unreachable!()
        }
        async fn set_photo(&mut self, _: &std::path::Path) -> Result<String, TelegramError> {
            unreachable!()
        }
    }

    fn photo(id: &str, telegram_id: Option<&str>, history_checked: bool) -> Photo {
        Photo {
            id: id.into(),
            name: id.into(),
            generated_name: Some(false),
            telegram_id: telegram_id.map(String::from),
            history_checked,
            crop: None,
        }
    }

    async fn photo_app(photos: Vec<Photo>) -> (tempfile::TempDir, Arc<App>) {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.photos = photos;
                library.settings.enabled = true;
                library.settings.jitter_secs = Some(0);
                library.applied_settings = Some(library.settings.clone());
                library.next_rotation_at = Some(0);
                Ok(())
            })
            .unwrap();
        (dir, app)
    }

    async fn write_photo(app: &App, id: &str) {
        let path = app.repository.lock().await.photo_path(id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"local jpeg").unwrap();
    }

    async fn make_photo_due(app: &App) {
        app.repository
            .lock()
            .await
            .update(|library| {
                library.next_rotation_at = Some(0);
                Ok(())
            })
            .unwrap();
    }

    #[tokio::test]
    async fn start_matches_current_photo_waits_and_continues_from_it() {
        for linked in [false, true] {
            let (_dir, app) = photo_app(vec![
                photo("a", Some("1"), true),
                photo("b", linked.then_some("2"), true),
                photo("c", Some("3"), true),
            ])
            .await;
            let jpeg = include_bytes!("../web/public/logo.jpg").to_vec();
            let path = app.repository.lock().await.photo_path("b").unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, &jpeg).unwrap();
            app.auth.write().await.status = "authorized".into();
            app.schedule(false, ScheduleAction::Stop).await.unwrap();
            app.schedule(false, ScheduleAction::Start).await.unwrap();
            let before = now();
            let mut client = FakePhotos::new([
                PhotoCall::Current(Some(("2", jpeg))),
                PhotoCall::Use("3", Ok(true)),
            ]);
            app.rotate_photos_if_due(&mut client).await.unwrap();
            let state = app.state().await;
            assert_eq!(state.current_photo_id.as_deref(), Some("b"));
            assert_eq!(state.library.photos[1].telegram_id.as_deref(), Some("2"));
            assert!(state.library.next_rotation_at.unwrap() >= before + 3600);
            app.rotate_photos_if_due(&mut client).await.unwrap();
            make_photo_due(&app).await;
            app.rotate_photos_if_due(&mut client).await.unwrap();
            assert_eq!(app.state().await.current_photo_id.as_deref(), Some("c"));
            client.assert_finished();
        }
    }

    #[tokio::test]
    async fn start_without_current_match_applies_first_immediately_even_in_random_mode() {
        let (_dir, app) = photo_app(vec![
            photo("a", Some("1"), true),
            photo("b", Some("2"), true),
        ])
        .await;
        app.auth.write().await.status = "authorized".into();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.settings.mode = crate::library::Mode::Random;
                library.last_photo_id = Some("b".into());
                Ok(())
            })
            .unwrap();
        app.schedule(false, ScheduleAction::Start).await.unwrap();
        let mut client = FakePhotos::new([PhotoCall::Current(None), PhotoCall::Use("1", Ok(true))]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        assert_eq!(app.state().await.current_photo_id.as_deref(), Some("a"));
        client.assert_finished();
    }

    #[tokio::test]
    async fn applying_during_photo_failure_preserves_the_new_deadline() {
        let (_dir, app) = photo_app(vec![photo("a", Some("1"), true)]).await;
        app.auth.write().await.status = "authorized".into();
        app.update_settings(Settings {
            interval_secs: 90,
            jitter_secs: Some(0),
            ..Settings::default()
        })
        .await
        .unwrap();
        let before = now();
        let mut client = TransitioningPhoto {
            app: app.clone(),
            action: ScheduleAction::Apply,
            fail: true,
        };
        assert!(app.rotate_photos_if_due(&mut client).await.is_err());
        let library = app.state().await.library;
        assert!((before + 90..=now() + 90).contains(&library.next_rotation_at.unwrap()));
        assert_eq!(library.applied_settings.unwrap().interval_secs, 90);
    }

    #[tokio::test]
    async fn stopping_during_missing_photo_does_not_try_another_or_replay_pending_on_restart() {
        let (dir, app) = photo_app(vec![
            photo("a", Some("1"), true),
            photo("b", Some("2"), true),
        ])
        .await;
        app.auth.write().await.status = "authorized".into();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.last_photo_id = Some("a".into());
                library.pending_photo_id = Some("a".into());
                Ok(())
            })
            .unwrap();
        let mut client = TransitioningPhoto {
            app: app.clone(),
            action: ScheduleAction::Stop,
            fail: false,
        };
        app.rotate_photos_if_due(&mut client).await.unwrap();
        let library = app.state().await.library;
        assert!(library.pending_photo_id.is_none());
        assert!(library.next_rotation_at.is_none());
        drop(client);
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        app.auth.write().await.status = "authorized".into();
        app.schedule(false, ScheduleAction::Start).await.unwrap();
        make_photo_due(&app).await;
        let mut client = FakePhotos::new([PhotoCall::Current(None), PhotoCall::Use("1", Ok(true))]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
    }

    #[tokio::test]
    async fn stopping_during_photo_failure_does_not_schedule_a_retry() {
        let (_dir, app) = photo_app(vec![photo("a", Some("1"), true)]).await;
        let mut client = TransitioningPhoto {
            app: app.clone(),
            action: ScheduleAction::Stop,
            fail: true,
        };
        assert!(app.rotate_photos_if_due(&mut client).await.is_err());
        let library = app.state().await.library;
        assert!(library.applied_settings.is_none());
        assert!(library.next_rotation_at.is_none());
        assert!(library.pending_photo_id.is_none());
    }

    #[tokio::test]
    async fn logout_clears_english_and_structured_auth_messages() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        assert!(app.state().await.auth.message_info.is_some());
        app.logout().await.unwrap();
        let auth = app.state().await.auth;
        assert!(auth.message.is_none());
        assert!(auth.message_info.is_none());
    }

    #[tokio::test]
    async fn rotation_context_survives_recording_and_retained_error_selection() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        for context in ["photo", "emoji"] {
            let mut error = storage_error(anyhow::anyhow!("private disk path"));
            error.info.params["context"] = context.into();
            app.record_telegram_error(&error).await;
            let retained = LocalizedMessage::new(error.message.clone(), error.message_info());
            let slot = if context == "photo" {
                &app.photo_error
            } else {
                &app.emoji_error
            };
            *slot.write().await = Some(retained);
            for clear_primary in [false, true] {
                if clear_primary {
                    *app.last_error.write().await = None;
                }
                let info = app.state().await.last_error_info.unwrap();
                assert_eq!(info.code, "storage.state_save_failed");
                assert_eq!(info.params["context"], context);
                assert_eq!(info.params["seconds"], 60);
            }
            *slot.write().await = None;
        }
    }

    #[tokio::test]
    async fn background_storage_and_authorization_metadata_remain_actionable() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        app.record_telegram_error(&storage_error(anyhow::anyhow!("private disk path")))
            .await;
        let state = app.state().await;
        assert!(state.last_error.unwrap().contains("disk space"));
        let info = state.last_error_info.unwrap();
        assert_eq!(info.code, "storage.state_save_failed");
        assert_eq!(info.params["seconds"], 60);
        let mut error = unavailable();
        error.unauthorized = true;
        app.record_telegram_error(&error).await;
        assert_eq!(
            app.state().await.auth.message_info.unwrap().code,
            "auth.authorization_expired"
        );
        app.update_settings(Settings::default()).await.unwrap();
        *app.last_error.write().await = None;
        let state = app.state().await;
        assert!(state.last_error.is_none());
        assert!(state.last_error_info.is_none());
    }

    #[tokio::test]
    async fn linked_photo_uses_history_without_a_local_file() {
        let (_dir, app) = photo_app(vec![photo("a", Some("101"), true)]).await;
        assert!(
            !app.repository
                .lock()
                .await
                .photo_path("a")
                .unwrap()
                .exists()
        );
        let mut client = FakePhotos::new([PhotoCall::Use("101", Ok(true))]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
        let state = app.state().await;
        assert_eq!(state.library.last_photo_id.as_deref(), Some("a"));
        assert!(state.library.pending_photo_id.is_none());
    }

    #[tokio::test]
    async fn missing_history_skips_local_copy_and_tries_next_in_order() {
        let (_dir, app) = photo_app(vec![
            photo("a", Some("101"), true),
            photo("b", Some("102"), true),
            photo("c", Some("103"), true),
        ])
        .await;
        write_photo(&app, "a").await;
        let mut client = FakePhotos::new([
            PhotoCall::Use("101", Ok(false)),
            PhotoCall::Use("102", Ok(true)),
        ]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
        assert_eq!(
            app.state().await.library.last_photo_id.as_deref(),
            Some("b")
        );
    }

    #[tokio::test]
    async fn missing_unlinked_file_is_skipped() {
        let (_dir, app) =
            photo_app(vec![photo("a", None, true), photo("b", Some("102"), true)]).await;
        let mut client = FakePhotos::new([PhotoCall::Use("102", Ok(true))]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
        assert_eq!(
            app.state().await.library.last_photo_id.as_deref(),
            Some("b")
        );
    }

    #[tokio::test]
    async fn all_missing_photos_stop_rotation_without_uploading() {
        let (_dir, app) = photo_app(vec![
            photo("a", Some("101"), true),
            photo("b", Some("102"), true),
        ])
        .await;
        write_photo(&app, "a").await;
        write_photo(&app, "b").await;
        let mut client = FakePhotos::new([
            PhotoCall::Use("101", Ok(false)),
            PhotoCall::Use("102", Ok(false)),
        ]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
        let library = app.state().await.library;
        assert!(!library.settings.enabled);
        assert!(library.next_rotation_at.is_none());
        assert!(library.pending_photo_id.is_none());
        assert!(library.last_photo_id.is_none());
    }

    #[tokio::test]
    async fn transient_failure_retries_pending_photo_in_ordered_and_random_modes() {
        for mode in [crate::library::Mode::Ordered, crate::library::Mode::Random] {
            let (_dir, app) = photo_app(vec![
                photo("a", Some("101"), true),
                photo("b", Some("102"), true),
            ])
            .await;
            app.repository
                .lock()
                .await
                .update(|library| {
                    library.applied_settings.as_mut().unwrap().mode = mode;
                    library.last_photo_id = Some("b".into());
                    Ok(())
                })
                .unwrap();
            let mut client = FakePhotos::new([
                PhotoCall::Use(
                    "101",
                    Err(TelegramError {
                        info: crate::messages::MessageInfo::new("error.unclassified"),
                        message: "temporary network failure".into(),
                        retry_after: None,
                        unauthorized: false,
                    }),
                ),
                PhotoCall::Use("101", Ok(true)),
            ]);
            let before = now();
            assert!(app.rotate_photos_if_due(&mut client).await.is_err());
            let library = app.state().await.library;
            assert_eq!(library.pending_photo_id.as_deref(), Some("a"));
            assert_eq!(library.last_photo_id.as_deref(), Some("b"));
            let retry_at = library.next_rotation_at.unwrap();
            assert!((before + 30..=now() + 30).contains(&retry_at));
            assert_eq!(library.settings.interval_secs, 3600);
            app.rotate_photos_if_due(&mut client).await.unwrap();
            assert_eq!(client.0.len(), 1, "must wait for short retry deadline");
            assert_eq!(app.state().await.library.next_rotation_at, Some(retry_at));
            make_photo_due(&app).await;
            let before = now();
            app.rotate_photos_if_due(&mut client).await.unwrap();
            client.assert_finished();
            let library = app.state().await.library;
            assert_eq!(library.last_photo_id.as_deref(), Some("a"));
            assert!(library.pending_photo_id.is_none());
            assert!((before + 3600..=now() + 3600).contains(&library.next_rotation_at.unwrap()));
        }
    }

    #[tokio::test]
    async fn photo_retry_respects_telegram_cooldown() {
        let (_dir, app) = photo_app(vec![photo("a", Some("101"), true)]).await;
        let mut client = FakePhotos::new([PhotoCall::Use(
            "101",
            Err(TelegramError {
                info: crate::messages::MessageInfo::new("error.unclassified"),
                message: "cooldown".into(),
                retry_after: Some(90),
                unauthorized: false,
            }),
        )]);
        let before = now();
        assert!(app.rotate_photos_if_due(&mut client).await.is_err());
        client.assert_finished();
        let library = app.state().await.library;
        assert_eq!(library.pending_photo_id.as_deref(), Some("a"));
        assert!((before + 90..=now() + 90).contains(&library.next_rotation_at.unwrap()));
    }

    #[tokio::test]
    async fn new_photo_uploads_once_and_reuses_saved_id_after_restart() {
        let (dir, app) = photo_app(vec![photo("a", None, true)]).await;
        write_photo(&app, "a").await;
        let mut client =
            FakePhotos::new([PhotoCall::Upload("101"), PhotoCall::Use("101", Ok(true))]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        assert_eq!(
            app.state().await.library.photos[0].telegram_id.as_deref(),
            Some("101")
        );
        make_photo_due(&app).await;
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
    }

    #[tokio::test]
    async fn legacy_photo_matches_history_before_considering_upload() {
        for matched in [Some("101"), None] {
            let (_dir, app) = photo_app(vec![photo("a", None, false)]).await;
            write_photo(&app, "a").await;
            let next = if matched.is_some() {
                PhotoCall::Use("101", Ok(true))
            } else {
                PhotoCall::Upload("101")
            };
            let mut client = FakePhotos::new([PhotoCall::Match(matched), next]);
            app.rotate_photos_if_due(&mut client).await.unwrap();
            client.assert_finished();
            let library = app.state().await.library;
            assert_eq!(library.photos[0].telegram_id.as_deref(), Some("101"));
            assert!(library.photos[0].history_checked);
            assert_eq!(library.last_photo_id.as_deref(), Some("a"));
        }
    }

    #[test]
    fn missed_schedule_runs_once_not_a_catchup_loop() {
        let mut library = Library::default();
        library.settings.enabled = true;
        library.applied_settings = Some(library.settings.clone());
        library.next_rotation_at = Some(100);
        assert!(library.photo_rotation_due(10000));
        library.next_rotation_at = Some(library.settings.next_at(10000));
        assert!(!library.photo_rotation_due(10000));
        library.applied_settings = None;
        assert!(!library.photo_rotation_due(u64::MAX));
    }
    #[test]
    fn photo_and_emoji_due_times_are_independent() {
        let mut library = Library::default();
        library.settings.enabled = true;
        library.emoji_settings.enabled = true;
        library.applied_settings = Some(library.settings.clone());
        library.applied_emoji_settings = Some(library.emoji_settings.clone());
        library.next_rotation_at = Some(100);
        library.next_emoji_rotation_at = Some(200);
        assert!(library.photo_rotation_due(100));
        assert!(!emoji_rotation_due(&library, 100));
        library.next_rotation_at = Some(300);
        assert!(!library.photo_rotation_due(200));
        assert!(emoji_rotation_due(&library, 200));
        library.applied_emoji_settings = None;
        assert!(!emoji_rotation_due(&library, 200));
        assert!(library.photo_rotation_due(300));
    }
    #[test]
    fn only_authorization_and_cooldown_errors_block_the_other_rotation() {
        let mut error = unavailable();
        assert!(!blocks_telegram(&error));
        error.retry_after = Some(60);
        assert!(blocks_telegram(&error));
        error.retry_after = None;
        error.unauthorized = true;
        assert!(blocks_telegram(&error));
    }
    #[tokio::test]
    async fn emoji_rotation_requires_premium_and_stops_without_stopping_photos() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let settings = Settings {
            enabled: true,
            interval_secs: 60,
            ..Settings::default()
        };
        assert!(app.schedule(true, ScheduleAction::Start).await.is_err());
        app.auth.write().await.status = "authorized".into();
        assert!(app.schedule(true, ScheduleAction::Start).await.is_err());
        app.auth.write().await.premium = true;
        assert!(app.schedule(true, ScheduleAction::Start).await.is_err());
        let choice = EmojiChoice {
            id: "9223372036854775806".into(),
            label: "Star".into(),
            source: "Pack".into(),
            source_kind: None,
            thumbnail_url: None,
            text_color: false,
        };
        app.remember_choices(std::slice::from_ref(&choice)).await;
        app.select_emojis(std::slice::from_ref(&choice.id))
            .await
            .unwrap();
        app.update_emoji_settings(settings).await.unwrap();
        app.schedule(true, ScheduleAction::Start).await.unwrap();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.photos.push(crate::library::Photo {
                    id: "photo-a".into(),
                    name: "Portrait".into(),
                    generated_name: Some(false),
                    telegram_id: None,
                    history_checked: true,
                    crop: None,
                });
                library.update_settings(
                    Settings {
                        enabled: true,
                        interval_secs: 10,
                        ..Settings::default()
                    },
                    now(),
                )
            })
            .unwrap();
        app.stop_nonpremium_emoji_rotation().await.unwrap();
        let state = app.state().await;
        assert!(state.library.settings.enabled);
        assert_eq!(state.library.settings.interval_secs, 10);
        assert!(!state.library.emoji_settings.enabled);
        assert!(state.library.next_emoji_rotation_at.is_none());
    }
    #[tokio::test]
    async fn acknowledging_one_rotation_error_does_not_hide_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        *app.photo_error.write().await = Some("Photo failed".into());
        *app.emoji_error.write().await = Some("Emoji failed".into());
        assert_eq!(
            app.state().await.last_error.as_deref(),
            Some("Photo failed")
        );
        app.update_settings(Settings::default()).await.unwrap();
        assert_eq!(
            app.state().await.last_error.as_deref(),
            Some("Emoji failed")
        );
        app.select_emojis(&[]).await.unwrap();
        assert!(app.state().await.last_error.is_none());
    }
    #[tokio::test]
    async fn flood_cooldown_survives_restart_and_settings_edits() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let until = now() + 3600;
        app.record_telegram_error(&TelegramError {
            info: crate::messages::MessageInfo::new("error.unclassified"),
            message: "Flood wait".into(),
            retry_after: Some(3600),
            unauthorized: false,
        })
        .await;
        assert!(app.connection().await.is_err());
        app.update_settings(Settings {
            interval_secs: 1,
            ..Settings::default()
        })
        .await
        .unwrap();
        assert!(
            app.repository
                .lock()
                .await
                .data
                .telegram_not_before
                .unwrap()
                >= until
        );
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        assert!(app.connection().await.is_err());
        assert!(app.login_qr().await.unwrap_err().retry_after.unwrap() > 3500);
        let error = TelegramError {
            info: crate::messages::MessageInfo::new("error.unclassified"),
            message: "Still cooling down".into(),
            retry_after: Some(10),
            unauthorized: false,
        };
        app.record_telegram_error(&error).await;
        assert!(
            app.repository
                .lock()
                .await
                .data
                .telegram_not_before
                .unwrap()
                >= until
        );
    }
    #[tokio::test]
    async fn emoji_choices_survive_restart_without_integer_precision_loss() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let choice = EmojiChoice {
            id: "9223372036854775806".into(),
            label: "Star".into(),
            source: "Installed pack".into(),
            source_kind: None,
            thumbnail_url: None,
            text_color: false,
        };
        app.remember_choices(std::slice::from_ref(&choice)).await;
        app.select_emojis(std::slice::from_ref(&choice.id))
            .await
            .unwrap();
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        let state = app.state().await;
        assert_eq!(state.selected_emoji_ids, vec![choice.id]);
        assert_eq!(state.library.selected_emojis[0].label, "Star");
    }
    #[tokio::test]
    async fn autosave_keeps_applied_schedules_and_deadlines_until_apply() {
        let (dir, app) = photo_app(vec![photo("a", None, true)]).await;
        app.auth.write().await.status = "authorized".into();
        app.auth.write().await.premium = true;
        let choice = EmojiChoice {
            id: "1".into(),
            label: "Star".into(),
            source: "Pack".into(),
            source_kind: None,
            thumbnail_url: None,
            text_color: false,
        };
        app.remember_choices(std::slice::from_ref(&choice)).await;
        app.select_emojis(std::slice::from_ref(&choice.id))
            .await
            .unwrap();
        app.schedule(true, ScheduleAction::Start).await.unwrap();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.next_rotation_at = Some(123);
                library.next_emoji_rotation_at = Some(456);
                Ok(())
            })
            .unwrap();
        let saved = Settings {
            enabled: false,
            mode: crate::library::Mode::Random,
            interval_secs: 90,
            jitter_secs: Some(0),
        };
        app.update_settings(saved.clone()).await.unwrap();
        app.update_emoji_settings(saved).await.unwrap();
        let state = app.state().await.library;
        assert!(state.settings.enabled && state.emoji_settings.enabled);
        assert_eq!(state.applied_settings.as_ref().unwrap().interval_secs, 3600);
        assert_eq!(
            state.applied_emoji_settings.as_ref().unwrap().interval_secs,
            3600
        );
        assert_eq!(state.next_rotation_at, Some(123));
        assert_eq!(state.next_emoji_rotation_at, Some(456));
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        let state = app.state().await.library;
        assert_eq!(state.settings.interval_secs, 90);
        assert_eq!(state.applied_settings.unwrap().interval_secs, 3600);
        assert_eq!(state.applied_emoji_settings.unwrap().interval_secs, 3600);
        assert_eq!(state.next_rotation_at, Some(123));
        app.auth.write().await.status = "authorized".into();
        app.auth.write().await.premium = true;
        let before = now();
        app.schedule(false, ScheduleAction::Apply).await.unwrap();
        app.schedule(true, ScheduleAction::Apply).await.unwrap();
        let state = app.state().await.library;
        assert_eq!(
            state.applied_settings.unwrap().mode,
            crate::library::Mode::Random
        );
        assert_eq!(state.applied_emoji_settings.unwrap().interval_secs, 90);
        assert!((before + 90..=now() + 90).contains(&state.next_rotation_at.unwrap()));
        assert!((before + 90..=now() + 90).contains(&state.next_emoji_rotation_at.unwrap()));
        app.schedule(false, ScheduleAction::Stop).await.unwrap();
        app.schedule(true, ScheduleAction::Stop).await.unwrap();
        app.schedule(false, ScheduleAction::Apply).await.unwrap();
        let state = app.state().await.library;
        assert!(state.applied_settings.is_none() && state.applied_emoji_settings.is_none());
        assert!(state.next_rotation_at.is_none() && state.next_emoji_rotation_at.is_none());
        app.schedule(false, ScheduleAction::Start).await.unwrap();
        assert_eq!(
            app.state()
                .await
                .library
                .applied_settings
                .unwrap()
                .interval_secs,
            90
        );
    }
    #[tokio::test]
    async fn unconfigured_state_and_settings_validation() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        assert_eq!(app.state().await.auth.status, "unconfigured");
        assert!(app.schedule(false, ScheduleAction::Start).await.is_err());
        assert!(app.login_qr().await.is_err());
        assert!(app.select_emojis(&["123".into()]).await.is_err());
    }
}
