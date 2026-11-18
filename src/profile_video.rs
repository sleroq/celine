use std::{
    fs, io,
    path::Path,
    process::{Command, Stdio},
};

use anyhow::{Context, Result, ensure};

use crate::{library::Crop, messages::Message};

// Use the same display geometry in the crop editor and in the rendered video.
const SQUARE_PIXELS: &str = "scale='round(iw*sar)':ih,setsar=1";

pub fn is_mp4(bytes: &[u8]) -> bool {
    bytes.get(4..8) == Some(b"ftyp") && bytes.get(8..12).is_some_and(|brand| brand != b"qt  ")
}

pub fn original_frame(bytes: &[u8]) -> Result<Vec<u8>> {
    let directory = tempfile::tempdir()?;
    let input = directory.path().join("input.mp4");
    fs::write(&input, bytes)?;
    frame(
        &input,
        &directory.path().join("original.jpg"),
        SQUARE_PIXELS,
    )
}

pub fn prepare(bytes: &[u8], crop: Option<&Crop>) -> Result<(Vec<u8>, Vec<u8>)> {
    ensure!(
        bytes.len() <= 10 * 1024 * 1024,
        Message::new("upload.video_too_large", "Videos must be at most 10 MiB.")
    );
    let directory = tempfile::tempdir()?;
    let input = directory.path().join("input.mp4");
    let video = directory.path().join("profile.mp4");
    let poster = directory.path().join("poster.jpg");
    fs::write(&input, bytes)?;
    let square = if let Some(crop) = crop {
        let original = frame(
            &input,
            &directory.path().join("original.jpg"),
            SQUARE_PIXELS,
        )?;
        let (width, height) =
            image::ImageReader::with_format(io::Cursor::new(original), image::ImageFormat::Jpeg)
                .into_dimensions()
                .context(invalid_video())?;
        let (x, y, side) = crop.pixels(width, height)?;
        format!("crop={side}:{side}:{x}:{y}:exact=1")
    } else {
        "crop='min(iw,ih)':'min(iw,ih)':exact=1".to_owned()
    };
    let filter = format!("{SQUARE_PIXELS},{square},scale=800:800,setsar=1,fps=24");
    // Telegram takes a square MPEG-4 file. Follow TDLib's 10-second and 2 MB limits.
    ffmpeg(
        ffmpeg_input(&input)
            .args([
                "-an",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-vf",
                &filter,
                "-t",
                "10",
                "-c:v",
                "libx264",
                // Stable output lets identical uploads deduplicate by bytes.
                "-threads",
                "1",
                "-preset",
                "fast",
                "-pix_fmt",
                "yuv420p",
                "-b:v",
                "1000k",
                "-maxrate",
                "1200k",
                "-bufsize",
                "800k",
                "-movflags",
                "+faststart",
            ])
            .arg(&video),
    )?;
    let jpeg = frame(&video, &poster, "null")?;
    let video = fs::read(video)?;
    ensure!(video.len() <= 2_000_000, invalid_video());
    Ok((video, jpeg))
}

fn frame(input: &Path, output: &Path, filter: &str) -> Result<Vec<u8>> {
    ffmpeg(
        ffmpeg_input(input)
            .args(["-vf", filter, "-frames:v", "1", "-q:v", "3", "-update", "1"])
            .arg(output),
    )?;
    fs::read(output).context(invalid_video())
}

fn ffmpeg_input(input: &Path) -> Command {
    let mut command = Command::new("ffmpeg");
    command
        .args(["-nostdin", "-protocol_whitelist", "file", "-f", "mov", "-i"])
        .arg(input)
        .args(["-map", "0:V:0"]);
    command
}

fn ffmpeg(command: &mut Command) -> Result<()> {
    let status = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Message::new(
                    "upload.ffmpeg_missing",
                    "Install FFmpeg to upload animated profile pictures.",
                )
            } else {
                invalid_video()
            }
        })?;
    ensure!(status.success(), invalid_video());
    Ok(())
}

fn invalid_video() -> Message {
    Message::new(
        "upload.video_invalid",
        "Cannot prepare this MP4. Choose a valid video file.",
    )
}
