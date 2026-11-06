//! Conservative near-duplicate detection, not proof of image identity.
use image::{DynamicImage, imageops::FilterType};

pub struct Fingerprint {
    hash: u64,
    colors: Vec<u8>,
    aspect: f64,
}

impl Fingerprint {
    pub fn decode(bytes: &[u8]) -> image::ImageResult<Self> {
        let image = image::load_from_memory(bytes)?;
        Ok(Self::from_image(&image))
    }

    fn from_image(image: &DynamicImage) -> Self {
        // RGB resizing retains regional color, unlike a grayscale-only hash.
        let colors = image
            .resize_exact(16, 16, FilterType::Triangle)
            .to_rgb8()
            .into_raw();
        let gray = image.resize_exact(9, 8, FilterType::Triangle).to_luma8();
        let mut hash = 0;
        for y in 0..8 {
            for x in 0..8 {
                if gray.get_pixel(x, y)[0] > gray.get_pixel(x + 1, y)[0] {
                    hash |= 1 << (y * 8 + x);
                }
            }
        }
        Self {
            hash,
            colors,
            aspect: f64::from(image.width()) / f64::from(image.height()),
        }
    }

    pub fn is_close(&self, other: &Self) -> bool {
        if (self.aspect / other.aspect - 1.0).abs() > 0.02
            || (self.hash ^ other.hash).count_ones() > 4
        {
            return false;
        }
        let mut squared = 0_u64;
        for (left, right) in self
            .colors
            .as_chunks::<3>()
            .0
            .iter()
            .zip(other.colors.as_chunks::<3>().0.iter())
        {
            let regional: u64 = left
                .iter()
                .zip(right)
                .map(|(&a, &b)| {
                    let difference = i32::from(a) - i32::from(b);
                    (difference * difference) as u64
                })
                .sum();
            // Reject localized differences as well as average color changes.
            if regional > 3 * 24 * 24 {
                return false;
            }
            squared += regional;
        }
        squared <= self.colors.len() as u64 * 9 * 9
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, codecs::jpeg::JpegEncoder};

    fn picture() -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(256, 256, |x, y| {
            Rgb([(x / 2 + y / 4) as u8, (y / 2) as u8, (x / 3) as u8])
        }))
    }

    #[test]
    fn matches_jpeg_compression_and_resizing() {
        let original = picture();
        let resized = original.resize_exact(160, 160, FilterType::Lanczos3);
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 65)
            .encode_image(&resized)
            .unwrap();
        assert!(Fingerprint::from_image(&original).is_close(&Fingerprint::decode(&bytes).unwrap()));
    }

    #[test]
    fn matches_a_recompressed_profile_photo() {
        let original = image::load_from_memory(include_bytes!("../web/public/logo.jpg")).unwrap();
        let resized = original.resize_exact(320, 320, FilterType::Lanczos3);
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 75)
            .encode_image(&resized)
            .unwrap();
        assert!(Fingerprint::from_image(&original).is_close(&Fingerprint::decode(&bytes).unwrap()));
    }

    #[test]
    fn rejects_different_colors_with_identical_structure() {
        let red = DynamicImage::ImageRgb8(RgbImage::from_pixel(128, 128, Rgb([180, 30, 30])));
        let blue = DynamicImage::ImageRgb8(RgbImage::from_pixel(128, 128, Rgb([30, 30, 180])));
        assert!(!Fingerprint::from_image(&red).is_close(&Fingerprint::from_image(&blue)));
    }

    #[test]
    fn rejects_different_spatial_image_and_bad_input() {
        let original = picture();
        assert!(
            !Fingerprint::from_image(&original)
                .is_close(&Fingerprint::from_image(&original.fliph()))
        );
        assert!(Fingerprint::decode(b"not an image").is_err());
    }
}
