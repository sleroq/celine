use crate::messages::Message;
use std::{fs, path::PathBuf};

use crate::telegram::EmojiChoice;
use anyhow::{Context, Result, bail};
use rand::Rng;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Ordered,
    Random,
}
impl Mode {
    fn next_index(&self, len: usize, last: Option<usize>) -> Option<usize> {
        if len == 0 {
            return None;
        }
        match self {
            Self::Ordered => Some(last.map_or(0, |index| (index + 1) % len)),
            Self::Random => {
                let candidates: Vec<_> = (0..len)
                    .filter(|index| len == 1 || Some(*index) != last)
                    .collect();
                Some(candidates[rand::rng().random_range(0..candidates.len())])
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub mode: Mode,
    pub interval_secs: u64,
    pub jitter_secs: Option<u64>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: Mode::Ordered,
            interval_secs: 3600,
            jitter_secs: None,
        }
    }
}
impl Settings {
    fn jitter(&self) -> u64 {
        self.jitter_secs.unwrap_or_else(|| {
            (self.interval_secs / 10 + u64::from(self.interval_secs % 10 >= 5)).min(300)
        })
    }
    pub fn validate(&self) -> Result<()> {
        if self.interval_secs == 0 {
            bail!(Message::new(
                "validation.interval_positive",
                "Choose a positive interval in seconds."
            ));
        }
        if self
            .jitter_secs
            .is_some_and(|jitter| jitter >= self.interval_secs)
        {
            bail!(Message::new(
                "validation.jitter_smaller",
                "Jitter must be smaller than the interval so every delay remains positive."
            ));
        }
        Ok(())
    }
    pub fn next_at(&self, now: u64) -> u64 {
        let interval = u128::from(self.interval_secs);
        let jitter = u128::from(self.jitter());
        let delay = rand::rng().random_range(interval - jitter..=interval + jitter);
        now.saturating_add(u64::try_from(delay).unwrap_or(u64::MAX))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Photo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub generated_name: Option<bool>,
    #[serde(default)]
    pub telegram_id: Option<String>,
    // Older libraries need to be matched against Telegram before their first upload.
    #[serde(default)]
    pub history_checked: bool,
    #[serde(default)]
    pub crop: Option<Crop>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub size: f64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Library {
    pub photos: Vec<Photo>,
    pub settings: Settings,
    pub selected_emojis: Vec<EmojiChoice>,
    pub emoji_settings: Settings,
    pub applied_settings: Option<Settings>,
    pub applied_emoji_settings: Option<Settings>,
    pub next_emoji_rotation_at: Option<u64>,
    pub last_emoji_id: Option<String>,
    pub next_rotation_at: Option<u64>,
    pub telegram_not_before: Option<u64>,
    pub last_photo_id: Option<String>,
    pub pending_photo_id: Option<String>,
    pub photo_start_pending: bool,
}
impl Library {
    pub fn photo_rotation_due(&self, now: u64) -> bool {
        self.applied_settings.is_some() && self.next_rotation_at.is_none_or(|due| due <= now)
    }

    pub fn next_photo(&self, after: Option<&str>, skipped: &[String]) -> Option<&Photo> {
        let last = after.or(self.last_photo_id.as_deref());
        match self
            .applied_settings
            .as_ref()
            .unwrap_or(&self.settings)
            .mode
        {
            Mode::Ordered => {
                let start = last
                    .and_then(|id| self.photos.iter().position(|photo| photo.id == id))
                    .map_or(0, |index| index + 1);
                (start..start + self.photos.len())
                    .map(|index| &self.photos[index % self.photos.len()])
                    .find(|photo| !skipped.contains(&photo.id))
            }
            Mode::Random => {
                let mut candidates: Vec<_> = self
                    .photos
                    .iter()
                    .filter(|photo| !skipped.contains(&photo.id))
                    .collect();
                if candidates.len() > 1 {
                    candidates
                        .retain(|photo| Some(photo.id.as_str()) != self.last_photo_id.as_deref());
                }
                (!candidates.is_empty())
                    .then(|| candidates[rand::rng().random_range(0..candidates.len())])
            }
        }
    }
    pub fn next_emoji(&self) -> Option<&EmojiChoice> {
        let last = self.last_emoji_id.as_ref().and_then(|id| {
            self.selected_emojis
                .iter()
                .position(|emoji| &emoji.id == id)
        });
        self.applied_emoji_settings
            .as_ref()
            .unwrap_or(&self.emoji_settings)
            .mode
            .next_index(self.selected_emojis.len(), last)
            .map(|index| &self.selected_emojis[index])
    }
    pub fn select_emojis(&mut self, selected: Vec<EmojiChoice>) {
        self.selected_emojis = selected;
        if self.selected_emojis.is_empty() {
            self.emoji_settings.enabled = false;
            self.applied_emoji_settings = None;
            self.next_emoji_rotation_at = None;
        }
    }
    pub fn update_emoji_settings(&mut self, settings: Settings, now: u64) -> Result<()> {
        settings.validate()?;
        if settings.enabled && self.selected_emojis.is_empty() {
            bail!(Message::new(
                "validation.emoji_selection_required",
                "Select at least one emoji before starting rotation."
            ));
        }
        self.next_emoji_rotation_at = settings.enabled.then(|| {
            settings
                .next_at(now)
                .max(self.telegram_not_before.unwrap_or(0))
        });
        self.applied_emoji_settings = settings.enabled.then(|| settings.clone());
        self.emoji_settings = settings;
        Ok(())
    }
    pub fn defer_telegram(&mut self, until: u64) {
        self.telegram_not_before = Some(until);
        for due in [&mut self.next_rotation_at, &mut self.next_emoji_rotation_at]
            .into_iter()
            .flatten()
        {
            *due = (*due).max(until);
        }
    }
    pub fn reorder(&mut self, ids: &[String]) -> Result<()> {
        if ids.len() != self.photos.len()
            || ids
                .iter()
                .enumerate()
                .any(|(i, id)| ids[..i].contains(id) || !self.photos.iter().any(|p| &p.id == id))
        {
            bail!(Message::new(
                "validation.photo_order",
                "The order must contain every selected photo exactly once."
            ));
        }
        self.photos
            .sort_by_key(|photo| ids.iter().position(|id| id == &photo.id));
        Ok(())
    }
    pub fn update_settings(&mut self, settings: Settings, now: u64) -> Result<()> {
        settings.validate()?;
        if settings.enabled && self.photos.is_empty() {
            bail!(Message::new(
                "validation.photo_selection_required",
                "Select at least one photo before starting rotation."
            ));
        }
        // Applying settings resets the deadline; photo starts reconcile with Telegram separately.
        self.next_rotation_at = settings.enabled.then(|| {
            settings
                .next_at(now)
                .max(self.telegram_not_before.unwrap_or(0))
        });
        self.applied_settings = settings.enabled.then(|| settings.clone());
        self.settings = settings;
        Ok(())
    }
}

pub struct Repository {
    pub data: Library,
    dir: PathBuf,
    _lock: fs::File,
    photo_schedule_revision: u64,
}
impl Repository {
    pub fn open(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir).context("Cannot create the Celine data directory")?;
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
        fs::create_dir_all(dir.join("photos"))?;
        let mut data = match fs::read(dir.join("library.json")) {
            Ok(bytes) => {
                let value: serde_json::Value = serde_json::from_slice(&bytes).context(
                    "Cannot read library.json; restore a backup instead of overwriting it",
                )?;
                let mut library: Library = serde_json::from_value(value.clone()).context(
                    "Cannot read library.json; restore a backup instead of overwriting it",
                )?;
                if value.get("applied_settings").is_none() && library.settings.enabled {
                    library.applied_settings = Some(library.settings.clone());
                }
                if value.get("applied_emoji_settings").is_none() && library.emoji_settings.enabled {
                    library.applied_emoji_settings = Some(library.emoji_settings.clone());
                }
                library
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Library::default(),
            Err(error) => return Err(error.into()),
        };
        // Older history selections stored the English fallback as their name and had no local file.
        for photo in &mut data.photos {
            if photo.generated_name.is_none() {
                photo.generated_name = Some(
                    photo.name == "Telegram photo"
                        && photo.telegram_id.is_some()
                        && !dir
                            .join("photos")
                            .join(format!("{}.jpg", photo.id))
                            .exists(),
                );
            }
        }
        data.settings.validate()?;
        data.emoji_settings.validate()?;
        if let Some(settings) = &data.applied_settings {
            settings.validate()?;
        }
        if let Some(settings) = &data.applied_emoji_settings {
            settings.validate()?;
        }
        Ok(Self {
            data,
            dir,
            _lock: lock,
            photo_schedule_revision: 0,
        })
    }
    pub fn photo_path(&self, id: &str) -> Result<PathBuf> {
        if !self.data.photos.iter().any(|p| p.id == id) {
            bail!(Message::new("photo.not_found", "Photo not found."));
        }
        Ok(self.dir.join("photos").join(format!("{id}.jpg")))
    }
    pub fn original_path(&self, id: &str) -> Result<PathBuf> {
        self.photo_path(id)?;
        Ok(self.dir.join("photos").join(format!("{id}.original")))
    }

    pub fn original(&self, id: &str) -> Result<Vec<u8>> {
        let original = self.original_path(id)?;
        match fs::read(original) {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(fs::read(self.photo_path(id)?)?)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_crop(&mut self, id: &str, crop: Option<Crop>, original: &[u8]) -> Result<()> {
        let old = self
            .data
            .photos
            .iter()
            .find(|photo| photo.id == id)
            .context("Photo not found")?;
        if old.crop == crop {
            return Ok(());
        }
        let jpeg = render_photo(original, crop.as_ref())?;
        let original_path = self.original_path(id)?;
        let path = self.photo_path(id)?;
        let photos = path.parent().unwrap();
        let mut preview = tempfile::NamedTempFile::new_in(photos)?;
        std::io::Write::write_all(&mut preview, &jpeg)?;
        let previous = match fs::read(&path) {
            Ok(bytes) => {
                let mut backup = tempfile::NamedTempFile::new_in(photos)?;
                std::io::Write::write_all(&mut backup, &bytes)?;
                Some(backup)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let stored_original = if original_path.exists() {
            false
        } else {
            let mut file = tempfile::NamedTempFile::new_in(photos)?;
            std::io::Write::write_all(&mut file, original)?;
            file.persist(&original_path)?;
            true
        };
        if let Err(error) = preview.persist(&path) {
            if stored_original {
                fs::remove_file(&original_path)?;
            }
            return Err(error.into());
        }
        if let Err(error) = self.update(|library| {
            let photo = library
                .photos
                .iter_mut()
                .find(|photo| photo.id == id)
                .unwrap();
            photo.crop = crop;
            photo.telegram_id = None;
            photo.history_checked = false;
            Ok(())
        }) {
            match previous {
                Some(backup) => {
                    backup
                        .persist(&path)
                        .context("Cannot restore the previous photo preview")?;
                }
                None => fs::remove_file(&path).context("Cannot remove the failed photo preview")?,
            }
            if stored_original {
                fs::remove_file(original_path)?;
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn add_upload(
        &mut self,
        name: &str,
        original: &[u8],
        jpeg: &[u8],
        telegram_id: Option<String>,
    ) -> Result<()> {
        let telegram_available = telegram_id.as_ref().is_some_and(|id| {
            !self
                .data
                .photos
                .iter()
                .any(|photo| photo.telegram_id.as_ref() == Some(id))
        });
        for photo in &self.data.photos {
            match self.original(&photo.id) {
                Ok(existing) if existing == original => {
                    if photo.telegram_id.is_none() && photo.crop.is_none() && telegram_available {
                        let id = photo.id.clone();
                        return self.link_telegram_photo(&id, telegram_id.unwrap());
                    }
                    return Ok(());
                }
                Ok(_) => {}
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        let photo = Photo {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.chars().filter(|c| !c.is_control()).take(120).collect(),
            generated_name: Some(false),
            telegram_id: if telegram_available {
                telegram_id
            } else {
                None
            },
            history_checked: true,
            crop: None,
        };
        let photos = self.dir.join("photos");
        let original_path = photos.join(format!("{}.original", photo.id));
        let preview_path = photos.join(format!("{}.jpg", photo.id));
        let mut original_file = tempfile::NamedTempFile::new_in(&photos)?;
        std::io::Write::write_all(&mut original_file, original)?;
        let mut preview_file = tempfile::NamedTempFile::new_in(&photos)?;
        std::io::Write::write_all(&mut preview_file, jpeg)?;
        original_file.persist(&original_path)?;
        if let Err(error) = preview_file.persist(&preview_path) {
            fs::remove_file(&original_path)?;
            return Err(error.into());
        }
        if let Err(error) = self.update(|library| {
            library.photos.push(photo);
            Ok(())
        }) {
            fs::remove_file(&preview_path)?;
            fs::remove_file(&original_path)?;
            return Err(error);
        }
        Ok(())
    }
    pub fn update(&mut self, change: impl FnOnce(&mut Library) -> Result<()>) -> Result<()> {
        let mut next = self.data.clone();
        change(&mut next)?;
        self.save(&next).context(Message::new(
            "storage.state_save_failed",
            "Cannot save Celine state. Check available disk space and data-directory permissions.",
        ))?;
        self.data = next;
        Ok(())
    }
    fn save(&self, data: &Library) -> Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(&self.dir)?;
        serde_json::to_writer_pretty(&mut file, data)?;
        file.as_file().sync_all()?;
        file.persist(self.dir.join("library.json"))?;
        Ok(())
    }
    pub fn schedule_photos(&mut self, settings: Settings, now: u64) -> Result<()> {
        self.update(|library| {
            if !settings.enabled {
                library.pending_photo_id = None;
            }
            library.update_settings(settings, now)
        })?;
        self.photo_schedule_revision += 1;
        Ok(())
    }

    pub fn photo_schedule_revision(&self) -> u64 {
        self.photo_schedule_revision
    }

    pub fn photo_schedule_is_current(&self, revision: u64) -> bool {
        self.photo_schedule_revision == revision && self.data.applied_settings.is_some()
    }

    pub fn prepare_photo_rotation(
        &mut self,
        now: u64,
        after: Option<&str>,
        skipped: &[String],
    ) -> Result<Option<Photo>> {
        if self.data.applied_settings.is_none()
            || (skipped.is_empty() && !self.data.photo_rotation_due(now))
        {
            return Ok(None);
        }
        let photo = self
            .data
            .pending_photo_id
            .as_ref()
            .and_then(|id| {
                self.data
                    .photos
                    .iter()
                    .find(|photo| &photo.id == id && !skipped.contains(id))
            })
            .or_else(|| self.data.next_photo(after, skipped))
            .cloned();
        self.update(|library| {
            if let Some(photo) = &photo {
                if skipped.is_empty() {
                    // A restart resumes this attempt without replaying missed intervals.
                    library.next_rotation_at =
                        Some(library.applied_settings.as_ref().unwrap().next_at(now));
                }
                library.pending_photo_id = Some(photo.id.clone());
            } else {
                library.settings.enabled = false;
                library.applied_settings = None;
                library.next_rotation_at = None;
                library.pending_photo_id = None;
            }
            Ok(())
        })?;
        Ok(photo)
    }

    pub fn retry_photo_rotation(&mut self, revision: u64, now: u64, delay: u64) -> Result<()> {
        if !self.photo_schedule_is_current(revision) {
            return Ok(());
        }
        self.update(|library| {
            library.next_rotation_at = Some(
                now.saturating_add(delay)
                    .max(library.telegram_not_before.unwrap_or(0)),
            );
            Ok(())
        })
    }

    pub fn complete_photo_rotation(&mut self, id: &str) -> Result<()> {
        self.update(|library| {
            library.last_photo_id = Some(id.into());
            library.pending_photo_id = None;
            Ok(())
        })
    }

    pub fn mark_photo_uploading(&mut self, id: &str) -> Result<()> {
        self.update(|library| {
            if let Some(photo) = library.photos.iter_mut().find(|photo| photo.id == id) {
                // An interrupted upload must be matched again before another upload.
                photo.history_checked = false;
            }
            Ok(())
        })
    }

    pub fn link_telegram_photo(&mut self, id: &str, telegram_id: String) -> Result<()> {
        self.update(|library| {
            if let Some(photo) = library.photos.iter_mut().find(|photo| photo.id == id) {
                photo.telegram_id = Some(telegram_id);
                photo.history_checked = true;
            }
            Ok(())
        })
    }

    pub fn add_history_photo(&mut self, telegram_id: String) -> Result<()> {
        if self
            .data
            .photos
            .iter()
            .any(|photo| photo.telegram_id.as_ref() == Some(&telegram_id))
        {
            return Ok(());
        }
        self.update(|library| {
            library.photos.push(Photo {
                id: uuid::Uuid::new_v4().to_string(),
                name: "Telegram photo".into(),
                generated_name: Some(true),
                telegram_id: Some(telegram_id),
                history_checked: true,
                crop: None,
            });
            Ok(())
        })
    }
    pub fn remove_photo(&mut self, id: &str) -> Result<()> {
        let path = self.photo_path(id)?;
        self.update(|library| {
            library.photos.retain(|p| p.id != id);
            if library.photos.is_empty() {
                library.settings.enabled = false;
                library.applied_settings = None;
                library.next_rotation_at = None;
            }
            Ok(())
        })?;
        let original = self.dir.join("photos").join(format!("{id}.original"));
        let _ = fs::remove_file(original);
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context(Message::new(
                "storage.photo_remove_failed",
                "Removed from selection, but could not remove the local image file",
            )),
        }
    }
}

pub fn normalize_photo(bytes: &[u8]) -> Result<Vec<u8>> {
    render_photo(bytes, None)
}

pub fn render_photo(bytes: &[u8], crop: Option<&Crop>) -> Result<Vec<u8>> {
    use image::ImageDecoder;
    if bytes.len() > 10 * 1024 * 1024 {
        bail!(Message::new(
            "upload.too_large",
            "Photos must be at most 10 MiB."
        ));
    }
    let format = image::guess_format(bytes).context(Message::new(
        "upload.image_format",
        "Choose a JPEG or PNG image.",
    ))?;
    if !matches!(format, image::ImageFormat::Jpeg | image::ImageFormat::Png) {
        bail!(Message::new(
            "upload.image_format",
            "Choose a JPEG or PNG image."
        ));
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().context(Message::new(
        "upload.decode_failed",
        "Cannot decode the image. Maximum dimensions are 4096 × 4096 pixels.",
    ))?;
    let orientation = decoder.orientation()?;
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    if image.width() < 160 || image.height() < 160 {
        bail!(Message::new(
            "upload.too_small",
            "Photos must be at least 160 × 160 pixels."
        ));
    }
    let (width, height) = (image.width(), image.height());
    let min = width.min(height) as f64;
    let (x, y, size) = if let Some(crop) = crop {
        let side = crop.size * min;
        let x = crop.x * f64::from(width);
        let y = crop.y * f64::from(height);
        if !x.is_finite()
            || !y.is_finite()
            || !side.is_finite()
            || x < 0.0
            || y < 0.0
            || side < 1.0
            || x + side > f64::from(width) + 0.00001
            || y + side > f64::from(height) + 0.00001
        {
            bail!(Message::new(
                "validation.crop",
                "Choose a square crop within the image."
            ));
        }
        (x.round() as u32, y.round() as u32, side.round() as u32)
    } else {
        (
            (width - width.min(height)) / 2,
            (height - width.min(height)) / 2,
            width.min(height),
        )
    };
    let size = size.min(width - x).min(height - y);
    let image = image
        .crop_imm(x, y, size, size)
        .resize_exact(640, 640, image::imageops::FilterType::Lanczos3)
        .to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&image)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn photo(id: &str) -> Photo {
        Photo {
            id: id.into(),
            name: id.into(),
            generated_name: Some(false),
            telegram_id: None,
            history_checked: true,
            crop: None,
        }
    }
    #[test]
    fn state_save_errors_identify_storage_problems() {
        let dir = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(dir.path().into()).unwrap();
        repository.dir = dir.path().join("missing");
        let error = repository.update(|_| Ok(())).unwrap_err();
        assert_eq!(
            crate::messages::MessageInfo::from_error(&error).code,
            "storage.state_save_failed"
        );
        assert!(error.to_string().contains("disk space"));
    }

    #[test]
    fn legacy_photo_names_keep_uploaded_filenames_and_identify_history_selections() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("photos")).unwrap();
        fs::write(dir.path().join("photos/upload.jpg"), b"local image").unwrap();
        fs::write(
            dir.path().join("library.json"),
            r#"{"photos":[
            {"id":"history","name":"Telegram photo","telegram_id":"1"},
            {"id":"upload","name":"Telegram photo","telegram_id":"2"}
        ]}"#,
        )
        .unwrap();
        let mut repository = Repository::open(dir.path().into()).unwrap();
        assert_eq!(repository.data.photos[0].generated_name, Some(true));
        assert_eq!(repository.data.photos[1].generated_name, Some(false));
        repository.update(|_| Ok(())).unwrap();
        drop(repository);
        fs::remove_file(dir.path().join("photos/upload.jpg")).unwrap();
        let mut repository = Repository::open(dir.path().into()).unwrap();
        assert_eq!(repository.data.photos[1].generated_name, Some(false));
        assert_eq!(repository.data.photos[1].name, "Telegram photo");
        repository.add_history_photo("3".into()).unwrap();
        assert_eq!(repository.data.photos[2].generated_name, Some(true));
    }

    #[test]
    fn upload_validation_has_explicit_codes() {
        let error = normalize_photo(b"not an image").unwrap_err();
        assert_eq!(
            crate::messages::MessageInfo::from_error(&error).code,
            "upload.image_format"
        );
        assert_eq!(error.to_string(), "Choose a JPEG or PNG image.");
    }

    #[test]
    fn automatic_jitter_tracks_delay_and_is_capped() {
        let mut settings = Settings::default();
        assert_eq!(settings.jitter_secs, None);
        for (interval_secs, jitter) in [
            (1, 0),
            (4, 0),
            (5, 1),
            (10, 1),
            (15, 2),
            (600, 60),
            (2994, 299),
            (2995, 300),
            (3600, 300),
            (u64::MAX, 300),
        ] {
            settings.interval_secs = interval_secs;
            assert!(settings.validate().is_ok());
            assert_eq!(settings.jitter(), jitter);
            for _ in 0..100 {
                let next = settings.next_at(0);
                assert!(
                    (interval_secs - jitter..=interval_secs.saturating_add(jitter)).contains(&next)
                );
            }
        }
        settings.interval_secs = 600;
        settings.jitter_secs = Some(0);
        assert_eq!(settings.next_at(1000), 1600);
        settings.jitter_secs = Some(120);
        assert_eq!(settings.jitter(), 120);
        settings.interval_secs = 900;
        assert_eq!(settings.jitter(), 120);
        settings.jitter_secs = None;
        assert_eq!(settings.jitter(), 90);
    }
    #[test]
    fn scheduling_bounds_and_validation() {
        let settings = Settings {
            enabled: true,
            mode: Mode::Ordered,
            interval_secs: 600,
            jitter_secs: Some(599),
        };
        assert!(settings.validate().is_ok());
        for _ in 0..1000 {
            assert!((1001..=2199).contains(&settings.next_at(1000)));
        }
        for interval_secs in [1, 31_536_001, u64::MAX] {
            let settings = Settings {
                interval_secs,
                jitter_secs: Some(0),
                ..settings.clone()
            };
            assert!(settings.validate().is_ok());
            assert_eq!(
                settings.next_at(1000),
                1000_u64.saturating_add(interval_secs)
            );
        }
        for (interval_secs, jitter_secs) in [(0, 0), (1, 1), (600, 600), (600, 601)] {
            assert!(
                Settings {
                    interval_secs,
                    jitter_secs: Some(jitter_secs),
                    ..settings.clone()
                }
                .validate()
                .is_err()
            );
        }
        let settings = Settings {
            interval_secs: u64::MAX,
            jitter_secs: Some(u64::MAX - 1),
            ..settings
        };
        assert!(settings.validate().is_ok());
        for _ in 0..1000 {
            assert!(settings.next_at(0) > 0);
            assert!(settings.next_at(1000) > 1000);
        }
    }
    #[test]
    fn ordering_and_random_avoid_repeats() {
        let mut library = Library::default();
        assert!(library.next_photo(None, &[]).is_none());
        library.photos = vec![photo("a"), photo("b"), photo("c")];
        assert_eq!(library.next_photo(None, &[]).unwrap().id, "a");
        library.last_photo_id = Some("a".into());
        assert_eq!(library.next_photo(None, &[]).unwrap().id, "b");
        library
            .reorder(&["c".into(), "b".into(), "a".into()])
            .unwrap();
        assert_eq!(library.next_photo(None, &[]).unwrap().id, "c");
        assert!(
            library
                .reorder(&["a".into(), "a".into(), "c".into()])
                .is_err()
        );
        library.settings.mode = Mode::Random;
        for _ in 0..100 {
            assert_ne!(library.next_photo(None, &[]).unwrap().id, "a");
        }
    }
    fn emoji(id: &str) -> EmojiChoice {
        EmojiChoice {
            id: id.into(),
            label: id.into(),
            source: "Test pack".into(),
            source_kind: None,
            thumbnail_url: None,
            text_color: false,
        }
    }
    #[test]
    fn emoji_ordering_and_random_selection_are_independent() {
        let mut library = Library {
            photos: vec![photo("photo-a")],
            last_photo_id: Some("photo-a".into()),
            ..Library::default()
        };
        library.select_emojis(vec![emoji("1"), emoji("2"), emoji("3")]);
        assert_eq!(library.next_emoji().unwrap().id, "1");
        library.last_emoji_id = Some("1".into());
        assert_eq!(library.next_emoji().unwrap().id, "2");
        library.select_emojis(vec![emoji("3"), emoji("2"), emoji("1")]);
        assert_eq!(library.next_emoji().unwrap().id, "3");
        library.emoji_settings.mode = Mode::Random;
        for _ in 0..100 {
            assert_ne!(library.next_emoji().unwrap().id, "1");
        }
        assert_eq!(library.next_photo(None, &[]).unwrap().id, "photo-a");
        library.select_emojis(vec![emoji("1")]);
        assert_eq!(library.next_emoji().unwrap().id, "1");
        library.select_emojis(Vec::new());
        assert!(library.next_emoji().is_none());
    }
    #[test]
    fn independent_schedules_preserve_cooldowns_and_empty_selection_stops_only_emojis() {
        let mut library = Library {
            photos: vec![photo("photo-a")],
            ..Library::default()
        };
        assert!(
            library
                .update_emoji_settings(
                    Settings {
                        enabled: true,
                        ..Settings::default()
                    },
                    100
                )
                .is_err()
        );
        library.select_emojis(vec![emoji("1")]);
        library
            .update_settings(
                Settings {
                    enabled: true,
                    interval_secs: 10,
                    ..Settings::default()
                },
                100,
            )
            .unwrap();
        library
            .update_emoji_settings(
                Settings {
                    enabled: true,
                    interval_secs: 60,
                    ..Settings::default()
                },
                100,
            )
            .unwrap();
        assert!((109..=111).contains(&library.next_rotation_at.unwrap()));
        assert!((154..=166).contains(&library.next_emoji_rotation_at.unwrap()));
        let emoji_due = library.next_emoji_rotation_at;
        library
            .update_settings(
                Settings {
                    enabled: true,
                    interval_secs: 20,
                    ..Settings::default()
                },
                100,
            )
            .unwrap();
        assert!((118..=122).contains(&library.next_rotation_at.unwrap()));
        assert_eq!(library.next_emoji_rotation_at, emoji_due);
        library.defer_telegram(500);
        assert_eq!(library.next_rotation_at, Some(500));
        assert_eq!(library.next_emoji_rotation_at, Some(500));
        library
            .update_emoji_settings(
                Settings {
                    enabled: true,
                    interval_secs: 1,
                    ..Settings::default()
                },
                100,
            )
            .unwrap();
        assert_eq!(library.next_emoji_rotation_at, Some(500));
        assert_eq!(library.settings.interval_secs, 20);
        library.select_emojis(Vec::new());
        assert!(!library.emoji_settings.enabled);
        assert!(library.next_emoji_rotation_at.is_none());
        assert!(library.settings.enabled);
        assert_eq!(library.next_rotation_at, Some(500));
    }
    #[test]
    fn old_library_restores_photo_schedule_and_leaves_new_emoji_rotation_stopped() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("library.json"), r#"{"photos":[{"id":"photo-a","name":"Portrait"}],"settings":{"enabled":true,"mode":"ordered","interval_secs":60,"jitter_secs":0},"next_rotation_at":1234,"last_photo_id":"photo-a","selected_emojis":[{"id":"9223372036854775806","label":"Star","source":"Pack","thumbnail_url":null}]}"#).unwrap();
        let mut repository = Repository::open(dir.path().into()).unwrap();
        assert!(repository.data.settings.enabled);
        assert_eq!(repository.data.settings.jitter_secs, Some(0));
        assert_eq!(
            repository
                .data
                .applied_settings
                .as_ref()
                .unwrap()
                .interval_secs,
            60
        );
        assert!(repository.data.applied_emoji_settings.is_none());
        assert_eq!(repository.data.next_rotation_at, Some(1234));
        assert_eq!(repository.data.selected_emojis[0].id, "9223372036854775806");
        assert!(!repository.data.emoji_settings.enabled);
        assert_eq!(repository.data.next_emoji_rotation_at, None);
        repository
            .update(|library| {
                library.update_emoji_settings(
                    Settings {
                        enabled: true,
                        interval_secs: 17,
                        ..Settings::default()
                    },
                    100,
                )?;
                library.last_emoji_id = Some("9223372036854775806".into());
                Ok(())
            })
            .unwrap();
        drop(repository);
        let repository = Repository::open(dir.path().into()).unwrap();
        assert_eq!(repository.data.next_rotation_at, Some(1234));
        assert!((115..=119).contains(&repository.data.next_emoji_rotation_at.unwrap()));
        assert_eq!(repository.data.emoji_settings.jitter_secs, None);
        assert!(repository.data.emoji_settings.enabled);
        assert_eq!(
            repository.data.last_emoji_id.as_deref(),
            Some("9223372036854775806")
        );
    }
    #[test]
    fn persistence_is_transactional_and_locked() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::open(dir.path().into()).unwrap();
        assert!(Repository::open(dir.path().into()).is_err());
        repo.add_upload("hello", b"jpeg", b"jpeg", None).unwrap();
        repo.update(|l| {
            l.update_settings(
                Settings {
                    enabled: true,
                    ..Settings::default()
                },
                1000,
            )
        })
        .unwrap();
        let due = repo.data.next_rotation_at;
        assert!(
            repo.update(|l| {
                l.photos.clear();
                bail!("fail")
            })
            .is_err()
        );
        assert_eq!(repo.data.photos.len(), 1);
        drop(repo);
        let repo = Repository::open(dir.path().into()).unwrap();
        assert_eq!(repo.data.photos[0].name, "hello");
        assert!(repo.data.settings.enabled);
        assert_eq!(repo.data.next_rotation_at, due);
    }
    #[test]
    fn rotation_skips_missing_photos_and_keeps_pending_on_retry_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::open(dir.path().into()).unwrap();
        repo.update(|library| {
            library.photos = vec![photo("a"), photo("b"), photo("c")];
            library.settings.enabled = true;
            library.settings.interval_secs = 3600;
            library.settings.jitter_secs = Some(0);
            library.applied_settings = Some(library.settings.clone());
            library.next_rotation_at = Some(100);
            Ok(())
        })
        .unwrap();
        assert!(
            repo.prepare_photo_rotation(99, None, &[])
                .unwrap()
                .is_none()
        );
        assert_eq!(
            repo.prepare_photo_rotation(100, None, &[])
                .unwrap()
                .unwrap()
                .id,
            "a"
        );
        assert_eq!(repo.data.next_rotation_at, Some(3700));
        // "a" is missing; "b" is attempted next but a transient error leaves it pending.
        assert_eq!(
            repo.prepare_photo_rotation(100, Some("a"), &["a".into()])
                .unwrap()
                .unwrap()
                .id,
            "b"
        );
        repo.retry_photo_rotation(repo.photo_schedule_revision(), 100, 30)
            .unwrap();
        drop(repo);
        let mut repo = Repository::open(dir.path().into()).unwrap();
        assert!(
            repo.prepare_photo_rotation(129, None, &[])
                .unwrap()
                .is_none()
        );
        assert_eq!(
            repo.prepare_photo_rotation(130, None, &[])
                .unwrap()
                .unwrap()
                .id,
            "b"
        );
        repo.complete_photo_rotation("b").unwrap();
        assert_eq!(
            repo.prepare_photo_rotation(3730, None, &[])
                .unwrap()
                .unwrap()
                .id,
            "c"
        );
        assert_eq!(repo.data.last_photo_id.as_deref(), Some("b"));
    }

    #[test]
    fn rotation_stops_if_every_photo_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::open(dir.path().into()).unwrap();
        repo.update(|library| {
            library.photos = vec![photo("a"), photo("b")];
            library.settings.enabled = true;
            library.applied_settings = Some(library.settings.clone());
            library.next_rotation_at = Some(100);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            repo.prepare_photo_rotation(100, None, &[])
                .unwrap()
                .unwrap()
                .id,
            "a"
        );
        assert_eq!(
            repo.prepare_photo_rotation(100, Some("a"), &["a".into()])
                .unwrap()
                .unwrap()
                .id,
            "b"
        );
        assert!(
            repo.prepare_photo_rotation(100, Some("b"), &["a".into(), "b".into()])
                .unwrap()
                .is_none()
        );
        assert!(!repo.data.settings.enabled);
        assert_eq!(repo.data.next_rotation_at, None);
        assert_eq!(repo.data.pending_photo_id, None);
        assert_eq!(repo.data.photos.len(), 2);
    }

    #[test]
    fn duplicate_images_and_telegram_selections_are_linked_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::open(dir.path().into()).unwrap();
        repo.add_upload("portrait", b"jpeg", b"jpeg", None).unwrap();
        repo.add_upload("portrait copy", b"jpeg", b"jpeg", Some("42".into()))
            .unwrap();
        repo.add_history_photo("42".into()).unwrap();
        assert_eq!(repo.data.photos.len(), 1);
        assert_eq!(repo.data.photos[0].telegram_id.as_deref(), Some("42"));
        let local_id = repo.data.photos[0].id.clone();
        repo.remove_photo(&local_id).unwrap();
        repo.add_history_photo("42".into()).unwrap();
        let local_id = repo.data.photos[0].id.clone();
        assert!(!repo.photo_path(&local_id).unwrap().exists());
        repo.remove_photo(&local_id).unwrap();
        assert!(repo.data.photos.is_empty());
    }

    #[test]
    fn exif_orientation_and_normalized_crop() {
        let source = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(300, 200, |x, _| {
            if x < 150 {
                image::Rgb([240, 0, 0])
            } else {
                image::Rgb([0, 0, 240])
            }
        }));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
            .encode_image(&source)
            .unwrap();
        // EXIF orientation 6 rotates the landscape image 90 degrees clockwise.
        let exif: &[u8] =
            b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut oriented = jpeg[..2].to_vec();
        oriented.extend_from_slice(&[0xff, 0xe1]);
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(exif);
        oriented.extend_from_slice(&jpeg[2..]);
        let crop = Crop {
            x: 0.0,
            y: 0.0,
            size: 0.5,
        };
        let output = render_photo(&oriented, Some(&crop)).unwrap();
        let image = image::load_from_memory(&output).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (640, 640));
        let pixel = image.get_pixel(320, 320);
        assert!(pixel[0] > 200 && pixel[2] < 40, "{pixel:?}");
        assert!(
            render_photo(
                &oriented,
                Some(&Crop {
                    x: 0.9,
                    y: 0.0,
                    size: 1.0
                })
            )
            .is_err()
        );
    }

    #[test]
    fn crop_persists_original_and_detaches_only_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(dir.path().into()).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(240, 180)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let original = png.into_inner();
        let jpeg = normalize_photo(&original).unwrap();
        repository
            .add_upload("test", &original, &jpeg, Some("42".into()))
            .unwrap();
        let id = repository.data.photos[0].id.clone();
        repository.save_crop(&id, None, &original).unwrap();
        assert_eq!(repository.data.photos[0].telegram_id.as_deref(), Some("42"));
        let crop = Some(Crop {
            x: 0.0,
            y: 0.0,
            size: 0.5,
        });
        repository.save_crop(&id, crop.clone(), &original).unwrap();
        assert!(repository.data.photos[0].telegram_id.is_none());
        assert!(!repository.data.photos[0].history_checked);
        assert_eq!(repository.original(&id).unwrap(), original);
        drop(repository);
        let repository = Repository::open(dir.path().into()).unwrap();
        assert_eq!(repository.data.photos[0].crop, crop);
        assert_eq!(
            image::load_from_memory(&fs::read(repository.photo_path(&id).unwrap()).unwrap())
                .unwrap()
                .width(),
            640
        );
    }

    fn block_state_save(dir: &std::path::Path) {
        let state = dir.join("library.json");
        if state.exists() {
            fs::remove_file(&state).unwrap();
        }
        fs::create_dir(&state).unwrap();
    }

    #[test]
    fn uploads_deduplicate_originals_without_discarding_different_editable_images() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::open(dir.path().into()).unwrap();
        // The default center crop excludes the differing outside borders.
        let original = |border| {
            let image =
                image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(300, 200, |x, _| {
                    if !(50..250).contains(&x) {
                        image::Rgb([border, 0, 0])
                    } else {
                        image::Rgb([0, 200, 0])
                    }
                }));
            let mut bytes = std::io::Cursor::new(Vec::new());
            image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            bytes.into_inner()
        };
        let original_a = original(10);
        let original_b = original(240);
        let jpeg = normalize_photo(&original_a).unwrap();
        assert_eq!(jpeg, normalize_photo(&original_b).unwrap());
        repo.add_upload("a", &original_a, &jpeg, Some("42".into()))
            .unwrap();
        repo.add_upload("a duplicate", &original_a, &jpeg, Some("42".into()))
            .unwrap();
        repo.add_upload("b", &original_b, &jpeg, Some("42".into()))
            .unwrap();
        assert_eq!(repo.data.photos.len(), 2);
        assert_eq!(repo.data.photos[0].telegram_id.as_deref(), Some("42"));
        assert_eq!(repo.data.photos[1].telegram_id, None);
        assert_eq!(repo.original(&repo.data.photos[0].id).unwrap(), original_a);
        assert_eq!(repo.original(&repo.data.photos[1].id).unwrap(), original_b);
        // The free Telegram match can link an exact original, but not another crop.
        repo.add_upload("b duplicate", &original_b, &jpeg, Some("43".into()))
            .unwrap();
        assert_eq!(repo.data.photos[1].telegram_id.as_deref(), Some("43"));
        repo.update(|library| {
            library.photos[1].telegram_id = None;
            library.photos[1].crop = Some(Crop {
                x: 0.0,
                y: 0.0,
                size: 0.5,
            });
            Ok(())
        })
        .unwrap();
        repo.add_upload("b duplicate", &original_b, &jpeg, Some("44".into()))
            .unwrap();
        assert_eq!(repo.data.photos[1].telegram_id, None);
        assert_eq!(repo.data.photos.len(), 2);
    }

    #[test]
    fn failed_upload_state_save_removes_both_image_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::open(dir.path().into()).unwrap();
        block_state_save(dir.path());
        assert!(repo.add_upload("a", b"original", b"preview", None).is_err());
        assert!(repo.data.photos.is_empty());
        assert_eq!(fs::read_dir(dir.path().join("photos")).unwrap().count(), 0);
    }

    #[test]
    fn failed_crop_state_save_restores_preview_and_link() {
        for local in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let mut repo = Repository::open(dir.path().into()).unwrap();
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(240, 180)
                .write_to(&mut png, image::ImageFormat::Png)
                .unwrap();
            let original = png.into_inner();
            if local {
                repo.add_upload("a", &original, b"old preview", Some("42".into()))
                    .unwrap();
            } else {
                repo.add_history_photo("42".into()).unwrap();
            }
            let id = repo.data.photos[0].id.clone();
            let path = repo.photo_path(&id).unwrap();
            let original_path = repo.original_path(&id).unwrap();
            block_state_save(dir.path());
            assert!(
                repo.save_crop(
                    &id,
                    Some(Crop {
                        x: 0.0,
                        y: 0.0,
                        size: 0.5
                    }),
                    &original
                )
                .is_err()
            );
            assert_eq!(repo.data.photos[0].telegram_id.as_deref(), Some("42"));
            assert_eq!(repo.data.photos[0].crop, None);
            if local {
                assert_eq!(fs::read(path).unwrap(), b"old preview");
                assert_eq!(fs::read(original_path).unwrap(), original);
            } else {
                assert!(!path.exists());
                assert!(!original_path.exists());
            }
        }
    }

    #[test]
    fn image_validation_and_normalization() {
        assert!(normalize_photo(b"not an image").is_err());
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(200, 300)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let output = normalize_photo(png.get_ref()).unwrap();
        let image = image::load_from_memory(&output).unwrap();
        assert_eq!((image.width(), image.height()), (640, 640));
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(100, 100)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        assert!(normalize_photo(png.get_ref()).is_err());
    }
}
