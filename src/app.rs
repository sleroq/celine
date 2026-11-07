use crate::messages::{LocalizedMessage, Message, MessageInfo};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::sync::{Mutex, MutexGuard, RwLock};

use crate::{
    library::{Library, PendingPhotoStatus, Photo, Repository, Settings},
    photo_cache::PhotoCache,
    telegram::{AuthState, EmojiChoice, HistoryPhoto, Profile, Telegram, TelegramError},
};

trait PhotoHistoryClient {
    async fn photo_history(&mut self) -> Result<Vec<HistoryPhoto>, TelegramError>;
    async fn history_photo(&mut self, id: &str) -> Result<Option<Vec<u8>>, TelegramError>;
}

impl PhotoHistoryClient for Telegram {
    async fn photo_history(&mut self) -> Result<Vec<HistoryPhoto>, TelegramError> {
        Telegram::photo_history(self).await
    }
    async fn history_photo(&mut self, id: &str) -> Result<Option<Vec<u8>>, TelegramError> {
        Telegram::history_photo(self, id).await
    }
}

trait PhotoClient {
    async fn set_emoji_status(&mut self, id: Option<&str>) -> Result<(), TelegramError>;
    async fn current_photo(&mut self) -> Result<Option<(String, Vec<u8>)>, TelegramError>;
    async fn use_history_photo(&mut self, id: &str) -> Result<bool, TelegramError>;
    async fn set_photo(&mut self, path: &std::path::Path) -> Result<String, TelegramError>;
}

impl PhotoClient for Telegram {
    async fn set_emoji_status(&mut self, id: Option<&str>) -> Result<(), TelegramError> {
        Telegram::set_emoji_status(self, id).await
    }
    async fn current_photo(&mut self) -> Result<Option<(String, Vec<u8>)>, TelegramError> {
        Telegram::current_photo(self).await
    }
    async fn use_history_photo(&mut self, id: &str) -> Result<bool, TelegramError> {
        Telegram::use_history_photo(self, id).await
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
    pub photo_cache: PhotoCacheView,
    pub last_error: Option<String>,
    pub last_error_info: Option<MessageInfo>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PhotoCacheStatus {
    Refreshing,
    Ready,
    Error,
}

#[derive(Serialize)]
pub struct PhotoCacheView {
    pub status: PhotoCacheStatus,
    pub photos: Vec<HistoryPhoto>,
    pub recovery: std::collections::HashMap<String, PhotoRecovery>,
}

#[derive(Serialize)]
pub struct PhotoRecovery {
    pub duplicate_of: Option<String>,
    pub can_upload: bool,
}

#[derive(Clone, Copy)]
enum PhotoCacheSync {
    History,
    Images,
    Ready,
}

#[derive(Clone, Copy)]
pub enum ScheduleAction {
    Apply,
    Start,
    Stop,
}

pub struct App {
    pub repository: Mutex<Repository>,
    pub photo_cache: Mutex<PhotoCache>,
    photo_cache_status: RwLock<PhotoCacheStatus>,
    photo_cache_refresh: AtomicBool,
    telegram: Mutex<Option<Telegram>>,
    pub auth: RwLock<AuthState>,
    profile: RwLock<Option<Profile>>,
    pub choices: Mutex<Vec<EmojiChoice>>,
    pub last_error: RwLock<Option<LocalizedMessage>>,
    photo_error: RwLock<Option<LocalizedMessage>>,
    photo_status_error: RwLock<Option<LocalizedMessage>>,
    emoji_error: RwLock<Option<LocalizedMessage>>,
    credentials: Option<Credentials>,
    dir: PathBuf,
}
impl App {
    pub fn open(dir: PathBuf, credentials: Option<Credentials>) -> Result<Arc<Self>> {
        let repository = Repository::open(dir.clone())?;
        let photo_cache = PhotoCache::open(&dir)?;
        let mut choices = repository.data.selected_emojis.clone();
        choices.extend(
            repository
                .data
                .photos
                .iter()
                .filter_map(|photo| photo.emoji_status.clone()),
        );
        let auth = AuthState {
            message_info: Some(MessageInfo::new(if credentials.is_some() { "auth.connecting" } else { "auth.unconfigured" })),
            status: if credentials.is_some() { "disconnected" } else { "unconfigured" }.into(),
            qr_svg: None, expires_at: None, name: None, premium: false,
            message: Some(if credentials.is_some() { "Connecting to Telegram…" } else { "This binary has no valid Telegram application credentials. Rebuild with CELINE_API_ID and CELINE_API_HASH." }.into()),
        };
        Ok(Arc::new(Self {
            repository: Mutex::new(repository),
            photo_cache: Mutex::new(photo_cache),
            photo_cache_status: RwLock::new(PhotoCacheStatus::Refreshing),
            photo_cache_refresh: AtomicBool::new(true),
            telegram: Mutex::new(None),
            auth: RwLock::new(auth),
            profile: RwLock::new(None),
            choices: Mutex::new(choices),
            last_error: RwLock::new(None),
            photo_error: RwLock::new(None),
            photo_status_error: RwLock::new(None),
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
        tracing::info!("Logged out");
        Ok(())
    }
    pub async fn disconnect(&self) {
        *self.telegram.lock().await = None;
    }
    pub async fn state(&self) -> State {
        let auth = self.auth.read().await.clone();
        let photo_cache = self.photo_cache.lock().await;
        let repository = self.repository.lock().await;
        let library = repository.data.clone();
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
            .or(self.photo_status_error.read().await.clone())
            .or(self.emoji_error.read().await.clone());
        let recovery = if *self.photo_cache_status.read().await == PhotoCacheStatus::Ready
            && photo_cache.complete()
        {
            Self::photo_recovery(&photo_cache, &repository)
        } else {
            Default::default()
        };
        let photos = photo_cache
            .available()
            .into_iter()
            .map(|id| HistoryPhoto { id })
            .collect();
        State {
            auth,
            profile: self.profile.read().await.clone(),
            photo_cache: PhotoCacheView {
                status: *self.photo_cache_status.read().await,
                photos,
                recovery,
            },
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
        if emoji && !matches!(action, ScheduleAction::Stop) {
            repository.data.check_emoji_rotation()?;
        }
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
        let interval_seconds = settings.interval_secs;
        if emoji {
            repository.update(|library| library.update_emoji_settings(settings, now()))?;
            if repository.data.pending_photo_status.is_none() {
                *self.photo_status_error.write().await = None;
            }
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
        tracing::info!(
            rotation = if emoji { "emoji" } else { "photo" },
            interval_seconds,
            action = match action {
                ScheduleAction::Apply => "apply",
                ScheduleAction::Start => "start",
                ScheduleAction::Stop => "stop",
            },
            "Rotation schedule updated"
        );
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
    pub async fn set_photo_status(&self, id: &str, choice_id: Option<&str>) -> Result<()> {
        let status = match choice_id {
            Some(id) => Some(
                self.choices
                    .lock()
                    .await
                    .iter()
                    .find(|choice| choice.id == id)
                    .context(Message::new(
                        "emoji.catalog_refresh_required",
                        "Refresh the emoji catalog before selecting this emoji.",
                    ))?
                    .clone(),
            ),
            None => None,
        };
        let mut connection = self.lock_telegram().await;
        let queued = {
            let mut queued = false;
            let mut repository = self.repository.lock().await;
            let was_per_photo = repository.data.has_photo_statuses();
            repository.update(|library| {
                library.set_photo_status(id, status)?;
                if library.applied_settings.is_none()
                    && library
                        .pending_photo_status
                        .as_ref()
                        .is_some_and(|pending| pending.photo_id == id)
                {
                    library.pending_photo_status = None;
                }
                let entering_per_photo = !was_per_photo && library.has_photo_statuses();
                let active = library
                    .applied_settings
                    .as_ref()
                    .and_then(|_| {
                        library.photos.iter().find(|photo| {
                            library.last_photo_id.as_deref() == Some(photo.id.as_str())
                                && (photo.id == id || entering_per_photo)
                        })
                    })
                    .cloned();
                if let Some(photo) = active {
                    queued = true;
                    library.pending_photo_status = Some(PendingPhotoStatus {
                        photo_id: photo.id,
                        status_id: photo.emoji_status.map(|status| status.id),
                        retry_at: now(),
                    });
                }
                Ok(())
            })?;
            if queued || repository.data.pending_photo_status.is_none() {
                *self.photo_status_error.write().await = None;
            }
            queued
        };
        if queued {
            match connection.as_mut() {
                Some(telegram) => {
                    self.retry_photo_status(telegram).await?;
                    *self.profile.write().await = telegram.profile();
                }
                None => {
                    self.defer_photo_status(&unavailable()).await?;
                    return Err(unavailable().into());
                }
            }
        }
        Ok(())
    }

    async fn queue_photo_status(&self, id: &str) -> Result<(), TelegramError> {
        self.repository
            .lock()
            .await
            .update(|library| {
                library.pending_photo_status = if library.has_photo_statuses() {
                    library
                        .photos
                        .iter()
                        .find(|photo| photo.id == id)
                        .map(|photo| PendingPhotoStatus {
                            photo_id: photo.id.clone(),
                            status_id: photo.emoji_status.as_ref().map(|status| status.id.clone()),
                            retry_at: now(),
                        })
                } else {
                    None
                };
                Ok(())
            })
            .map_err(storage_error)?;
        *self.photo_status_error.write().await = None;
        Ok(())
    }

    async fn defer_photo_status(&self, error: &TelegramError) -> Result<(), TelegramError> {
        self.repository
            .lock()
            .await
            .update(|library| {
                if let Some(pending) = &mut library.pending_photo_status {
                    pending.retry_at = now()
                        .saturating_add(error.retry_after.unwrap_or(30).max(2))
                        .max(library.telegram_not_before.unwrap_or(0));
                }
                Ok(())
            })
            .map_err(storage_error)
    }

    async fn retry_photo_status(
        &self,
        telegram: &mut impl PhotoClient,
    ) -> Result<(), TelegramError> {
        let pending = {
            let mut repository = self.repository.lock().await;
            let Some(pending) = repository.data.pending_photo_status.clone() else {
                return Ok(());
            };
            if now()
                < pending
                    .retry_at
                    .max(repository.data.telegram_not_before.unwrap_or(0))
            {
                return Ok(());
            }
            repository
                .update(|library| {
                    library.pending_photo_status.as_mut().unwrap().retry_at =
                        now().saturating_add(30);
                    Ok(())
                })
                .map_err(storage_error)?;
            pending
        };
        if let Err(error) = telegram
            .set_emoji_status(pending.status_id.as_deref())
            .await
        {
            self.defer_photo_status(&error).await?;
            return Err(error);
        }
        self.repository
            .lock()
            .await
            .update(|library| {
                library.pending_photo_status = None;
                Ok(())
            })
            .map_err(storage_error)?;
        *self.photo_status_error.write().await = None;
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
    pub async fn add_local_photo(&self, name: &str, original: &[u8], jpeg: &[u8]) -> Result<()> {
        let cache = self.photo_cache.lock().await;
        let mut repository = self.repository.lock().await;
        let telegram_id = cache.matching(jpeg, |id| {
            !repository
                .data
                .photos
                .iter()
                .any(|photo| photo.telegram_id.as_deref() == Some(id))
        })?;
        let checked =
            *self.photo_cache_status.read().await == PhotoCacheStatus::Ready && cache.complete();
        repository.add_upload(name, original, jpeg, telegram_id, checked)
    }

    pub async fn refresh_photo_history(&self) {
        let _cache = self.photo_cache.lock().await;
        *self.photo_cache_status.write().await = PhotoCacheStatus::Refreshing;
        self.photo_cache_refresh.store(true, Ordering::Release);
    }

    async fn match_local_photos(&self) -> Result<()> {
        let cache = self.photo_cache.lock().await;
        let mut repository = self.repository.lock().await;
        if !cache.complete() {
            return Ok(());
        }
        let ids = cache.photos();
        let mut used: std::collections::HashSet<String> = repository
            .data
            .photos
            .iter()
            .filter_map(|photo| photo.telegram_id.as_ref())
            .filter(|id| ids.contains(id))
            .cloned()
            .collect();
        let mut changes = Vec::new();
        for photo in &repository.data.photos {
            if photo
                .telegram_id
                .as_ref()
                .is_some_and(|id| ids.contains(id))
            {
                if !photo.history_checked {
                    changes.push((photo.id.clone(), photo.telegram_id.clone()));
                }
                continue;
            }
            let Some(matches) = Self::recovery_matches(&cache, &repository, photo) else {
                continue;
            };
            let matched = matches.into_iter().find(|id| !used.contains(id));
            if let Some(id) = &matched {
                used.insert(id.clone());
            }
            let matched = matched.or_else(|| photo.telegram_id.clone());
            if photo.telegram_id != matched || !photo.history_checked {
                changes.push((photo.id.clone(), matched));
            }
        }
        if !changes.is_empty() {
            repository.update(|library| {
                for (id, telegram_id) in changes {
                    if let Some(photo) = library.photos.iter_mut().find(|photo| photo.id == id) {
                        photo.telegram_id = telegram_id;
                        photo.history_checked = true;
                    }
                }
                Ok(())
            })?;
        }
        Ok(())
    }

    fn recovery_matches(
        cache: &PhotoCache,
        repository: &Repository,
        photo: &Photo,
    ) -> Option<Vec<String>> {
        repository
            .photo_path(&photo.id)
            .ok()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| cache.matches(&bytes).ok())
            .or_else(|| {
                photo
                    .telegram_id
                    .as_deref()
                    .and_then(|id| cache.cached_matches(id))
            })
    }

    fn photo_recovery(
        cache: &PhotoCache,
        repository: &Repository,
    ) -> std::collections::HashMap<String, PhotoRecovery> {
        let ids = cache.photos();
        repository
            .data
            .photos
            .iter()
            .filter_map(|photo| {
                let id = photo.telegram_id.as_ref()?;
                if ids.contains(id) {
                    return None;
                }
                let matches = Self::recovery_matches(cache, repository, photo);
                let matched = matches.as_ref().and_then(|matches| {
                    matches
                        .iter()
                        .find(|id| {
                            !repository
                                .data
                                .photos
                                .iter()
                                .any(|other| other.telegram_id.as_ref() == Some(id))
                        })
                        .or_else(|| matches.first())
                });
                let duplicate_of = matched.and_then(|id| {
                    repository
                        .data
                        .photos
                        .iter()
                        .find(|other| {
                            other.id != photo.id && other.telegram_id.as_ref() == Some(id)
                        })
                        .map(|other| other.id.clone())
                });
                Some((
                    photo.id.clone(),
                    PhotoRecovery {
                        duplicate_of,
                        can_upload: matches.as_ref().is_some_and(|matches| matches.is_empty()),
                    },
                ))
            })
            .collect()
    }

    pub async fn remove_photo(&self, id: &str) -> Result<()> {
        {
            let _cache = self.photo_cache.lock().await;
            let mut repository = self.repository.lock().await;
            repository.remove_photo(id)?;
            if repository.data.pending_photo_status.is_none() {
                *self.photo_status_error.write().await = None;
            }
        }
        let ready = *self.photo_cache_status.read().await == PhotoCacheStatus::Ready;
        if ready && let Err(error) = self.match_local_photos().await {
            tracing::warn!(
                code = MessageInfo::from_error(&error).code,
                "Photo deleted; link reconciliation failed, requesting refresh"
            );
            self.refresh_photo_history().await;
        }
        Ok(())
    }

    pub async fn reupload_photo(&self, id: &str) -> Result<()> {
        let cache = self.photo_cache.lock().await;
        anyhow::ensure!(
            *self.photo_cache_status.read().await == PhotoCacheStatus::Ready && cache.complete(),
            Message::new(
                "photo.history_not_ready",
                "Photo history is not ready. Refresh it before recovering this photo."
            )
        );
        let mut repository = self.repository.lock().await;
        let photo = repository
            .data
            .photos
            .iter()
            .find(|photo| photo.id == id)
            .context(Message::new("photo.not_found", "Photo not found."))?;
        let recovery = Self::photo_recovery(&cache, &repository);
        let entry = recovery.get(id).context(Message::new(
            "photo.recovery_changed",
            "Photo is no longer awaiting recovery. Refresh the photo list.",
        ))?;
        anyhow::ensure!(
            entry.duplicate_of.is_none(),
            Message::new(
                "photo.recovery_duplicate",
                "This photo is already selected. Remove the duplicate instead."
            )
        );
        anyhow::ensure!(
            entry.can_upload,
            Message::new(
                "photo.recovery_unavailable",
                "This photo cannot be prepared for upload. Its bytes are missing or it can already be reused from history."
            )
        );
        let cached = photo.telegram_id.as_deref().and_then(|id| cache.image(id));
        repository.prepare_photo_reupload(id, cached.as_deref())
    }

    pub async fn match_cropped_photo(&self, id: &str) -> Result<()> {
        let cache = self.photo_cache.lock().await;
        if *self.photo_cache_status.read().await != PhotoCacheStatus::Ready || !cache.complete() {
            return Ok(());
        }
        let mut repository = self.repository.lock().await;
        let jpeg = std::fs::read(repository.photo_path(id)?)?;
        let matched = cache.matching(&jpeg, |id| {
            !repository
                .data
                .photos
                .iter()
                .any(|photo| photo.telegram_id.as_deref() == Some(id))
        })?;
        repository.update(|library| {
            if let Some(photo) = library.photos.iter_mut().find(|photo| photo.id == id) {
                photo.telegram_id = matched;
                photo.history_checked = true;
            }
            Ok(())
        })
    }

    async fn sync_photo_history(
        &self,
        telegram: &mut impl PhotoHistoryClient,
        sync: &mut PhotoCacheSync,
    ) -> Result<(), TelegramError> {
        if self.photo_cache_refresh.swap(false, Ordering::AcqRel) {
            *sync = PhotoCacheSync::History;
        }
        if matches!(sync, PhotoCacheSync::Ready) {
            return Ok(());
        }
        *self.photo_cache_status.write().await = PhotoCacheStatus::Refreshing;
        let result = self.sync_photo_history_step(telegram, sync).await;
        if let Err(error) = &result {
            *self.photo_cache_status.write().await = PhotoCacheStatus::Error;
            tracing::warn!(
                code = error.info.code,
                retry_after = error.retry_after,
                unauthorized = error.unauthorized,
                "Photo cache refresh failed"
            );
        }
        result
    }

    async fn update_photo_history(
        &self,
        telegram: &mut impl PhotoHistoryClient,
        sync: &mut PhotoCacheSync,
        retry_at: &mut u64,
    ) -> Result<(), TelegramError> {
        if now() < *retry_at && !self.photo_cache_refresh.load(Ordering::Acquire) {
            return Ok(());
        }
        match self.sync_photo_history(telegram, sync).await {
            Ok(()) => *retry_at = 0,
            Err(error) if blocks_telegram(&error) => return Err(error),
            Err(error) => {
                self.record_telegram_error(&error).await;
                *retry_at = now().saturating_add(30);
                tracing::info!(retry_in_seconds = 30, "Photo cache refresh retry scheduled");
            }
        }
        Ok(())
    }

    async fn sync_photo_history_step(
        &self,
        telegram: &mut impl PhotoHistoryClient,
        sync: &mut PhotoCacheSync,
    ) -> Result<(), TelegramError> {
        match sync {
            PhotoCacheSync::History => {
                let photos = telegram.photo_history().await?;
                self.photo_cache
                    .lock()
                    .await
                    .set_history(photos.into_iter().map(|photo| photo.id).collect())
                    .map_err(storage_error)?;
                *sync = PhotoCacheSync::Images;
            }
            PhotoCacheSync::Images => {
                let missing = self.photo_cache.lock().await.missing().into_iter().next();
                if let Some(id) = missing {
                    let Some(bytes) = telegram.history_photo(&id).await? else {
                        *sync = PhotoCacheSync::History;
                        return Err(TelegramError {
                            message: "Cannot download a Telegram profile photo.".into(),
                            info: MessageInfo::new("telegram.photo_unavailable"),
                            retry_after: None,
                            unauthorized: false,
                        });
                    };
                    self.photo_cache
                        .lock()
                        .await
                        .store(&id, &bytes)
                        .map_err(storage_error)?;
                } else {
                    self.match_local_photos().await.map_err(storage_error)?;
                    *self.photo_cache_status.write().await = PhotoCacheStatus::Ready;
                    *sync = PhotoCacheSync::Ready;
                    tracing::info!("Photo cache refresh completed");
                }
            }
            PhotoCacheSync::Ready => {}
        }
        Ok(())
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
        tracing::info!("QR authentication started");
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
        tracing::info!(
            authorized = auth.status == "authorized",
            "Password authentication completed"
        );
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
                tracing::warn!(
                    code = "storage.cooldown_save_failed",
                    "Telegram cooldown could not be persisted"
                );
                *self.last_error.write().await = Some(LocalizedMessage::new(
                    "Telegram requested a cooldown, but Celine could not persist it. Check disk space and directory permissions before restarting.",
                    MessageInfo::parameter("storage.cooldown_save_failed", "seconds", wait),
                ));
            }
        }
        if error.unauthorized {
            *self.profile.write().await = None;
            let mut auth = self.auth.write().await;
            if auth.status != "disconnected" {
                tracing::info!("Authorization expired; disconnected");
            }
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
        let mut photo_cache_sync = PhotoCacheSync::History;
        let mut photo_cache_retry_at = 0;
        loop {
            if now() >= retry_at {
                match self
                    .tick(
                        credentials,
                        &mut photo_cache_sync,
                        &mut photo_cache_retry_at,
                    )
                    .await
                {
                    Ok(()) => {}
                    Err(error) => {
                        let mut status = self.photo_cache_status.write().await;
                        if *status == PhotoCacheStatus::Refreshing {
                            *status = PhotoCacheStatus::Error;
                        }
                        drop(status);
                        self.record_telegram_error(&error).await;
                        let retry_in_seconds = error.retry_after.unwrap_or(30).max(2);
                        retry_at = now().saturating_add(retry_in_seconds);
                        tracing::warn!(
                            code = error.info.code,
                            retry_after = error.retry_after,
                            unauthorized = error.unauthorized,
                            retry_in_seconds,
                            "Background work failed; retry scheduled"
                        );
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    async fn tick(
        &self,
        credentials: Credentials,
        photo_cache_sync: &mut PhotoCacheSync,
        photo_cache_retry_at: &mut u64,
    ) -> Result<(), TelegramError> {
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
        {
            let mut previous = self.auth.write().await;
            if previous.status != auth.status {
                tracing::info!(
                    authorized,
                    password_required = auth.status == "password",
                    "Authentication state changed"
                );
            }
            *previous = auth;
        }
        *self.profile.write().await = if authorized { telegram.profile() } else { None };
        if authorized {
            if !premium {
                self.stop_nonpremium_emoji_rotation().await?;
            }
            if let Err(mut error) = self.rotate_photos_if_due(telegram).await {
                tracing::warn!(
                    code = error.info.code,
                    retry_after = error.retry_after,
                    unauthorized = error.unauthorized,
                    "Photo rotation failed"
                );
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
            if let Err(mut error) = self.retry_photo_status(telegram).await {
                tracing::warn!(code = error.info.code, "Photo status update failed");
                error.info.params["context"] = "photo".into();
                *self.photo_status_error.write().await = Some(LocalizedMessage::new(
                    format!("Photo status: {}", error.message),
                    error.message_info(),
                ));
                self.record_telegram_error(&error).await;
                if blocks_telegram(&error) {
                    return Err(error);
                }
            }
            if let Err(mut error) = self.rotate_emojis_if_due(telegram).await {
                tracing::warn!(
                    code = error.info.code,
                    retry_after = error.retry_after,
                    unauthorized = error.unauthorized,
                    "Emoji rotation failed"
                );
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
            self.update_photo_history(telegram, photo_cache_sync, photo_cache_retry_at)
                .await?;
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
            tracing::info!("Emoji rotation stopped: Premium required");
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
            if photo.telegram_id.is_none()
                && self
                    .repository
                    .lock()
                    .await
                    .photo_path(&photo.id)
                    .map_err(storage_error)?
                    .exists()
            {
                let status = *self.photo_cache_status.read().await;
                if status != PhotoCacheStatus::Ready || !photo.history_checked {
                    if status == PhotoCacheStatus::Ready {
                        self.refresh_photo_history().await;
                    }
                    self.repository
                        .lock()
                        .await
                        .retry_photo_rotation(revision, now(), 2)
                        .map_err(storage_error)?;
                    return Ok(());
                }
            }
            match self.rotate_photo(telegram, &photo).await {
                Ok(true) => {
                    self.repository
                        .lock()
                        .await
                        .complete_photo_rotation(&photo.id)
                        .map_err(storage_error)?;
                    *self.photo_error.write().await = None;
                    self.queue_photo_status(&photo.id).await?;
                    tracing::info!("Photo rotation completed");
                    return Ok(());
                }
                Ok(false) => {
                    tracing::info!("Photo rotation candidate unavailable; skipping");
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
        if matched.is_some()
            && let Some((id, bytes)) = &current
        {
            self.photo_cache
                .lock()
                .await
                .remember(id, bytes)
                .map_err(storage_error)?;
        }
        let mut repository = self.repository.lock().await;
        if !repository.photo_schedule_is_current(revision) {
            return Ok(());
        }
        repository
            .update(|library| {
                library.photo_start_pending = false;
                library.last_photo_id = matched.clone();
                if let Some(matched) = &matched {
                    let photo = library
                        .photos
                        .iter_mut()
                        .find(|photo| photo.id == *matched)
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
            .map_err(storage_error)?;
        drop(repository);
        if let Some(id) = matched {
            self.queue_photo_status(&id).await?;
        }
        Ok(())
    }

    async fn rotate_photo(
        &self,
        telegram: &mut impl PhotoClient,
        photo: &Photo,
    ) -> Result<bool, TelegramError> {
        if let Some(id) = &photo.telegram_id {
            {
                let cache = self.photo_cache.lock().await;
                if *self.photo_cache_status.read().await == PhotoCacheStatus::Ready
                    && cache.complete()
                    && !cache.photos().contains(id)
                {
                    return Ok(false);
                }
            }
            tracing::info!(method = "history", "Photo change attempted");
            let result = telegram.use_history_photo(id).await;
            if matches!(result, Ok(false)) {
                self.refresh_photo_history().await;
            }
            if let Ok(applied) = &result {
                tracing::info!(method = "history", applied, "Photo change completed");
            }
            return result;
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
        self.repository
            .lock()
            .await
            .mark_photo_uploading(&photo.id)
            .map_err(storage_error)?;
        tracing::info!(method = "upload", "Photo change attempted");
        let id = telegram.set_photo(&path).await?;
        tracing::info!(method = "upload", applied = true, "Photo change completed");
        self.photo_cache
            .lock()
            .await
            .remember(&id, &jpeg)
            .map_err(storage_error)?;
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
        tracing::info!("Emoji rotation attempted");
        telegram.set_emoji_status(Some(&id)).await?;
        self.repository
            .lock()
            .await
            .update(|library| {
                library.last_emoji_id = Some(id);
                Ok(())
            })
            .map_err(storage_error)?;
        *self.emoji_error.write().await = None;
        tracing::info!("Emoji rotation completed");
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
fn storage_error(error: anyhow::Error) -> TelegramError {
    tracing::warn!(
        io_kind = ?error.downcast_ref::<std::io::Error>().map(std::io::Error::kind),
        "Celine state operation failed"
    );
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
        Upload(&'static str),
        Status(Option<&'static str>, Result<(), TelegramError>),
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
        async fn set_emoji_status(&mut self, id: Option<&str>) -> Result<(), TelegramError> {
            let Some(PhotoCall::Status(expected, result)) = self.0.pop_front() else {
                panic!("unexpected status update")
            };
            assert_eq!(id, expected);
            result
        }
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
        async fn set_photo(&mut self, path: &std::path::Path) -> Result<String, TelegramError> {
            let Some(PhotoCall::Upload(id)) = self.0.pop_front() else {
                panic!("unexpected upload");
            };
            assert_eq!(
                std::fs::read(path).unwrap(),
                include_bytes!("../web/public/logo.jpg")
            );
            Ok(id.into())
        }
    }

    async fn rotate_with_status(
        app: &App,
        client: &mut impl PhotoClient,
    ) -> Result<(), TelegramError> {
        app.rotate_photos_if_due(client).await?;
        app.retry_photo_status(client).await
    }

    fn status_choice() -> EmojiChoice {
        serde_json::from_value(serde_json::json!({"id":"collectible:100","document_id":"42","label":"Gift","source":"Gift","text_color":false})).unwrap()
    }

    #[tokio::test]
    async fn photo_statuses_apply_clear_and_do_not_replay_photo_after_status_failure() {
        let mut first = photo("a", Some("1"), true);
        first.emoji_status = Some(status_choice());
        let (_dir, app) = photo_app(vec![first, photo("b", Some("2"), true)]).await;
        let mut client = FakePhotos::new([
            PhotoCall::Use("1", Ok(true)),
            PhotoCall::Status(Some("collectible:100"), Err(unavailable())),
        ]);
        assert!(rotate_with_status(&app, &mut client).await.is_err());
        client.assert_finished();
        let library = app.state().await.library;
        assert_eq!(library.last_photo_id.as_deref(), Some("a"));
        assert!(library.pending_photo_id.is_none());
        app.rotate_photos_if_due(&mut FakePhotos::new([]))
            .await
            .unwrap();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.next_rotation_at = Some(0);
                Ok(())
            })
            .unwrap();
        let mut client = FakePhotos::new([
            PhotoCall::Use("2", Ok(true)),
            PhotoCall::Status(None, Ok(())),
        ]);
        rotate_with_status(&app, &mut client).await.unwrap();
        client.assert_finished();
    }

    async fn retry_status_now(app: &App, expected: Option<&'static str>) {
        app.repository
            .lock()
            .await
            .update(|library| {
                library.pending_photo_status.as_mut().unwrap().retry_at = 0;
                library.telegram_not_before = None;
                Ok(())
            })
            .unwrap();
        let mut client = FakePhotos::new([PhotoCall::Status(expected, Ok(()))]);
        app.retry_photo_status(&mut client).await.unwrap();
        client.assert_finished();
        assert!(app.state().await.library.pending_photo_status.is_none());
    }

    #[tokio::test]
    async fn failed_photo_status_retries_after_restart_without_replaying_photo_even_when_stopped() {
        let mut first = photo("a", Some("1"), true);
        first.emoji_status = Some(status_choice());
        let (dir, app) = photo_app(vec![first]).await;
        let mut error = unavailable();
        error.retry_after = Some(60);
        let mut client = FakePhotos::new([
            PhotoCall::Use("1", Ok(true)),
            PhotoCall::Status(Some("collectible:100"), Err(error)),
        ]);
        let before = now();
        assert!(rotate_with_status(&app, &mut client).await.is_err());
        client.assert_finished();
        assert!(
            app.state()
                .await
                .library
                .pending_photo_status
                .unwrap()
                .retry_at
                >= before + 60
        );
        app.retry_photo_status(&mut FakePhotos::new([]))
            .await
            .unwrap();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.applied_settings = None;
                Ok(())
            })
            .unwrap();
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        assert_eq!(
            app.state()
                .await
                .library
                .pending_photo_status
                .unwrap()
                .photo_id,
            "a"
        );
        retry_status_now(&app, Some("collectible:100")).await;
        app.rotate_photos_if_due(&mut FakePhotos::new([]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn failed_active_edits_replace_pending_status_and_standalone_start_cancels_clear() {
        let (_dir, app) = photo_app(vec![photo("a", Some("1"), true)]).await;
        app.remember_choices(&[status_choice()]).await;
        app.repository
            .lock()
            .await
            .update(|library| {
                library.last_photo_id = Some("a".into());
                Ok(())
            })
            .unwrap();
        assert!(
            app.set_photo_status("a", Some("collectible:100"))
                .await
                .is_err()
        );
        retry_status_now(&app, Some("collectible:100")).await;
        assert!(app.set_photo_status("a", None).await.is_err());
        assert!(
            app.state()
                .await
                .library
                .pending_photo_status
                .unwrap()
                .status_id
                .is_none()
        );
        retry_status_now(&app, None).await;
        assert!(
            app.set_photo_status("a", Some("collectible:100"))
                .await
                .is_err()
        );
        assert!(app.set_photo_status("a", None).await.is_err());
        app.repository
            .lock()
            .await
            .update(|library| {
                library.select_emojis(vec![status_choice()]);
                library.update_emoji_settings(
                    Settings {
                        enabled: true,
                        ..Settings::default()
                    },
                    now(),
                )
            })
            .unwrap();
        assert!(app.state().await.library.pending_photo_status.is_none());
        app.retry_photo_status(&mut FakePhotos::new([]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stopped_photo_edits_cancel_obsolete_status_retry_and_error() {
        for replacement in [None, Some("43")] {
            let (_dir, app) = photo_app(vec![photo("a", Some("1"), true)]).await;
            let mut other = status_choice();
            other.id = "43".into();
            app.remember_choices(&[status_choice(), other]).await;
            app.repository
                .lock()
                .await
                .update(|library| {
                    library.last_photo_id = Some("a".into());
                    Ok(())
                })
                .unwrap();
            assert!(
                app.set_photo_status("a", Some("collectible:100"))
                    .await
                    .is_err()
            );
            *app.photo_status_error.write().await = Some("Status failed".into());
            app.schedule(false, ScheduleAction::Stop).await.unwrap();
            app.set_photo_status("a", replacement).await.unwrap();
            assert!(app.state().await.library.pending_photo_status.is_none());
            assert!(app.photo_status_error.read().await.is_none());
            app.retry_photo_status(&mut FakePhotos::new([]))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn successful_status_retry_preserves_unresolved_photo_error() {
        let (_dir, app) = photo_app(vec![photo("a", Some("1"), true)]).await;
        app.remember_choices(&[status_choice()]).await;
        app.repository
            .lock()
            .await
            .update(|library| {
                library.last_photo_id = Some("a".into());
                Ok(())
            })
            .unwrap();
        assert!(
            app.set_photo_status("a", Some("collectible:100"))
                .await
                .is_err()
        );
        *app.photo_error.write().await = Some("Photo change failed".into());
        *app.photo_status_error.write().await = Some("Status failed".into());
        retry_status_now(&app, Some("collectible:100")).await;
        assert!(app.photo_status_error.read().await.is_none());
        assert_eq!(
            app.state().await.last_error.as_deref(),
            Some("Photo change failed")
        );
    }

    #[tokio::test]
    async fn deleting_photo_cancels_pending_status() {
        let (_dir, app) = photo_app(vec![photo("a", Some("1"), true)]).await;
        app.remember_choices(&[status_choice()]).await;
        app.repository
            .lock()
            .await
            .update(|library| {
                library.last_photo_id = Some("a".into());
                Ok(())
            })
            .unwrap();
        assert!(
            app.set_photo_status("a", Some("collectible:100"))
                .await
                .is_err()
        );
        app.remove_photo("a").await.unwrap();
        assert!(app.state().await.library.pending_photo_status.is_none());
    }

    #[tokio::test]
    async fn entering_photo_status_mode_syncs_current_unassigned_photo_only_when_running() {
        for running in [true, false] {
            let (_dir, app) = photo_app(vec![
                photo("a", Some("1"), true),
                photo("b", Some("2"), true),
            ])
            .await;
            app.remember_choices(&[status_choice()]).await;
            app.repository
                .lock()
                .await
                .update(|library| {
                    library.last_photo_id = Some("a".into());
                    if !running {
                        library.applied_settings = None;
                    }
                    Ok(())
                })
                .unwrap();
            // No Telegram connection: a sync attempt reports unavailable, but the association persists.
            let result = app.set_photo_status("b", Some("collectible:100")).await;
            assert_eq!(result.is_err(), running);
            assert!(app.state().await.library.photos[1].emoji_status.is_some());
        }
    }

    #[tokio::test]
    async fn persisted_photo_status_remains_authorized_and_remembered_after_restart() {
        let (dir, app) = photo_app(vec![photo("a", Some("1"), true)]).await;
        app.remember_choices(&[status_choice()]).await;
        app.set_photo_status("a", Some("collectible:100"))
            .await
            .unwrap();
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        {
            let repository = app.repository.lock().await;
            assert!(repository.data.selected_emojis.is_empty());
            assert!(repository.data.has_saved_emoji_document(42));
            assert!(!repository.data.has_saved_emoji_document(100));
        }
        app.select_emojis(&["collectible:100".into()])
            .await
            .unwrap();
        assert_eq!(
            app.state().await.library.selected_emojis[0]
                .document_id
                .as_deref(),
            Some("42")
        );
        app.set_photo_status("a", None).await.unwrap();
        app.select_emojis(&[]).await.unwrap();
        assert!(
            !app.repository
                .lock()
                .await
                .data
                .has_saved_emoji_document(42)
        );
    }

    #[tokio::test]
    async fn recognized_current_photo_syncs_status_without_changing_photo() {
        let mut first = photo("a", Some("1"), true);
        first.emoji_status = Some(status_choice());
        let (_dir, app) = photo_app(vec![first]).await;
        app.repository
            .lock()
            .await
            .update(|library| {
                library.photo_start_pending = true;
                Ok(())
            })
            .unwrap();
        let mut client = FakePhotos::new([
            PhotoCall::Current(Some((
                "1",
                include_bytes!("../web/public/logo.jpg").to_vec(),
            ))),
            PhotoCall::Status(Some("collectible:100"), Err(unavailable())),
        ]);
        assert!(rotate_with_status(&app, &mut client).await.is_err());
        client.assert_finished();
        assert!(!app.state().await.library.photo_start_pending);
        retry_status_now(&app, Some("collectible:100")).await;
    }

    #[tokio::test]
    async fn stale_cached_photos_relink_and_report_duplicates_without_removal() {
        let (_dir, app) = photo_app(vec![
            photo("stale", Some("1"), true),
            photo("current", Some("2"), true),
        ])
        .await;
        let bytes = include_bytes!("../web/public/logo.jpg");
        {
            let mut cache = app.photo_cache.lock().await;
            cache.set_history(vec!["1".into()]).unwrap();
            cache.store("1", bytes).unwrap();
            cache.set_history(vec!["2".into()]).unwrap();
            cache.store("2", bytes).unwrap();
        }
        app.match_local_photos().await.unwrap();
        let state = app.state().await;
        assert_eq!(state.library.photos.len(), 2);
        assert_eq!(state.library.photos[0].telegram_id.as_deref(), Some("1"));
        assert_eq!(
            state.photo_cache.recovery["stale"].duplicate_of.as_deref(),
            Some("current")
        );
        assert!(app.reupload_photo("stale").await.is_err());
        app.remove_photo("current").await.unwrap();
        let state = app.state().await;
        assert_eq!(state.library.photos[0].telegram_id.as_deref(), Some("2"));
        assert!(state.photo_cache.recovery.is_empty());
    }

    #[tokio::test]
    async fn stale_cached_photo_requires_explicit_reupload_and_usable_bytes() {
        let (_dir, app) = photo_app(vec![
            photo("cached", Some("1"), true),
            photo("missing", Some("3"), true),
        ])
        .await;
        let bytes = include_bytes!("../web/public/logo.jpg");
        {
            let mut cache = app.photo_cache.lock().await;
            cache.set_history(vec!["1".into()]).unwrap();
            cache.store("1", bytes).unwrap();
            cache.set_history(vec![]).unwrap();
        }
        app.match_local_photos().await.unwrap();
        let state = app.state().await;
        assert!(state.photo_cache.recovery["cached"].can_upload);
        assert!(!state.photo_cache.recovery["missing"].can_upload);
        let error = app.reupload_photo("missing").await.unwrap_err();
        assert_eq!(
            MessageInfo::from_error(&error).code,
            "photo.recovery_unavailable"
        );
        let error = app.reupload_photo("removed").await.unwrap_err();
        assert_eq!(MessageInfo::from_error(&error).code, "photo.not_found");
        app.reupload_photo("cached").await.unwrap();
        let repository = app.repository.lock().await;
        assert!(repository.data.photos[0].telegram_id.is_none());
        assert!(repository.data.photos[0].history_checked);
        assert_eq!(
            std::fs::read(repository.photo_path("cached").unwrap()).unwrap(),
            bytes
        );
        drop(repository);
        let error = app.reupload_photo("cached").await.unwrap_err();
        assert_eq!(
            MessageInfo::from_error(&error).code,
            "photo.recovery_changed"
        );
    }

    #[tokio::test]
    async fn recovery_and_queued_upload_survive_restart() {
        let (dir, app) = photo_app(vec![photo("cached", Some("1"), true)]).await;
        {
            let mut cache = app.photo_cache.lock().await;
            cache.set_history(vec!["1".into()]).unwrap();
            cache
                .store("1", include_bytes!("../web/public/logo.jpg"))
                .unwrap();
            cache.set_history(vec![]).unwrap();
        }
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        app.sync_photo_history_step(
            &mut FakeHistory(VecDeque::new()),
            &mut PhotoCacheSync::Images,
        )
        .await
        .unwrap();
        assert!(app.state().await.photo_cache.recovery["cached"].can_upload);
        app.reupload_photo("cached").await.unwrap();
        drop(app);
        let app = App::open(dir.path().into(), None).unwrap();
        app.sync_photo_history_step(
            &mut FakeHistory(VecDeque::new()),
            &mut PhotoCacheSync::Images,
        )
        .await
        .unwrap();
        assert!(app.state().await.photo_cache.recovery.is_empty());
        let mut client = FakePhotos::new([PhotoCall::Upload("2")]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
        assert_eq!(
            app.state().await.library.photos[0].telegram_id.as_deref(),
            Some("2")
        );
        assert!(app.photo_cache.lock().await.image("1").is_some());
    }

    #[tokio::test]
    async fn unclaimed_match_disables_reupload_and_is_preferred_to_selected_match() {
        let (_dir, app) = photo_app(vec![
            photo("stale", Some("1"), true),
            photo("selected", Some("2"), true),
        ])
        .await;
        {
            let mut cache = app.photo_cache.lock().await;
            cache.set_history(vec!["1".into()]).unwrap();
            cache
                .store("1", include_bytes!("../web/public/logo.jpg"))
                .unwrap();
            cache.set_history(vec!["2".into(), "3".into()]).unwrap();
            for id in ["2", "3"] {
                cache
                    .store(id, include_bytes!("../web/public/logo.jpg"))
                    .unwrap();
            }
        }
        let state = app.state().await;
        let recovery = &state.photo_cache.recovery["stale"];
        assert!(!recovery.can_upload);
        assert!(recovery.duplicate_of.is_none());
        let error = app.reupload_photo("stale").await.unwrap_err();
        assert_eq!(
            MessageInfo::from_error(&error).code,
            "photo.recovery_unavailable"
        );
        app.match_local_photos().await.unwrap();
        assert_eq!(
            app.state().await.library.photos[0].telegram_id.as_deref(),
            Some("3")
        );
    }

    #[tokio::test]
    async fn ready_absence_skips_history_use_but_unknown_rejection_refreshes() {
        let (_dir, app) = photo_app(vec![photo("stale", Some("1"), true)]).await;
        app.photo_cache.lock().await.set_history(vec![]).unwrap();
        let mut client = FakePhotos::new([]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
        let (_dir, app) = photo_app(vec![photo("stale", Some("1"), true)]).await;
        let mut client = FakePhotos::new([PhotoCall::Use("1", Ok(false))]);
        app.rotate_photos_if_due(&mut client).await.unwrap();
        client.assert_finished();
        assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Refreshing);
        assert_eq!(
            app.state().await.library.photos[0].telegram_id.as_deref(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn reconciliation_does_not_publish_ready_during_requested_refresh() {
        let (_dir, app) = photo_app(vec![photo("stale", Some("1"), false)]).await;
        app.refresh_photo_history().await;
        app.match_local_photos().await.unwrap();
        assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Refreshing);
        assert!(app.photo_cache_refresh.load(Ordering::Acquire));
        app.remove_photo("stale").await.unwrap();
        assert!(app.state().await.library.photos.is_empty());
        assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Refreshing);
        assert!(app.photo_cache_refresh.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn incomplete_history_cannot_report_absence_or_prepare_upload() {
        let (_dir, app) = photo_app(vec![photo("stale", Some("1"), false)]).await;
        app.photo_cache
            .lock()
            .await
            .set_history(vec!["2".into()])
            .unwrap();
        app.match_local_photos().await.unwrap();
        assert!(app.state().await.photo_cache.recovery.is_empty());
        assert!(!app.state().await.library.photos[0].history_checked);
        assert!(app.reupload_photo("stale").await.is_err());
    }

    struct TransitioningPhoto {
        app: Arc<App>,
        action: ScheduleAction,
        fail: bool,
    }

    impl PhotoClient for TransitioningPhoto {
        async fn set_emoji_status(&mut self, _id: Option<&str>) -> Result<(), TelegramError> {
            panic!("unexpected status update")
        }
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
            emoji_status: None,
        }
    }

    async fn photo_app(photos: Vec<Photo>) -> (tempfile::TempDir, Arc<App>) {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        app.photo_cache
            .lock()
            .await
            .set_history(
                photos
                    .iter()
                    .filter_map(|photo| photo.telegram_id.clone())
                    .collect(),
            )
            .unwrap();
        *app.photo_cache_status.write().await = PhotoCacheStatus::Ready;
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
        std::fs::write(path, include_bytes!("../web/public/logo.jpg")).unwrap();
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

    enum HistoryCall {
        List(Vec<&'static str>),
        Image(&'static str, Result<Option<Vec<u8>>, TelegramError>),
    }

    struct FakeHistory(VecDeque<HistoryCall>);

    impl PhotoHistoryClient for FakeHistory {
        async fn photo_history(&mut self) -> Result<Vec<HistoryPhoto>, TelegramError> {
            let Some(HistoryCall::List(ids)) = self.0.pop_front() else {
                panic!("unexpected history listing");
            };
            Ok(ids
                .into_iter()
                .map(|id| HistoryPhoto { id: id.into() })
                .collect())
        }

        async fn history_photo(&mut self, id: &str) -> Result<Option<Vec<u8>>, TelegramError> {
            let Some(HistoryCall::Image(expected, result)) = self.0.pop_front() else {
                panic!("unexpected history download");
            };
            assert_eq!(id, expected);
            result
        }
    }

    #[tokio::test]
    async fn cache_refresh_reuses_downloads_and_resumes_after_error() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let jpeg = include_bytes!("../web/public/logo.jpg");
        {
            let mut cache = app.photo_cache.lock().await;
            cache.set_history(vec!["1".into()]).unwrap();
            cache.store("1", jpeg).unwrap();
        }
        app.add_local_photo("local", jpeg, jpeg).await.unwrap();
        assert_eq!(
            app.state().await.library.photos[0].telegram_id.as_deref(),
            Some("1")
        );
        let mut client = FakeHistory(VecDeque::from([
            HistoryCall::List(vec!["1", "2"]),
            HistoryCall::Image("2", Err(unavailable())),
            HistoryCall::Image("2", Ok(Some(jpeg.to_vec()))),
        ]));
        let mut sync = PhotoCacheSync::History;
        app.sync_photo_history(&mut client, &mut sync)
            .await
            .unwrap();
        assert!(
            app.sync_photo_history(&mut client, &mut sync)
                .await
                .is_err()
        );
        assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Error);
        assert!(!app.photo_cache.lock().await.complete());
        app.sync_photo_history(&mut client, &mut sync)
            .await
            .unwrap();
        app.sync_photo_history(&mut client, &mut sync)
            .await
            .unwrap();
        assert!(client.0.is_empty());
        assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Ready);
        assert!(app.photo_cache.lock().await.complete());
        assert!(app.state().await.library.photos[0].history_checked);
    }

    #[tokio::test]
    async fn missing_history_photo_rechecks_history_without_blocking_other_work() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let mut client = FakeHistory(VecDeque::from([
            HistoryCall::List(vec!["1"]),
            HistoryCall::Image("1", Ok(None)),
            HistoryCall::List(vec![]),
        ]));
        let mut sync = PhotoCacheSync::History;
        let mut retry_at = 0;
        app.update_photo_history(&mut client, &mut sync, &mut retry_at)
            .await
            .unwrap();
        app.update_photo_history(&mut client, &mut sync, &mut retry_at)
            .await
            .unwrap();
        assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Error);
        assert!(retry_at > now());
        // A cache failure backs off on its own; scheduler ticks can continue.
        app.update_photo_history(&mut client, &mut sync, &mut retry_at)
            .await
            .unwrap();
        assert_eq!(client.0.len(), 1);
        retry_at = 0;
        app.update_photo_history(&mut client, &mut sync, &mut retry_at)
            .await
            .unwrap();
        app.update_photo_history(&mut client, &mut sync, &mut retry_at)
            .await
            .unwrap();
        assert!(client.0.is_empty());
        assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Ready);
    }

    #[tokio::test]
    async fn local_matching_uses_another_available_telegram_photo() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let jpeg = include_bytes!("../web/public/logo.jpg");
        {
            let mut cache = app.photo_cache.lock().await;
            cache.set_history(vec!["1".into(), "2".into()]).unwrap();
            cache.store("1", jpeg).unwrap();
            cache.store("2", jpeg).unwrap();
        }
        *app.photo_cache_status.write().await = PhotoCacheStatus::Ready;
        app.add_local_photo("first", b"first original", jpeg)
            .await
            .unwrap();
        app.add_local_photo("second", b"second original", jpeg)
            .await
            .unwrap();
        let photos = app.state().await.library.photos;
        assert_eq!(photos[0].telegram_id.as_deref(), Some("1"));
        assert_eq!(photos[1].telegram_id.as_deref(), Some("2"));
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
    async fn legacy_photo_waits_for_history_before_considering_upload() {
        for matched in [true, false] {
            let (_dir, app) = photo_app(vec![photo("a", None, false)]).await;
            write_photo(&app, "a").await;
            let mut client = FakePhotos::new([]);
            app.rotate_photos_if_due(&mut client).await.unwrap();
            client.assert_finished();
            assert!(*app.photo_cache_status.read().await == PhotoCacheStatus::Refreshing);
            if matched {
                let mut cache = app.photo_cache.lock().await;
                cache.set_history(vec!["101".into()]).unwrap();
                cache
                    .store("101", include_bytes!("../web/public/logo.jpg"))
                    .unwrap();
            }
            app.sync_photo_history_step(
                &mut FakeHistory(VecDeque::new()),
                &mut PhotoCacheSync::Images,
            )
            .await
            .unwrap();
            make_photo_due(&app).await;
            let next = if matched {
                PhotoCall::Use("101", Ok(true))
            } else {
                PhotoCall::Upload("101")
            };
            let mut client = FakePhotos::new([next]);
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
            document_id: None,
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
                    emoji_status: None,
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
            document_id: None,
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
            document_id: None,
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
