//! Telegram's user-account API. Credentials, QR tokens, passwords, and raw
//! upstream errors are never logged. The caller serializes access to this domain.

use crate::messages::MessageInfo;

use std::{
    collections::HashMap,
    fmt,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use grammers_client::{InvocationError, tl};
use qrcode::{QrCode, render::svg};
use serde::{Deserialize, Serialize};

mod connection;
use connection::{Connection, Login};

#[derive(Clone, Debug, Serialize)]
pub struct HistoryPhoto {
    pub id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AuthState {
    pub status: String,
    pub qr_svg: Option<String>,
    pub expires_at: Option<u64>,
    pub name: Option<String>,
    pub premium: bool,
    pub message: Option<String>,
    pub message_info: Option<MessageInfo>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmojiSource {
    Recent,
    Default,
    Pack,
    Search,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EmojiChoice {
    // Decimal strings preserve Telegram's 64-bit IDs in JavaScript.
    pub id: String,
    pub label: String,
    pub source: String,
    #[serde(default)]
    pub source_kind: Option<EmojiSource>,
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub text_color: bool,
}

#[derive(Debug, Deserialize)]
pub struct EmojiSearch {
    pub q: String,
    #[serde(default)]
    pub emoticon: String,
    pub lang: Option<String>,
    #[serde(default)]
    pub offset: i32,
}

impl EmojiSearch {
    fn request(&self) -> tl::functions::messages::SearchStickers {
        tl::functions::messages::SearchStickers {
            emojis: true,
            q: self.q.trim().into(),
            emoticon: self.emoticon.clone(),
            lang_code: self
                .lang
                .as_deref()
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|language| !language.is_empty())
                .map(str::to_owned)
                .collect(),
            offset: self.offset,
            limit: 100,
            hash: 0,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct EmojiSearchResults {
    pub choices: Vec<EmojiChoice>,
    pub next_offset: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Profile {
    pub name: String,
    pub premium: bool,
    pub photo_url: Option<String>,
    pub emoji: Option<ProfileEmoji>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProfileEmoji {
    pub id: String,
    pub label: String,
    pub media_url: String,
    pub format: String,
    pub expires_at: Option<u64>,
    pub text_color: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct EmojiSet {
    pub id: String,
    pub title: String,
    pub cover_url: String,
    pub count: i32,
    pub text_color: bool,
}

/// Safe to expose to the local UI. Deliberately does not retain a raw error.
#[derive(Clone, Debug, Serialize)]
pub struct TelegramError {
    pub message: String,
    pub info: MessageInfo,
    pub retry_after: Option<u64>,
    pub unauthorized: bool,
}

impl TelegramError {
    pub fn message_info(&self) -> MessageInfo {
        let mut info = self.info.clone();
        if let Some(seconds) = self.retry_after {
            info.params["seconds"] = seconds.into();
        }
        info
    }
    fn message(code: &'static str, message: &str) -> Self {
        Self {
            message: message.into(),
            info: MessageInfo::new(code),
            retry_after: None,
            unauthorized: false,
        }
    }
}

impl fmt::Display for TelegramError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TelegramError {}

impl From<InvocationError> for TelegramError {
    fn from(error: InvocationError) -> Self {
        log_invocation_error(&error);
        match error {
            InvocationError::Rpc(rpc) if rpc.code == 420 => Self {
                info: crate::messages::MessageInfo::new("telegram.rate_limited"),
                message: "Telegram rate limit reached. Wait before retrying.".into(),
                retry_after: Some(u64::from(rpc.value.unwrap_or(30)).max(1)),
                unauthorized: false,
            },
            InvocationError::Rpc(rpc) if rpc.name == "SESSION_PASSWORD_NEEDED" => Self::message(
                "telegram.password_required",
                "Enter your Telegram two-step verification password.",
            ),
            InvocationError::Rpc(rpc)
                if rpc.code == 401
                    || matches!(
                        rpc.name.as_str(),
                        "SESSION_REVOKED"
                            | "SESSION_EXPIRED"
                            | "AUTH_KEY_UNREGISTERED"
                            | "AUTH_KEY_DUPLICATED"
                            | "USER_DEACTIVATED"
                            | "USER_DEACTIVATED_BAN"
                    ) =>
            {
                Self {
                    info: crate::messages::MessageInfo::new("telegram.session_unauthorized"),
                    message: "Telegram session is no longer authorized. Sign in again.".into(),
                    retry_after: None,
                    unauthorized: true,
                }
            }
            InvocationError::Rpc(rpc) if rpc.name == "PASSWORD_HASH_INVALID" => Self::message(
                "telegram.password_incorrect",
                "Incorrect Telegram two-step verification password.",
            ),
            InvocationError::Rpc(rpc) if rpc.name == "SRP_ID_INVALID" => Self::message(
                "telegram.password_challenge_expired",
                "The password challenge expired. Submit your password again.",
            ),
            InvocationError::Io(_) | InvocationError::Dropped(_) => Self::message(
                "telegram.connection_unavailable",
                "Telegram connection is unavailable. Please retry.",
            ),
            _ => Self::message(
                "telegram.request_failed",
                "Telegram could not complete this request. Please retry.",
            ),
        }
    }
}

fn log_invocation_error(error: &InvocationError) {
    match error {
        InvocationError::Rpc(rpc) => {
            let name = match rpc.name.as_str() {
                "FLOOD_WAIT"
                | "FLOOD_PREMIUM_WAIT"
                | "SLOWMODE_WAIT"
                | "TAKEOUT_INIT_DELAY"
                | "SESSION_PASSWORD_NEEDED"
                | "SESSION_REVOKED"
                | "SESSION_EXPIRED"
                | "AUTH_KEY_UNREGISTERED"
                | "AUTH_KEY_DUPLICATED"
                | "USER_DEACTIVATED"
                | "USER_DEACTIVATED_BAN"
                | "PASSWORD_HASH_INVALID"
                | "SRP_ID_INVALID"
                | "PHOTO_ID_INVALID" => rpc.name.as_str(),
                _ => "other",
            };
            let method = rpc.caused_by.map(tl::name_for_id).unwrap_or("unknown");
            let retry_after = (rpc.code == 420).then(|| u64::from(rpc.value.unwrap_or(30)).max(1));
            tracing::warn!(rpc_code = rpc.code, rpc_name = name, method, retry_after_seconds = ?retry_after, "Telegram RPC failed");
        }
        InvocationError::Io(error) => {
            tracing::warn!(kind = ?error.kind(), "Telegram connection failed");
        }
        InvocationError::Dropped(_) => tracing::warn!("Telegram connection dropped"),
        _ => tracing::warn!("Telegram request failed"),
    }
}

enum Authentication {
    Disconnected {
        message: Option<String>,
        message_info: Option<MessageInfo>,
    },
    Qr {
        svg: String,
        expires_at: u64,
    },
    Password {
        hint: Option<String>,
    },
    QrExpired,
    Verifying,
    Authorized {
        name: String,
        premium: bool,
        verified_at: Instant,
    },
}

impl Authentication {
    fn view(&self) -> AuthState {
        let mut state = AuthState {
            status: "disconnected".into(),
            qr_svg: None,
            expires_at: None,
            name: None,
            premium: false,
            message: None,
            message_info: None,
        };
        match self {
            Self::Disconnected {
                message,
                message_info,
            } => {
                state.message = message.clone();
                state.message_info = message_info.clone();
            }
            Self::Qr { svg, expires_at } => {
                state.status = "qr".into();
                state.qr_svg = Some(svg.clone());
                state.expires_at = Some(*expires_at);
            }
            Self::Password { hint } => {
                state.status = "password".into();
                state.message = hint.as_ref().map(|hint| format!("Password hint: {hint}"));
                state.message_info = hint
                    .as_ref()
                    .map(|hint| MessageInfo::parameter("auth.password_hint", "hint", hint.clone()));
            }
            Self::QrExpired => state.status = "qr_expired".into(),
            Self::Verifying => {
                state.message = Some("Finishing Telegram sign-in…".into());
                state.message_info = Some(MessageInfo::new("auth.verifying"));
            }
            Self::Authorized { name, premium, .. } => {
                state.status = "authorized".into();
                state.name = Some(name.clone());
                state.premium = *premium;
            }
        }
        state
    }
}

#[derive(Clone)]
enum Thumbnail {
    Cached(Vec<u8>),
    Remote(DownloadFile),
}

#[derive(Clone)]
struct DownloadFile {
    location: tl::enums::InputFileLocation,
    dc_id: i32,
}

impl grammers_client::media::Downloadable for DownloadFile {
    fn to_raw_input_location(&self) -> Option<tl::enums::InputFileLocation> {
        Some(self.location.clone())
    }

    fn dc_id(&self) -> Option<i32> {
        Some(self.dc_id)
    }
}

impl DownloadFile {
    fn document(document: &tl::types::Document, thumb_size: String) -> Self {
        Self {
            location: tl::types::InputDocumentFileLocation {
                id: document.id,
                access_hash: document.access_hash,
                file_reference: document.file_reference.clone(),
                thumb_size,
            }
            .into(),
            dc_id: document.dc_id,
        }
    }

    fn profile_photo(photo: &tl::types::UserProfilePhoto) -> Self {
        Self {
            location: tl::types::InputPeerPhotoFileLocation {
                big: true,
                peer: tl::enums::InputPeer::PeerSelf,
                photo_id: photo.photo_id,
            }
            .into(),
            dc_id: photo.dc_id,
        }
    }
}

pub struct Telegram {
    connection: Connection,
    needs_fresh_session: bool,
    qr_started: Option<Instant>,
    authentication: Authentication,
    flood_until: Option<Instant>,
    sets: HashMap<i64, tl::types::StickerSet>,
    thumbnails: HashMap<i64, Thumbnail>,
    documents: HashMap<i64, tl::types::Document>,
    profile: Option<Profile>,
    profile_photo: Option<DownloadFile>,
    profile_refresh_due: bool,
    history: HashMap<i64, tl::types::Photo>,
}

impl Telegram {
    pub async fn connect(
        data_dir: &Path,
        api_id: i32,
        api_hash: &str,
    ) -> Result<Self, TelegramError> {
        tokio::fs::create_dir_all(data_dir).await.map_err(|_| {
            TelegramError::message(
                "telegram.session_directory_failed",
                "Cannot create Telegram session directory.",
            )
        })?;
        let connection = Connection::open(data_dir, api_id, api_hash).await?;
        let saved_authorization = connection.was_authorized();
        let mut telegram = Self {
            connection,
            needs_fresh_session: false,
            qr_started: None,
            authentication: Authentication::Disconnected {
                message: None,
                message_info: None,
            },
            flood_until: None,
            sets: HashMap::new(),
            thumbnails: HashMap::new(),
            documents: HashMap::new(),
            profile: None,
            profile_photo: None,
            profile_refresh_due: false,
            history: HashMap::new(),
        };
        // A saved transport key is not proof of a still-authorized account.
        // get_me also preserves network failures instead of treating them as logout.
        if saved_authorization && let Err(error) = telegram.verify_identity().await {
            if !error.unauthorized {
                telegram.connection.shutdown().await?;
                return Err(error);
            }
            // A cached self user identifies a previously authorized session,
            // unlike a freshly generated unauthenticated transport key.
            telegram.needs_fresh_session |= saved_authorization;
        }
        Ok(telegram)
    }

    pub async fn logout(&mut self) -> Result<(), TelegramError> {
        self.require_available()?;
        if (self.profile.is_some() || self.connection.was_authorized())
            && let Err(error) = self
                .connection
                .client()
                .invoke(&tl::functions::auth::LogOut {})
                .await
        {
            let error = self.handle_error(error);
            // A revoked session is already logged out remotely.
            if !error.unauthorized {
                return Err(error);
            }
        }
        self.connection.shutdown().await
    }

    /// Poll every one or two seconds during QR login. Existing authorized
    /// sessions are checked at most every 30 seconds, including revocation.
    pub async fn poll_auth(&mut self) -> Result<AuthState, TelegramError> {
        self.require_available()?;
        match &self.authentication {
            Authentication::Qr { .. }
                if self
                    .qr_started
                    .is_some_and(|started| started.elapsed() >= Duration::from_secs(300)) =>
            {
                self.authentication = Authentication::QrExpired;
            }
            Authentication::Qr { expires_at, .. } if unix_now() >= *expires_at => {
                return self.refresh_qr().await;
            }
            Authentication::Qr { .. } => {
                let login = self
                    .connection
                    .poll_qr()
                    .await
                    .map_err(|error| self.handle_login_error(error))?;
                return self.apply_login(login).await;
            }
            Authentication::Verifying => self.verify_identity().await?,
            Authentication::Authorized { verified_at, .. }
                if self.profile_refresh_due || verified_at.elapsed() >= Duration::from_secs(30) =>
            {
                self.verify_identity().await?;
            }
            _ => {}
        }
        Ok(self.authentication.view())
    }

    pub async fn begin_qr(&mut self) -> Result<AuthState, TelegramError> {
        self.qr_started = Some(Instant::now());
        self.refresh_qr().await
    }

    async fn refresh_qr(&mut self) -> Result<AuthState, TelegramError> {
        self.require_available()?;
        if self.needs_fresh_session {
            self.connection.reset().await?;
            self.needs_fresh_session = false;
        }
        if matches!(self.authentication, Authentication::Authorized { .. }) {
            return Ok(self.authentication.view());
        }
        let login = self
            .connection
            .begin_qr()
            .await
            .map_err(|error| self.handle_login_error(error))?;
        self.apply_login(login).await
    }

    pub async fn submit_password(&mut self, password: &str) -> Result<AuthState, TelegramError> {
        self.require_available()?;
        if !matches!(self.authentication, Authentication::Password { .. }) {
            return Err(TelegramError::message(
                "telegram.password_login_not_started",
                "Start Telegram QR login before entering a password.",
            ));
        }
        let login = self
            .connection
            .submit_password(password)
            .await
            .map_err(|error| self.handle_login_error(error))?;
        self.apply_login(login).await
    }

    pub async fn set_photo(&mut self, path: &Path) -> Result<String, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let file = self
            .connection
            .client()
            .upload_file(path)
            .await
            .map_err(|error| {
                match error
                    .into_inner()
                    .and_then(|error| error.downcast::<InvocationError>().ok())
                {
                    Some(error) => self.handle_error(*error),
                    None => TelegramError::message(
                        "telegram.photo_upload_failed",
                        "Cannot upload the profile photo to Telegram.",
                    ),
                }
            })?;
        let result = self
            .connection
            .client()
            .invoke(&tl::functions::photos::UploadProfilePhoto {
                fallback: false,
                bot: None,
                file: Some(file.raw),
                video: None,
                video_start_ts: None,
                video_emoji_markup: None,
            })
            .await
            .map_err(|error| self.handle_error(error))?;
        self.refresh_after_mutation().await;
        let tl::enums::photos::Photo::Photo(result) = result;
        let tl::enums::Photo::Photo(photo) = result.photo else {
            return Err(TelegramError::message(
                "telegram.photo_upload_id_missing",
                "Telegram returned no uploaded photo ID.",
            ));
        };
        let id = photo.id.to_string();
        self.history.insert(photo.id, photo);
        Ok(id)
    }

    pub async fn photo_history(&mut self) -> Result<Vec<HistoryPhoto>, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let mut offset = 0;
        let mut photos = HashMap::new();
        let mut entries = Vec::new();
        loop {
            let result = self
                .connection
                .client()
                .invoke(&tl::functions::photos::GetUserPhotos {
                    user_id: tl::enums::InputUser::UserSelf,
                    offset,
                    max_id: 0,
                    limit: 100,
                })
                .await
                .map_err(|error| self.handle_error(error))?;
            let (page, total) = match result {
                tl::enums::photos::Photos::Photos(result) => (result.photos, None),
                tl::enums::photos::Photos::Slice(result) => (result.photos, Some(result.count)),
            };
            let length = i32::try_from(page.len()).map_err(|_| {
                TelegramError::message(
                    "telegram.photo_history_too_large",
                    "Telegram photo history is too large.",
                )
            })?;
            for photo in page {
                if let tl::enums::Photo::Photo(photo) = photo {
                    if !photos.contains_key(&photo.id) {
                        entries.push(HistoryPhoto {
                            id: photo.id.to_string(),
                        });
                    }
                    photos.insert(photo.id, photo);
                }
            }
            offset += length;
            if length == 0 || total.is_none_or(|total| offset >= total) {
                break;
            }
        }
        // Replace only after all pages succeed: partial history is not absence.
        self.history = photos;
        Ok(entries)
    }

    pub async fn history_photo(&mut self, id: &str) -> Result<Option<Vec<u8>>, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let id = parse_photo_id(id)?;
        if !self.history.contains_key(&id) {
            self.photo_history().await?;
        }
        for attempt in 0..2 {
            let Some(photo) = self.history.get(&id) else {
                return Ok(None);
            };
            let Some(file) = history_download(photo) else {
                return Ok(None);
            };
            match self.download_raw(&file).await {
                Ok(bytes) => return decode_history_photo(&bytes).map(Some),
                Err(error) if attempt == 0 && stale_photo_reference(&error) => {
                    self.photo_history().await?;
                }
                Err(error) => return Err(self.handle_error(error)),
            }
        }
        unreachable!("both download attempts return or refresh")
    }

    pub async fn current_photo(&mut self) -> Result<Option<(String, Vec<u8>)>, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        self.verify_identity().await?;
        let Some(file) = self.profile_photo.clone() else {
            return Ok(None);
        };
        let tl::enums::InputFileLocation::InputPeerPhotoFileLocation(location) = &file.location
        else {
            unreachable!()
        };
        let id = location.photo_id.to_string();
        let bytes = self.download(&file).await?;
        Ok(Some((id, bytes)))
    }

    pub async fn use_history_photo(&mut self, id: &str) -> Result<bool, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let id = parse_photo_id(id)?;
        if !self.history.contains_key(&id) {
            self.photo_history().await?;
        }
        for attempt in 0..2 {
            let Some(photo) = self.history.get(&id) else {
                return Ok(false);
            };
            let result = self
                .connection
                .client()
                .invoke(&tl::functions::photos::UpdateProfilePhoto {
                    fallback: false,
                    bot: None,
                    id: tl::types::InputPhoto {
                        id: photo.id,
                        access_hash: photo.access_hash,
                        file_reference: photo.file_reference.clone(),
                    }
                    .into(),
                })
                .await;
            match result {
                Ok(_) => {
                    self.refresh_after_mutation().await;
                    return Ok(true);
                }
                Err(error) if attempt == 0 && stale_photo_reference(&error) => {
                    self.photo_history().await?;
                }
                Err(InvocationError::Rpc(rpc)) if rpc.name == "PHOTO_ID_INVALID" => {
                    return Ok(false);
                }
                Err(error) => return Err(self.handle_error(error)),
            }
        }
        unreachable!("both update attempts return or refresh")
    }

    /// A snapshot of Telegram's current account, never the local rotation choice.
    /// poll_auth refreshes this alongside identity verification every 30 seconds.
    pub fn profile(&self) -> Option<Profile> {
        let mut profile = self.profile.clone()?;
        if profile
            .emoji
            .as_ref()
            .is_some_and(|emoji| emoji.expires_at.is_some_and(|until| until <= unix_now()))
        {
            profile.emoji = None;
        }
        Some(profile)
    }

    pub async fn profile_photo(&mut self) -> Result<(Vec<u8>, &'static str), TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let photo = self.profile_photo.clone().ok_or_else(|| {
            TelegramError::message(
                "telegram.profile_photo_missing",
                "This Telegram account has no profile photo.",
            )
        })?;
        let bytes = self.download(&photo).await?;
        let content_type = thumbnail_content_type(&bytes).ok_or_else(|| {
            TelegramError::message(
                "telegram.profile_photo_unsupported",
                "Telegram returned an unsupported profile image.",
            )
        })?;
        Ok((bytes, content_type))
    }

    pub async fn set_emoji_status(&mut self, id: i64) -> Result<(), TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        // Check Premium against Telegram now, not a saved local entitlement.
        self.verify_identity().await?;
        self.require_available()?;
        if !self.profile.as_ref().is_some_and(|profile| profile.premium) {
            return Err(TelegramError::message(
                "telegram.premium_required",
                "Telegram Premium is required for emoji statuses.",
            ));
        }
        let updated = self
            .connection
            .client()
            .invoke(&tl::functions::account::UpdateEmojiStatus {
                emoji_status: permanent_emoji_status(id),
            })
            .await
            .map_err(|error| self.handle_error(error))?;
        if !updated {
            return Err(TelegramError::message(
                "telegram.emoji_update_failed",
                "Telegram did not update the emoji status.",
            ));
        }
        self.refresh_after_mutation().await;
        Ok(())
    }

    async fn refresh_after_mutation(&mut self) {
        // The mutation already succeeded. A failed read must not make the
        // scheduler repeat it; leave refresh due so the next poll retries.
        self.profile_refresh_due = true;
        let _ = self.verify_identity().await;
    }

    /// Only Telegram documents already discovered by the picker, saved selection, or current status
    /// are allowed. This endpoint cannot fetch arbitrary document IDs or URLs.
    pub async fn emoji_media(
        &mut self,
        id: i64,
        selected: bool,
    ) -> Result<(Vec<u8>, &'static str), TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        if !selected && !self.documents.contains_key(&id) {
            return Err(TelegramError::message(
                "telegram.emoji_not_discovered",
                "This emoji has not been discovered.",
            ));
        }
        // Refresh file_reference before downloading a document selected long ago.
        let document = self.emoji_document(id).await?;
        let (_, content_type) = emoji_media_type(&document.mime_type).ok_or_else(|| {
            TelegramError::message(
                "telegram.emoji_media_unsupported",
                "This emoji's media format is not supported.",
            )
        })?;
        let bytes = self
            .download(&DownloadFile::document(&document, String::new()))
            .await?;
        Ok((bytes, content_type))
    }

    /// Real recent/default status emoji. Installed packs are loaded separately
    /// to avoid one RPC per installed pack when opening the picker.
    pub async fn emojis(&mut self) -> Result<Vec<EmojiChoice>, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let recent = self
            .connection
            .client()
            .invoke(&tl::functions::account::GetRecentEmojiStatuses { hash: 0 })
            .await
            .map_err(|error| self.handle_error(error))?;
        let defaults = self
            .connection
            .client()
            .invoke(&tl::functions::account::GetDefaultEmojiStatuses { hash: 0 })
            .await
            .map_err(|error| self.handle_error(error))?;
        let mut entries = Vec::new();
        for (statuses, source, source_kind) in [
            (recent, "Recent", EmojiSource::Recent),
            (defaults, "Default", EmojiSource::Default),
        ] {
            for id in status_document_ids(statuses) {
                if !entries.iter().any(|(known, _, _)| *known == id) {
                    entries.push((id, source.to_owned(), source_kind));
                }
            }
        }
        let mut documents = HashMap::new();
        // Telegram accepts at most 100 custom emoji documents per request.
        for chunk in entries.chunks(100) {
            let result = self
                .connection
                .client()
                .invoke(&tl::functions::messages::GetCustomEmojiDocuments {
                    document_id: chunk.iter().map(|(id, _, _)| *id).collect(),
                })
                .await
                .map_err(|error| self.handle_error(error))?;
            for document in result {
                if let tl::enums::Document::Document(document) = document {
                    documents.insert(document.id, document);
                }
            }
        }
        Ok(entries
            .into_iter()
            .filter_map(|(id, source, source_kind)| {
                documents.remove(&id).map(|document| {
                    let mut choice = self.emoji_choice(document, &source);
                    choice.source_kind = Some(source_kind);
                    choice
                })
            })
            .collect())
    }

    pub async fn search_emojis(
        &mut self,
        search: &EmojiSearch,
    ) -> Result<EmojiSearchResults, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let result = self
            .connection
            .client()
            .invoke(&search.request())
            .await
            .map_err(|error| self.handle_error(error))?;
        Ok(self.emoji_search_results(result))
    }

    fn emoji_search_results(
        &mut self,
        result: tl::enums::messages::FoundStickers,
    ) -> EmojiSearchResults {
        let tl::enums::messages::FoundStickers::Stickers(found) = result else {
            return EmojiSearchResults {
                choices: Vec::new(),
                next_offset: None,
            };
        };
        let choices = found
            .stickers
            .into_iter()
            .filter_map(|document| match document {
                tl::enums::Document::Document(document) => {
                    let mut choice = self.emoji_choice(document, "Search");
                    choice.source_kind = Some(EmojiSource::Search);
                    Some(choice)
                }
                tl::enums::Document::Empty(_) => None,
            })
            .collect();
        EmojiSearchResults {
            choices,
            next_offset: found.next_offset,
        }
    }

    pub async fn emoji_sets(&mut self) -> Result<Vec<EmojiSet>, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let result = self
            .connection
            .client()
            .invoke(&tl::functions::messages::GetEmojiStickers { hash: 0 })
            .await
            .map_err(|error| self.handle_error(error))?;
        let mut choices = Vec::new();
        if let tl::enums::messages::AllStickers::Stickers(stickers) = result {
            self.sets.clear();
            for set in stickers.sets {
                let tl::enums::StickerSet::Set(set) = set;
                choices.push(EmojiSet {
                    id: set.id.to_string(),
                    title: set.title.clone(),
                    cover_url: emoji_set_cover_url(&set),
                    count: set.count,
                    text_color: set.text_color,
                });
                self.sets.insert(set.id, set);
            }
        }
        Ok(choices)
    }

    pub async fn emoji_set(&mut self, id: i64) -> Result<Vec<EmojiChoice>, TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        if !self.sets.contains_key(&id) {
            self.emoji_sets().await?;
        }
        let set = self.sets.get(&id).ok_or_else(|| {
            TelegramError::message(
                "telegram.emoji_pack_not_installed",
                "This emoji pack is not installed.",
            )
        })?;
        let title = set.title.clone();
        let documents = self.emoji_set_documents(id).await?;
        Ok(documents
            .into_iter()
            .map(|document| self.emoji_choice(document, &title))
            .collect())
    }

    async fn emoji_set_documents(
        &mut self,
        id: i64,
    ) -> Result<Vec<tl::types::Document>, TelegramError> {
        let set = self.sets.get(&id).ok_or_else(|| {
            TelegramError::message(
                "telegram.emoji_pack_not_installed",
                "This emoji pack is not installed.",
            )
        })?;
        let input = tl::types::InputStickerSetId {
            id,
            access_hash: set.access_hash,
        }
        .into();
        let contents = self
            .connection
            .client()
            .invoke(&tl::functions::messages::GetStickerSet {
                stickerset: input,
                hash: 0,
            })
            .await
            .map_err(|error| self.handle_error(error))?;
        let tl::enums::messages::StickerSet::Set(contents) = contents else {
            return Ok(Vec::new());
        };
        Ok(contents
            .documents
            .into_iter()
            .filter_map(|document| match document {
                tl::enums::Document::Document(document) => Some(document),
                _ => None,
            })
            .collect())
    }

    pub fn emoji_set_cover_url(&self, id: i64) -> Option<String> {
        self.sets.get(&id).map(emoji_set_cover_url)
    }

    pub fn profile_photo_url(&self) -> Option<&str> {
        self.profile.as_ref()?.photo_url.as_deref()
    }

    pub async fn emoji_set_cover(
        &mut self,
        id: i64,
    ) -> Result<(Vec<u8>, &'static str), TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let set = self.sets.get(&id).ok_or_else(|| {
            TelegramError::message(
                "telegram.emoji_pack_not_installed",
                "This emoji pack is not installed.",
            )
        })?;
        if let Some((thumbnail, content_type)) = set_thumbnail(set) {
            let bytes = match thumbnail {
                Thumbnail::Cached(bytes) => bytes,
                Thumbnail::Remote(file) => self.download(&file).await?,
            };
            let content_type = thumbnail_content_type(&bytes).unwrap_or(content_type);
            return Ok((bytes, content_type));
        }
        let document = if let Some(document_id) = set.thumb_document_id {
            self.emoji_document(document_id).await?
        } else {
            self.emoji_set_documents(id)
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    TelegramError::message(
                        "telegram.emoji_cover_missing",
                        "No cover is available for this emoji pack.",
                    )
                })?
        };
        let (_, content_type) = emoji_media_type(&document.mime_type).ok_or_else(|| {
            TelegramError::message(
                "telegram.emoji_cover_unsupported",
                "This emoji pack cover format is not supported.",
            )
        })?;
        let bytes = self
            .download(&DownloadFile::document(&document, String::new()))
            .await?;
        Ok((bytes, content_type))
    }

    /// Not a general-purpose proxy: only thumbnails returned by discovery are
    /// accepted, never external URLs, file paths, or arbitrary document IDs.
    /// These are static previews only; full TGS/WebM artwork uses emoji_media.
    pub async fn emoji_thumbnail(
        &mut self,
        id: i64,
    ) -> Result<(Vec<u8>, &'static str), TelegramError> {
        self.require_available()?;
        self.require_authorized()?;
        let thumbnail = self.thumbnails.get(&id).cloned().ok_or_else(|| {
            TelegramError::message(
                "telegram.emoji_thumbnail_missing",
                "No image thumbnail is available for this emoji.",
            )
        })?;
        let bytes = match thumbnail {
            Thumbnail::Cached(bytes) => bytes,
            Thumbnail::Remote(thumbnail) => self.download(&thumbnail).await?,
        };
        let content_type = thumbnail_content_type(&bytes).ok_or_else(|| {
            TelegramError::message(
                "telegram.emoji_thumbnail_unsupported",
                "This emoji thumbnail is not a supported image.",
            )
        })?;
        self.thumbnails.insert(id, Thumbnail::Cached(bytes.clone()));
        Ok((bytes, content_type))
    }

    async fn apply_login(&mut self, login: Login) -> Result<AuthState, TelegramError> {
        match login {
            Login::Pending => {}
            Login::Qr { token, expires_at } => {
                let url = format!("tg://login?token={}", URL_SAFE_NO_PAD.encode(token));
                let svg = QrCode::new(url.as_bytes())
                    .map_err(|_| {
                        TelegramError::message(
                            "telegram.qr_render_failed",
                            "Cannot render Telegram login QR code.",
                        )
                    })?
                    .render::<svg::Color>()
                    .min_dimensions(256, 256)
                    .build();
                self.authentication = Authentication::Qr { svg, expires_at };
            }
            Login::Password { hint } => self.authentication = Authentication::Password { hint },
            Login::Authorized => {
                self.authentication = Authentication::Verifying;
                self.verify_identity().await?;
            }
        }
        Ok(self.authentication.view())
    }

    async fn verify_identity(&mut self) -> Result<(), TelegramError> {
        let user = self
            .connection
            .client()
            .get_me()
            .await
            .map_err(|error| self.handle_error(error))?;
        let tl::enums::User::User(user) = user.raw else {
            return Err(TelegramError::message(
                "telegram.account_empty",
                "Telegram returned an empty account.",
            ));
        };
        self.connection
            .bind_identity(user.id)
            .map_err(|error| self.handle_login_error(error))?;
        let name = [
            user.first_name.unwrap_or_default(),
            user.last_name.unwrap_or_default(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        // Authorize from get_me even if fetching the emoji's art subsequently
        // fails: a media/network error is not evidence that the user logged out.
        self.authentication = Authentication::Authorized {
            name: name.clone(),
            premium: user.premium,
            verified_at: Instant::now(),
        };
        self.profile_photo = user.photo.as_ref().and_then(|photo| match photo {
            tl::enums::UserProfilePhoto::Photo(photo) => Some(DownloadFile::profile_photo(photo)),
            tl::enums::UserProfilePhoto::Empty => None,
        });
        self.profile = Some(Profile {
            name,
            premium: user.premium,
            photo_url: profile_photo_url(user.photo.as_ref()),
            emoji: None,
            updated_at: unix_now(),
        });
        if let Some((id, expires_at)) = current_status(user.emoji_status.as_ref(), unix_now()) {
            let document = match self.documents.get(&id).cloned() {
                Some(document) => Some(document),
                None => match self.emoji_document(id).await {
                    Ok(document) => Some(document),
                    Err(error) if error.unauthorized => return Err(error),
                    // Artwork retrieval must not turn a successful get_me into
                    // failed authentication. Retry discovery at the next poll.
                    Err(_) => None,
                },
            };
            if let Some(profile) = &mut self.profile {
                profile.emoji = document
                    .as_ref()
                    .and_then(|document| profile_emoji(document, expires_at));
            }
        }
        self.profile_refresh_due = false;
        Ok(())
    }

    async fn emoji_document(&mut self, id: i64) -> Result<tl::types::Document, TelegramError> {
        let documents = self
            .connection
            .client()
            .invoke(&tl::functions::messages::GetCustomEmojiDocuments {
                document_id: vec![id],
            })
            .await
            .map_err(|error| self.handle_error(error))?;
        let document = documents
            .into_iter()
            .find_map(|document| match document {
                tl::enums::Document::Document(document) if document.id == id => Some(document),
                _ => None,
            })
            .ok_or_else(|| {
                TelegramError::message(
                    "telegram.emoji_media_missing",
                    "Telegram could not find this emoji's media.",
                )
            })?;
        self.documents.insert(id, document.clone());
        Ok(document)
    }

    async fn download(&mut self, file: &DownloadFile) -> Result<Vec<u8>, TelegramError> {
        self.download_raw(file)
            .await
            .map_err(|error| self.handle_error(error))
    }

    async fn download_raw(&self, file: &DownloadFile) -> Result<Vec<u8>, InvocationError> {
        let mut download = self.connection.client().iter_download(file);
        let mut bytes = Vec::new();
        while let Some(chunk) = download.next().await? {
            bytes.extend(chunk);
        }
        Ok(bytes)
    }

    fn require_available(&self) -> Result<(), TelegramError> {
        match self
            .flood_until
            .and_then(|until| cooldown_remaining(until, Instant::now()))
        {
            Some(retry_after) => Err(TelegramError {
                info: crate::messages::MessageInfo::new("telegram.rate_limited"),
                message: "Telegram rate limit reached. Wait before retrying.".into(),
                retry_after: Some(retry_after),
                unauthorized: false,
            }),
            None => Ok(()),
        }
    }

    fn require_authorized(&self) -> Result<(), TelegramError> {
        if matches!(self.authentication, Authentication::Authorized { .. }) {
            Ok(())
        } else {
            Err(TelegramError {
                info: crate::messages::MessageInfo::new("telegram.signin_required"),
                message: "Sign in to Telegram first.".into(),
                retry_after: None,
                unauthorized: true,
            })
        }
    }

    fn handle_error(&mut self, error: InvocationError) -> TelegramError {
        self.needs_fresh_session |= invalidated_key(
            &error,
            matches!(self.authentication, Authentication::Authorized { .. }),
        );
        self.record_error(error.into())
    }

    fn handle_login_error(&mut self, error: TelegramError) -> TelegramError {
        // A login request cannot use an unauthorized transport key. Reset it
        // on the next explicit login attempt, not on ordinary network failures.
        self.needs_fresh_session |= error.unauthorized;
        self.record_error(error)
    }

    fn record_error(&mut self, error: TelegramError) -> TelegramError {
        if let Some(wait) = error.retry_after {
            self.flood_until = Some(Instant::now() + Duration::from_secs(wait));
        }
        if error.unauthorized {
            self.authentication = Authentication::Disconnected {
                message: Some(error.message.clone()),
                message_info: Some(error.message_info()),
            };
            self.sets.clear();
            self.thumbnails.clear();
            self.documents.clear();
            self.history.clear();
            self.profile = None;
            self.profile_photo = None;
        }
        error
    }

    fn emoji_choice(&mut self, document: tl::types::Document, source: &str) -> EmojiChoice {
        let label = document
            .attributes
            .iter()
            .find_map(|attribute| match attribute {
                tl::enums::DocumentAttribute::CustomEmoji(emoji) => Some(emoji.alt.clone()),
                _ => None,
            })
            .filter(|alt| !alt.is_empty())
            .unwrap_or_else(|| "Custom emoji".into());
        let id = document.id;
        let thumbnail = document_thumbnail(&document);
        let thumbnail_url = thumbnail.map(|thumbnail| {
            self.thumbnails.insert(id, thumbnail);
            format!("/api/emojis/{id}/thumbnail")
        });
        let text_color = document.attributes.iter().any(|attribute| {
            matches!(attribute, tl::enums::DocumentAttribute::CustomEmoji(emoji) if emoji.text_color)
        });
        self.documents.insert(id, document);
        EmojiChoice {
            id: id.to_string(),
            label,
            source: source.into(),
            source_kind: Some(EmojiSource::Pack),
            thumbnail_url,
            text_color,
        }
    }
}

fn emoji_set_cover_url(set: &tl::types::StickerSet) -> String {
    format!(
        "/api/emojis/sets/{}/cover?v={}-{}-{}",
        set.id,
        set.hash,
        set.thumb_version.unwrap_or_default(),
        set.thumb_document_id.unwrap_or_default()
    )
}

fn parse_photo_id(id: &str) -> Result<i64, TelegramError> {
    id.parse().map_err(|_| {
        TelegramError::message("telegram.photo_id_invalid", "Invalid Telegram photo ID.")
    })
}

fn decode_history_photo(bytes: &[u8]) -> Result<Vec<u8>, TelegramError> {
    let image = image::load_from_memory(bytes).map_err(|_| {
        TelegramError::message(
            "telegram.photo_decode_failed",
            "Cannot decode Telegram's profile photo.",
        )
    })?;
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&image.to_rgb8())
        .map_err(|_| {
            TelegramError::message(
                "telegram.photo_decode_failed",
                "Cannot decode Telegram's profile photo.",
            )
        })?;
    Ok(jpeg)
}

fn stale_photo_reference(error: &InvocationError) -> bool {
    matches!(error, InvocationError::Rpc(rpc) if rpc.name.starts_with("FILE_REFERENCE_") || rpc.name == "FILEREF_UPGRADE_NEEDED")
}

fn history_download(photo: &tl::types::Photo) -> Option<DownloadFile> {
    let kind = photo
        .sizes
        .iter()
        .filter_map(|size| match size {
            tl::enums::PhotoSize::Size(size) if size.w >= 128 && size.h >= 128 => {
                Some((&size.r#type, size.w.min(size.h)))
            }
            tl::enums::PhotoSize::Progressive(size) if size.w >= 128 && size.h >= 128 => {
                Some((&size.r#type, size.w.min(size.h)))
            }
            _ => None,
        })
        // Prefer the smallest size at least as large as Celine's 640px image.
        .min_by_key(|(_, side)| {
            if *side >= 640 {
                (0, *side)
            } else {
                (1, -*side)
            }
        })?
        .0;
    Some(DownloadFile {
        location: tl::types::InputPhotoFileLocation {
            id: photo.id,
            access_hash: photo.access_hash,
            file_reference: photo.file_reference.clone(),
            thumb_size: kind.clone(),
        }
        .into(),
        dc_id: photo.dc_id,
    })
}

fn invalidated_key(error: &InvocationError, was_authorized: bool) -> bool {
    matches!(error, InvocationError::Rpc(rpc) if
        matches!(rpc.name.as_str(), "SESSION_REVOKED" | "SESSION_EXPIRED" | "AUTH_KEY_DUPLICATED")
        || (rpc.name == "AUTH_KEY_UNREGISTERED" && was_authorized))
}

fn cooldown_remaining(until: Instant, now: Instant) -> Option<u64> {
    let remaining = until.checked_duration_since(now)?;
    (!remaining.is_zero()).then(|| remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn permanent_emoji_status(id: i64) -> tl::enums::EmojiStatus {
    tl::enums::EmojiStatus::Status(tl::types::EmojiStatus {
        document_id: id,
        until: None,
    })
}

fn current_status(status: Option<&tl::enums::EmojiStatus>, now: u64) -> Option<(i64, Option<u64>)> {
    let (id, until) = match status? {
        tl::enums::EmojiStatus::Status(status) => (status.document_id, status.until),
        // Render the collectible's actual central artwork only. This does not
        // claim ownership or reproduce Telegram's collectible backdrop/pattern.
        tl::enums::EmojiStatus::Collectible(status) => (status.document_id, status.until),
        _ => return None,
    };
    let expires_at = until.map(|until| u64::try_from(until).unwrap_or(0));
    if expires_at.is_some_and(|until| until <= now) {
        return None;
    }
    Some((id, expires_at))
}

fn profile_photo_url(photo: Option<&tl::enums::UserProfilePhoto>) -> Option<String> {
    match photo? {
        tl::enums::UserProfilePhoto::Photo(photo) => {
            Some(format!("/api/profile/photo?v={}", photo.photo_id))
        }
        _ => None,
    }
}

fn emoji_media_type(mime_type: &str) -> Option<(&'static str, &'static str)> {
    match mime_type {
        // TGS is a gzipped Lottie JSON document, sent as-is. Do not attach
        // Content-Encoding: gzip: the frontend explicitly decompresses TGS.
        "application/x-tgsticker" => Some(("tgs", "application/x-tgsticker")),
        "video/webm" => Some(("webm", "video/webm")),
        "image/webp" => Some(("image", "image/webp")),
        "image/png" => Some(("image", "image/png")),
        "image/jpeg" => Some(("image", "image/jpeg")),
        _ => None,
    }
}

fn profile_emoji(document: &tl::types::Document, expires_at: Option<u64>) -> Option<ProfileEmoji> {
    let (format, _) = emoji_media_type(&document.mime_type)?;
    let attribute = document
        .attributes
        .iter()
        .find_map(|attribute| match attribute {
            tl::enums::DocumentAttribute::CustomEmoji(emoji) => Some(emoji),
            _ => None,
        });
    Some(ProfileEmoji {
        id: document.id.to_string(),
        label: attribute
            .map(|emoji| emoji.alt.clone())
            .filter(|alt| !alt.is_empty())
            .unwrap_or_else(|| "Custom emoji".into()),
        media_url: format!("/api/emojis/{}/media", document.id),
        format: format.into(),
        expires_at,
        text_color: attribute.is_some_and(|emoji| emoji.text_color),
    })
}

fn status_document_ids(statuses: tl::enums::account::EmojiStatuses) -> Vec<i64> {
    match statuses {
        tl::enums::account::EmojiStatuses::Statuses(statuses) => statuses
            .statuses
            .into_iter()
            .filter_map(|status| match status {
                tl::enums::EmojiStatus::Status(status) => Some(status.document_id),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn set_thumbnail(set: &tl::types::StickerSet) -> Option<(Thumbnail, &'static str)> {
    set.thumbs.as_ref()?.iter().find_map(|thumb| {
        let kind = match thumb {
            tl::enums::PhotoSize::PhotoCachedSize(thumb) => {
                return thumbnail_content_type(&thumb.bytes)
                    .map(|mime| (Thumbnail::Cached(thumb.bytes.clone()), mime));
            }
            tl::enums::PhotoSize::Size(thumb) => &thumb.r#type,
            tl::enums::PhotoSize::Progressive(thumb) => &thumb.r#type,
            _ => return None,
        };
        let content_type = match kind.as_str() {
            "a" => "application/x-tgsticker",
            "v" => "video/webm",
            _ => "image/webp",
        };
        Some((
            Thumbnail::Remote(DownloadFile {
                location: tl::types::InputStickerSetThumb {
                    stickerset: tl::types::InputStickerSetId {
                        id: set.id,
                        access_hash: set.access_hash,
                    }
                    .into(),
                    thumb_version: set.thumb_version?,
                }
                .into(),
                dc_id: set.thumb_dc_id?,
            }),
            content_type,
        ))
    })
}

fn document_thumbnail(document: &tl::types::Document) -> Option<Thumbnail> {
    document.thumbs.as_ref()?.iter().find_map(|thumb| {
        let kind = match thumb {
            tl::enums::PhotoSize::PhotoCachedSize(thumb) => {
                return thumbnail_content_type(&thumb.bytes)
                    .map(|_| Thumbnail::Cached(thumb.bytes.clone()));
            }
            tl::enums::PhotoSize::Size(thumb) => &thumb.r#type,
            tl::enums::PhotoSize::Progressive(thumb) => &thumb.r#type,
            // Stripped JPEG and vector-path thumbnails need reconstruction;
            // exposing those byte streams as an image would produce broken UI.
            _ => return None,
        };
        Some(Thumbnail::Remote(DownloadFile::document(
            document,
            kind.clone(),
        )))
    })
}

fn thumbnail_content_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn localized_auth_keeps_password_hint_opaque() {
        let hint = "<b>Recent</b> {seconds} 密碼";
        let state = Authentication::Password {
            hint: Some(hint.into()),
        }
        .view();
        assert_eq!(
            state.message.as_deref(),
            Some(format!("Password hint: {hint}").as_str())
        );
        assert_eq!(
            serde_json::to_value(state.message_info).unwrap(),
            serde_json::json!({"code":"auth.password_hint","params":{"hint":hint}})
        );
        assert!(
            Authentication::Password { hint: None }
                .view()
                .message_info
                .is_none()
        );
        let state = Authentication::Verifying.view();
        assert_eq!(state.message_info.unwrap().code, "auth.verifying");
    }

    #[test]
    fn unreadable_history_photo_is_an_error_not_a_non_match() {
        assert!(decode_history_photo(b"invalid image").is_err());
    }

    #[test]
    fn history_download_uses_suitable_size_and_fresh_reference() {
        let photo = tl::types::Photo {
            has_stickers: false,
            id: i64::MAX,
            access_hash: 77,
            file_reference: vec![1, 2, 3],
            date: 0,
            sizes: vec![
                tl::types::PhotoSize {
                    r#type: "s".into(),
                    w: 100,
                    h: 100,
                    size: 10,
                }
                .into(),
                tl::types::PhotoSize {
                    r#type: "x".into(),
                    w: 800,
                    h: 800,
                    size: 1000,
                }
                .into(),
                tl::types::PhotoSize {
                    r#type: "m".into(),
                    w: 320,
                    h: 320,
                    size: 100,
                }
                .into(),
                tl::types::PhotoSize {
                    r#type: "y".into(),
                    w: 2560,
                    h: 2560,
                    size: 10000,
                }
                .into(),
            ],
            video_sizes: None,
            dc_id: 4,
        };
        let download = history_download(&photo).unwrap();
        assert_eq!(download.dc_id, 4);
        let tl::enums::InputFileLocation::InputPhotoFileLocation(location) = download.location
        else {
            panic!("expected photo location");
        };
        assert_eq!(location.id.to_string(), i64::MAX.to_string());
        assert_eq!(location.access_hash, 77);
        assert_eq!(location.file_reference, [1, 2, 3]);
        assert_eq!(location.thumb_size, "x");
        let mut tiny = photo;
        tiny.sizes.truncate(1);
        assert!(history_download(&tiny).is_none());
    }

    #[tokio::test]
    async fn history_requires_authorization_and_preserves_connection_failures() {
        let (_dir, mut telegram) = offline_telegram().await;
        assert!(telegram.photo_history().await.unwrap_err().unauthorized);
        assert!(telegram.history_photo("42").await.unwrap_err().unauthorized);
        assert!(
            telegram
                .use_history_photo("42")
                .await
                .unwrap_err()
                .unauthorized
        );
        telegram.connection.shutdown().await.unwrap();
        telegram.authentication = Authentication::Authorized {
            name: "Test".into(),
            premium: false,
            verified_at: Instant::now(),
        };
        telegram.history.insert(
            42,
            tl::types::Photo {
                has_stickers: false,
                id: 42,
                access_hash: 0,
                file_reference: vec![],
                date: 0,
                sizes: vec![],
                video_sizes: None,
                dc_id: 1,
            },
        );
        assert!(telegram.photo_history().await.is_err());
        assert!(telegram.history_photo("43").await.is_err());
        assert!(telegram.use_history_photo("42").await.is_err());
        assert!(stale_photo_reference(&rpc_error(
            400,
            "FILE_REFERENCE_EXPIRED"
        )));
        assert!(!stale_photo_reference(&rpc_error(420, "FLOOD_WAIT_42")));
    }

    #[test]
    fn pack_cover_uses_telegram_location_and_format() {
        let mut set = tl::types::StickerSet {
            archived: false,
            official: false,
            masks: false,
            emojis: true,
            text_color: false,
            channel_emoji_status: false,
            creator: false,
            installed_date: None,
            id: 42,
            access_hash: 99,
            title: "Pack".into(),
            short_name: "pack".into(),
            thumbs: None,
            thumb_dc_id: Some(4),
            thumb_version: Some(7),
            thumb_document_id: None,
            count: 12,
            hash: 0,
        };
        assert_eq!(
            emoji_set_cover_url(&set),
            "/api/emojis/sets/42/cover?v=0-7-0"
        );
        let original_url = emoji_set_cover_url(&set);
        set.thumb_version = Some(8);
        assert_ne!(emoji_set_cover_url(&set), original_url);
        set.thumb_version = Some(7);
        set.hash = 1;
        assert_ne!(emoji_set_cover_url(&set), original_url);
        set.hash = 0;
        set.thumb_document_id = Some(10);
        assert_ne!(emoji_set_cover_url(&set), original_url);
        set.thumb_document_id = None;
        for (kind, expected) in [
            ("a", "application/x-tgsticker"),
            ("v", "video/webm"),
            ("m", "image/webp"),
        ] {
            set.thumbs = Some(vec![
                tl::types::PhotoSize {
                    r#type: kind.into(),
                    w: 100,
                    h: 100,
                    size: 123,
                }
                .into(),
            ]);
            let (Thumbnail::Remote(file), mime) = set_thumbnail(&set).unwrap() else {
                panic!("expected remote cover")
            };
            assert_eq!(mime, expected);
            assert_eq!(file.dc_id, 4);
            let tl::enums::InputFileLocation::InputStickerSetThumb(location) = file.location else {
                panic!("expected sticker set location")
            };
            assert_eq!(location.thumb_version, 7);
            let tl::enums::InputStickerSet::Id(input) = location.stickerset else {
                panic!("expected set ID")
            };
            assert_eq!((input.id, input.access_hash), (42, 99));
        }
        set.thumbs = Some(vec![
            tl::types::PhotoCachedSize {
                r#type: "m".into(),
                w: 1,
                h: 1,
                bytes: b"\x89PNG\r\n\x1a\nrest".to_vec(),
            }
            .into(),
        ]);
        assert_eq!(set_thumbnail(&set).unwrap().1, "image/png");
    }

    #[tokio::test]
    async fn media_allows_discovered_and_saved_emoji_but_not_arbitrary_ids() {
        let (_dir, mut telegram) = offline_telegram().await;
        telegram.connection.shutdown().await.unwrap();
        telegram.authentication = Authentication::Authorized {
            name: "Test".into(),
            premium: true,
            verified_at: Instant::now(),
        };
        assert_eq!(
            telegram.emoji_media(42, false).await.unwrap_err().message,
            "This emoji has not been discovered."
        );
        assert_eq!(
            telegram.emoji_media(42, true).await.unwrap_err().message,
            "Telegram connection is unavailable. Please retry."
        );
        telegram
            .documents
            .insert(42, emoji_document(42, "image/webp"));
        assert_eq!(
            telegram.emoji_media(42, false).await.unwrap_err().message,
            "Telegram connection is unavailable. Please retry."
        );
        assert_eq!(
            telegram.emoji_set_cover(42).await.unwrap_err().message,
            "This emoji pack is not installed."
        );
    }

    #[tokio::test]
    async fn emoji_choice_preserves_text_color_and_reads_old_library_entries() {
        let (_dir, mut telegram) = offline_telegram().await;
        let choice = telegram.emoji_choice(emoji_document(42, "image/webp"), "Pack");
        assert!(choice.text_color);
        assert_eq!(serde_json::to_value(choice.source_kind).unwrap(), "pack");
        assert_eq!(choice.source, "Pack");
        let old: EmojiChoice = serde_json::from_value(serde_json::json!({
            "id": "42", "label": "Star", "source": "Pack"
        }))
        .unwrap();
        assert!(!old.text_color);
        assert!(old.source_kind.is_none());
        let legacy: EmojiChoice = serde_json::from_value(serde_json::json!({
            "id":"43", "label":"Star", "source":"Recent"
        }))
        .unwrap();
        assert!(legacy.source_kind.is_none(), "never classify saved text");
        assert!(old.thumbnail_url.is_none());
    }

    fn rpc_error(code: i32, name: &str) -> InvocationError {
        InvocationError::Rpc(
            tl::types::RpcError {
                error_code: code,
                error_message: name.into(),
            }
            .into(),
        )
    }

    async fn offline_telegram() -> (tempfile::TempDir, Telegram) {
        let dir = tempfile::tempdir().unwrap();
        let connection = Connection::open(dir.path(), 1, "unused").await.unwrap();
        let telegram = Telegram {
            connection,
            needs_fresh_session: false,
            qr_started: None,
            authentication: Authentication::Disconnected {
                message: None,
                message_info: None,
            },
            flood_until: None,
            sets: HashMap::new(),
            thumbnails: HashMap::new(),
            documents: HashMap::new(),
            profile: None,
            profile_photo: None,
            profile_refresh_due: false,
            history: HashMap::new(),
        };
        (dir, telegram)
    }

    #[tokio::test]
    async fn blank_session_does_not_verify_an_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut telegram = Telegram::connect(dir.path(), 1, "unused").await.unwrap();
        assert_eq!(telegram.poll_auth().await.unwrap().status, "disconnected");
        telegram.connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn qr_refresh_stops_after_five_minutes() {
        let (_dir, mut telegram) = offline_telegram().await;
        telegram.qr_started = Some(Instant::now() - Duration::from_secs(300));
        telegram.authentication = Authentication::Qr {
            svg: "code".into(),
            expires_at: 0,
        };
        assert_eq!(telegram.poll_auth().await.unwrap().status, "qr_expired");
        assert_eq!(telegram.poll_auth().await.unwrap().status, "qr_expired");
        telegram.connection.shutdown().await.unwrap();
    }

    #[test]
    fn emoji_search_request_uses_text_languages_and_pagination() {
        for (lang, expected) in [
            (Some("en"), vec!["en"]),
            (Some("ru"), vec!["ru"]),
            (Some("uk,en"), vec!["uk", "en"]),
            (
                Some("ja-JP,zh-Hant,en-US,en"),
                vec!["ja-JP", "zh-Hant", "en-US", "en"],
            ),
            (Some(" de-DE, ,fr-CA, en "), vec!["de-DE", "fr-CA", "en"]),
            (Some(""), vec![]),
            (None, vec![]),
        ] {
            let search: EmojiSearch = serde_json::from_value(serde_json::json!({
                "q": "  happy cat  ", "lang": lang, "offset": 100
            }))
            .unwrap();
            let request = search.request();
            assert!(request.emojis);
            assert_eq!(request.q, "happy cat");
            assert!(request.emoticon.is_empty());
            assert_eq!(request.lang_code, expected);
            assert_eq!(request.offset, 100);
            assert_eq!(request.limit, 100);
            assert_eq!(request.hash, 0);
        }
        let search: EmojiSearch = serde_json::from_value(serde_json::json!({"q": "cat"})).unwrap();
        assert_eq!(search.offset, 0);
        assert!(search.request().lang_code.is_empty());
        assert!(search.request().emoticon.is_empty());
        let search: EmojiSearch = serde_json::from_value(serde_json::json!({
            "q": "", "emoticon": "😀 👩‍💻", "lang": "en"
        }))
        .unwrap();
        assert_eq!(search.request().emoticon, "😀 👩‍💻");
        assert!(search.request().q.is_empty());
    }

    #[tokio::test]
    async fn emoji_search_registers_documents_and_preserves_next_offset() {
        let (_dir, mut telegram) = offline_telegram().await;
        let results = telegram.emoji_search_results(
            tl::types::messages::FoundStickers {
                next_offset: Some(100),
                hash: 0,
                stickers: vec![
                    emoji_document(i64::MAX, "application/x-tgsticker").into(),
                    tl::types::DocumentEmpty { id: 1 }.into(),
                ],
            }
            .into(),
        );
        assert_eq!(results.next_offset, Some(100));
        assert_eq!(results.choices.len(), 1);
        let choice = &results.choices[0];
        assert_eq!(choice.id, i64::MAX.to_string());
        assert_eq!(choice.label, "Star");
        assert!(choice.text_color);
        assert!(matches!(choice.source_kind, Some(EmojiSource::Search)));
        assert_eq!(
            serde_json::to_value(choice).unwrap()["source_kind"],
            "search"
        );
        assert!(telegram.documents.contains_key(&i64::MAX));
        let results = telegram.emoji_search_results(
            tl::types::messages::FoundStickers {
                next_offset: None,
                hash: 0,
                stickers: Vec::new(),
            }
            .into(),
        );
        assert!(results.choices.is_empty());
        assert_eq!(results.next_offset, None);
        telegram.connection.shutdown().await.unwrap();
    }

    fn emoji_document(id: i64, mime_type: &str) -> tl::types::Document {
        tl::types::Document {
            id,
            access_hash: 0,
            file_reference: Vec::new(),
            date: 0,
            mime_type: mime_type.into(),
            size: 0,
            thumbs: None,
            video_thumbs: None,
            dc_id: 1,
            attributes: vec![tl::enums::DocumentAttribute::CustomEmoji(
                tl::types::DocumentAttributeCustomEmoji {
                    free: false,
                    text_color: true,
                    alt: "Star".into(),
                    stickerset: tl::enums::InputStickerSet::Empty,
                },
            )],
        }
    }

    #[test]
    fn status_update_protocol_has_no_expiration() {
        let tl::enums::EmojiStatus::Status(status) = permanent_emoji_status(i64::MAX) else {
            panic!("Expected a custom emoji status");
        };
        assert_eq!(status.document_id, i64::MAX);
        assert_eq!(status.until, None);
    }

    #[test]
    fn current_status_handles_removal_and_expiration() {
        assert_eq!(current_status(None, 100), None);
        assert_eq!(
            current_status(Some(&tl::enums::EmojiStatus::Empty), 100),
            None
        );
        let mut status = tl::types::EmojiStatus {
            document_id: 42,
            until: Some(101),
        };
        assert_eq!(
            current_status(Some(&status.clone().into()), 100),
            Some((42, Some(101)))
        );
        status.until = Some(100);
        assert_eq!(current_status(Some(&status.clone().into()), 100), None);
        status.until = Some(-1);
        assert_eq!(current_status(Some(&status.clone().into()), 100), None);
        status.until = None;
        assert_eq!(current_status(Some(&status.into()), 100), Some((42, None)));
    }

    #[test]
    fn collectible_status_uses_central_art_not_collectible_ownership() {
        let status = tl::types::EmojiStatusCollectible {
            collectible_id: 111,
            document_id: 42,
            title: "Gift".into(),
            slug: "gift-1".into(),
            pattern_document_id: 55,
            center_color: 0,
            edge_color: 0,
            pattern_color: 0,
            text_color: 0,
            until: Some(101),
        };
        assert_eq!(
            current_status(Some(&status.into()), 100),
            Some((42, Some(101)))
        );
    }

    #[test]
    fn profile_media_uses_real_art_and_decimal_string_ids() {
        for (mime_type, format) in [
            ("application/x-tgsticker", "tgs"),
            ("video/webm", "webm"),
            ("image/webp", "image"),
            ("image/png", "image"),
            ("image/jpeg", "image"),
        ] {
            let emoji = profile_emoji(&emoji_document(i64::MAX, mime_type), Some(123)).unwrap();
            let json = serde_json::to_value(emoji).unwrap();
            assert_eq!(json["id"], i64::MAX.to_string());
            assert_eq!(json["label"], "Star");
            assert_eq!(json["media_url"], format!("/api/emojis/{}/media", i64::MAX));
            assert_eq!(json["format"], format);
            assert_eq!(json["expires_at"], 123);
            assert_eq!(json["text_color"], true);
            assert_eq!(emoji_media_type(mime_type).unwrap().1, mime_type);
        }
        assert!(profile_emoji(&emoji_document(42, "image/svg+xml"), None).is_none());
        assert!(emoji_media_type("text/html").is_none());
    }

    #[test]
    fn profile_photo_url_tracks_external_change_and_removal() {
        assert_eq!(profile_photo_url(None), None);
        assert_eq!(
            profile_photo_url(Some(&tl::enums::UserProfilePhoto::Empty)),
            None
        );
        let photo = |id| {
            tl::types::UserProfilePhoto {
                has_video: false,
                personal: false,
                photo_id: id,
                stripped_thumb: None,
                dc_id: 1,
            }
            .into()
        };
        assert_eq!(
            profile_photo_url(Some(&photo(42))),
            Some("/api/profile/photo?v=42".into())
        );
        assert_ne!(
            profile_photo_url(Some(&photo(42))),
            profile_photo_url(Some(&photo(43)))
        );
        let profile = Profile {
            name: "Current Telegram name".into(),
            premium: true,
            photo_url: None,
            emoji: None,
            updated_at: 123,
        };
        let json = serde_json::to_value(profile).unwrap();
        assert_eq!(json["name"], "Current Telegram name");
        assert_eq!(json["premium"], true);
        assert!(json["photo_url"].is_null());
        assert!(json["emoji"].is_null());
        assert_eq!(json["updated_at"], 123);
    }

    #[test]
    fn only_previously_authorized_unregistered_keys_require_reset() {
        let unregistered = rpc_error(401, "AUTH_KEY_UNREGISTERED");
        assert!(!invalidated_key(&unregistered, false));
        assert!(invalidated_key(&unregistered, true));
        assert!(!invalidated_key(
            &InvocationError::Io(io::Error::other("offline")),
            true
        ));
        for name in ["SESSION_REVOKED", "SESSION_EXPIRED", "AUTH_KEY_DUPLICATED"] {
            assert!(invalidated_key(&rpc_error(401, name), false));
        }
        assert!(!invalidated_key(
            &rpc_error(401, "SESSION_PASSWORD_NEEDED"),
            true
        ));
    }

    #[tokio::test]
    async fn login_authorization_errors_require_a_fresh_session() {
        let (_dir, mut telegram) = offline_telegram().await;
        telegram.authentication = Authentication::Password { hint: None };
        telegram.handle_login_error(rpc_error(401, "SESSION_REVOKED").into());
        assert!(telegram.needs_fresh_session);
        assert!(matches!(
            telegram.authentication,
            Authentication::Disconnected { .. }
        ));

        telegram.needs_fresh_session = false;
        telegram.handle_login_error(InvocationError::Io(io::Error::other("offline")).into());
        assert!(!telegram.needs_fresh_session);
        telegram.connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn accepted_login_retries_identity_after_network_failure() {
        let (_dir, mut telegram) = offline_telegram().await;
        telegram.connection.shutdown().await.unwrap();
        assert!(telegram.apply_login(Login::Authorized).await.is_err());
        assert!(matches!(telegram.authentication, Authentication::Verifying));
        assert!(telegram.poll_auth().await.is_err());
        assert!(matches!(telegram.authentication, Authentication::Verifying));
    }

    #[test]
    fn flood_wait_is_machine_readable() {
        let error = TelegramError::from(rpc_error(420, "FLOOD_WAIT_42"));
        assert_eq!(error.retry_after, Some(42));
        assert!(!error.unauthorized);
    }

    #[test]
    fn flood_cooldown_counts_down_without_resetting() {
        let now = Instant::now();
        let until = now + Duration::from_millis(1500);
        assert_eq!(cooldown_remaining(until, now), Some(2));
        assert_eq!(
            cooldown_remaining(until, now + Duration::from_secs(1)),
            Some(1)
        );
        assert_eq!(cooldown_remaining(until, until), None);
        assert_eq!(
            cooldown_remaining(until, until + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn revoked_session_is_not_a_password_challenge() {
        for name in [
            "SESSION_REVOKED",
            "SESSION_EXPIRED",
            "AUTH_KEY_UNREGISTERED",
        ] {
            assert!(TelegramError::from(rpc_error(401, name)).unauthorized);
        }
        assert!(!TelegramError::from(rpc_error(401, "SESSION_PASSWORD_NEEDED")).unauthorized);
    }

    #[test]
    fn upstream_error_details_are_never_exposed() {
        let secret = "private/token/or/password";
        let error = TelegramError::from(InvocationError::Io(io::Error::other(secret)));
        assert!(!format!("{error:?} {error}").contains(secret));
        assert_eq!(error.message_info().code, "telegram.connection_unavailable");
        let error = TelegramError::from(rpc_error(500, secret));
        assert_eq!(error.message_info().code, "telegram.request_failed");
        assert!(!serde_json::to_string(&error).unwrap().contains(secret));
    }

    #[test]
    fn document_download_locations_preserve_dc_and_file_reference() {
        let mut document = emoji_document(42, "image/webp");
        document.access_hash = 17;
        document.file_reference = vec![1, 2, 3];
        document.dc_id = 5;
        let file = DownloadFile::document(&document, "m".into());
        assert_eq!(file.dc_id, 5);
        let tl::enums::InputFileLocation::InputDocumentFileLocation(location) = file.location
        else {
            panic!("Expected a document location");
        };
        assert_eq!(location.id, 42);
        assert_eq!(location.access_hash, 17);
        assert_eq!(location.file_reference, [1, 2, 3]);
        assert_eq!(location.thumb_size, "m");
    }

    #[test]
    fn profile_photo_download_uses_self_and_telegram_photo_dc() {
        let file = DownloadFile::profile_photo(&tl::types::UserProfilePhoto {
            has_video: false,
            personal: false,
            photo_id: 42,
            stripped_thumb: None,
            dc_id: 4,
        });
        assert_eq!(file.dc_id, 4);
        let tl::enums::InputFileLocation::InputPeerPhotoFileLocation(location) = file.location
        else {
            panic!("Expected a profile photo location");
        };
        assert!(location.big);
        assert!(matches!(location.peer, tl::enums::InputPeer::PeerSelf));
        assert_eq!(location.photo_id, 42);
    }

    #[test]
    fn thumbnail_proxy_rejects_active_content() {
        assert_eq!(thumbnail_content_type(b"<svg onload='alert(1)'>"), None);
        assert_eq!(
            thumbnail_content_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(thumbnail_content_type(b"RIFFxxxxWEBP"), Some("image/webp"));
    }

    #[test]
    fn qr_view_exposes_svg_and_expiry_but_no_raw_token_field() {
        let state = Authentication::Qr {
            svg: "<svg/>".into(),
            expires_at: 123,
        }
        .view();
        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["status"], "qr");
        assert_eq!(json["expires_at"], 123);
        assert!(json.get("token").is_none());
    }
}
