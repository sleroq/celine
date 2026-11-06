//! Account-local history snapshots and validated photo bytes; never accesses Telegram.
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};

use crate::photo_match::Fingerprint;

pub struct PhotoCache {
    directory: PathBuf,
    history: Option<Vec<String>>,
    cached: HashMap<String, Fingerprint>,
}

impl PhotoCache {
    pub fn open(account_dir: &Path) -> Result<Self> {
        let directory = account_dir.join("photo-history");
        fs::create_dir_all(&directory)?;
        let history = match fs::read(directory.join("history.json")) {
            Ok(bytes) => {
                let ids: Vec<String> =
                    serde_json::from_slice(&bytes).context("reading photo history snapshot")?;
                for id in &ids {
                    validate_id(id)?;
                }
                Some(ids)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let mut cache = Self {
            directory,
            history,
            cached: HashMap::new(),
        };
        for entry in fs::read_dir(&cache.directory)? {
            let path = entry?.path();
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if path.extension().is_none_or(|extension| extension != "jpg")
                || validate_id(id).is_err()
            {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            let Ok(fingerprint) = Fingerprint::decode(&bytes) else {
                continue;
            };
            cache.cached.insert(id.to_owned(), fingerprint);
        }
        Ok(cache)
    }

    pub fn photos(&self) -> Vec<String> {
        self.history.clone().unwrap_or_default()
    }

    pub fn available(&self) -> Vec<String> {
        self.photos()
            .into_iter()
            .filter(|id| self.cached.contains_key(id))
            .collect()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.history
            .as_ref()
            .is_some_and(|ids| ids.iter().any(|item| item == id))
            && self.cached.contains_key(id)
    }

    pub fn complete(&self) -> bool {
        self.history.is_some() && self.missing().is_empty()
    }

    pub fn set_history(&mut self, ids: Vec<String>) -> Result<()> {
        for id in &ids {
            validate_id(id)?;
        }
        self.persist(
            &self.directory.join("history.json"),
            &serde_json::to_vec(&ids)?,
        )?;
        self.history = Some(ids);
        Ok(())
    }

    pub fn missing(&self) -> Vec<String> {
        self.photos()
            .into_iter()
            .filter(|id| !self.cached.contains_key(id))
            .collect()
    }

    pub fn store(&mut self, id: &str, bytes: &[u8]) -> Result<()> {
        validate_id(id)?;
        ensure!(
            self.history
                .as_ref()
                .is_some_and(|ids| ids.iter().any(|item| item == id)),
            "photo is not in the current history snapshot"
        );
        let fingerprint = Fingerprint::decode(bytes).context("decoding cached photo")?;
        self.persist(&self.image_path(id), bytes)?;
        self.cached.insert(id.to_owned(), fingerprint);
        Ok(())
    }

    pub fn remember(&mut self, id: &str, bytes: &[u8]) -> Result<()> {
        validate_id(id)?;
        let mut ids = self.photos();
        ids.retain(|item| item != id);
        ids.insert(0, id.to_owned());
        self.set_history(ids)?;
        self.store(id, bytes)
    }

    pub fn image(&self, id: &str) -> Option<Vec<u8>> {
        self.cached.get(id)?;
        fs::read(self.image_path(id)).ok()
    }

    pub fn matching(
        &self,
        jpeg: &[u8],
        available: impl Fn(&str) -> bool,
    ) -> Result<Option<String>> {
        let candidate = Fingerprint::decode(jpeg)?;
        for id in self.photos() {
            if available(&id)
                && self
                    .cached
                    .get(&id)
                    .is_some_and(|photo| candidate.is_close(photo))
            {
                return Ok(Some(id));
            }
        }
        // None only means no cached match; callers must consult complete() before
        // interpreting it as absence from the full Telegram history.
        Ok(None)
    }

    fn image_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.jpg"))
    }

    fn persist(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        temporary.write_all(bytes)?;
        temporary.persist(path)?;
        Ok(())
    }
}

fn validate_id(id: &str) -> Result<()> {
    let number: i64 = id.parse().context("photo ID must be a canonical i64")?;
    ensure!(number.to_string() == id, "photo ID must be a canonical i64");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;

    fn jpeg() -> Vec<u8> {
        let image = image::load_from_memory(include_bytes!("../web/public/logo.jpg")).unwrap();
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode_image(&image)
            .unwrap();
        bytes
    }

    #[test]
    fn unknown_and_successful_empty_history_are_distinct() {
        let account = tempfile::tempdir().unwrap();
        let mut cache = PhotoCache::open(account.path()).unwrap();
        assert!(cache.photos().is_empty());
        assert!(cache.missing().is_empty());
        assert!(!cache.complete());
        cache.set_history(vec![]).unwrap();
        assert!(cache.complete());
        assert!(PhotoCache::open(account.path()).unwrap().complete());
    }

    #[test]
    fn partial_history_resumes_and_matches_in_snapshot_order() {
        let account = tempfile::tempdir().unwrap();
        let bytes = jpeg();
        let mut cache = PhotoCache::open(account.path()).unwrap();
        cache.set_history(vec!["2".into(), "1".into()]).unwrap();
        cache.store("1", &bytes).unwrap();
        assert_eq!(cache.missing(), ["2"]);
        assert!(!cache.complete());
        assert_eq!(
            cache.matching(&bytes, |_| true).unwrap().as_deref(),
            Some("1")
        );
        let mut cache = PhotoCache::open(account.path()).unwrap();
        assert_eq!(cache.image("1"), Some(bytes.clone()));
        assert_eq!(cache.missing(), ["2"]);
        cache.store("2", &bytes).unwrap();
        assert!(cache.complete());
        assert_eq!(
            cache.matching(&bytes, |_| true).unwrap().as_deref(),
            Some("2")
        );
        assert_eq!(
            cache.matching(&bytes, |id| id != "2").unwrap().as_deref(),
            Some("1")
        );
        assert!(PhotoCache::open(account.path()).unwrap().complete());
    }

    #[test]
    fn missing_and_corrupt_files_invalidate_reopened_cache() {
        let account = tempfile::tempdir().unwrap();
        let mut cache = PhotoCache::open(account.path()).unwrap();
        cache.set_history(vec!["1".into(), "2".into()]).unwrap();
        let bytes = jpeg();
        cache.store("1", &bytes).unwrap();
        cache.store("2", &bytes).unwrap();
        fs::remove_file(cache.image_path("1")).unwrap();
        fs::write(cache.image_path("2"), b"broken").unwrap();
        let cache = PhotoCache::open(account.path()).unwrap();
        assert!(!cache.complete());
        assert_eq!(cache.missing(), ["1", "2"]);
        assert!(cache.image("2").is_none());
        assert!(cache.matching(&bytes, |_| true).unwrap().is_none());
    }

    #[test]
    fn fresh_listing_prunes_and_invalid_input_does_not_replace_valid_data() {
        let account = tempfile::tempdir().unwrap();
        let mut cache = PhotoCache::open(account.path()).unwrap();
        let bytes = jpeg();
        cache.set_history(vec!["1".into(), "-2".into()]).unwrap();
        cache.store("1", &bytes).unwrap();
        assert!(cache.store("1", b"broken").is_err());
        for id in ["../escape", "01", "+1", "9223372036854775808"] {
            assert!(cache.store(id, &bytes).is_err());
            assert!(cache.set_history(vec![id.into()]).is_err());
        }
        assert!(cache.store("3", &bytes).is_err());
        assert!(cache.matching(b"broken", |_| true).is_err());
        cache.set_history(vec!["1".into()]).unwrap();
        assert!(cache.complete());
        cache.set_history(vec![]).unwrap();
        assert_eq!(cache.image("1"), Some(bytes.clone()));
        assert!(cache.matching(&bytes, |_| true).unwrap().is_none());
        let restored = PhotoCache::open(account.path()).unwrap();
        assert!(restored.photos().is_empty());
        assert_eq!(restored.image("1"), Some(bytes));
    }
}
