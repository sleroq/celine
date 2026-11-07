use crate::messages::{Message, MessageInfo};
use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, MatchedPath, Multipart, Path, Query, State},
    http::{HeaderMap, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use include_dir::{Dir, include_dir};
use serde::Deserialize;
use serde_json::json;
use tracing::Instrument;

use crate::{
    app::{App, ScheduleAction, unavailable},
    library::{Crop, Settings, normalize_photo},
    telegram::{EmojiSearch, EmojiSearchResults, TelegramError},
};

static ASSETS: Dir<'_> = include_dir!("$OUT_DIR/web");
pub const ADDRESS: &str = "127.0.0.1:7766";

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/state", get(state))
        .route("/api/settings", put(settings))
        .route("/api/settings/{action}", post(photo_schedule))
        .route("/api/emojis/settings/{action}", post(emoji_schedule))
        .route("/api/emojis/settings", put(emoji_settings))
        .route("/api/profile/photo", get(profile_photo))
        .route("/api/photos", post(upload))
        .route(
            "/api/photos/history",
            get(photo_history).post(select_history_photo),
        )
        .route("/api/photos/history/refresh", post(refresh_photo_history))
        .route("/api/photos/history/{id}", get(history_photo))
        .route("/api/photos/order", post(reorder))
        .route("/api/photos/{id}", get(photo).delete(remove))
        .route("/api/photos/{id}/reupload", post(reupload_photo))
        .route("/api/photos/{id}/original", get(original_photo))
        .route("/api/photos/{id}/crop", put(save_crop))
        .route("/api/auth/qr", post(qr))
        .route("/api/auth/password", post(password))
        .route("/api/emojis", get(emojis).put(select_emojis))
        .route("/api/emojis/search", get(search_emojis))
        .route("/api/emojis/sets/{id}", get(emoji_set))
        .route("/api/emojis/sets/{id}/cover", get(emoji_set_cover))
        .route("/api/emojis/{id}/thumbnail", get(emoji_thumbnail))
        .route("/api/emojis/{id}/media", get(emoji_media))
        .fallback(assets)
        .layer(DefaultBodyLimit::max(12 * 1024 * 1024))
        .layer(middleware::from_fn(log_request))
        .layer(middleware::from_fn(local_boundary))
        .with_state(app)
}
pub async fn serve(app: Arc<crate::accounts::Accounts>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(ADDRESS).await?;
    let url = format!("http://{ADDRESS}");
    println!("Celine is ready at {url}");
    tracing::info!("Local HTTP server ready");
    open_browser(url);
    axum::serve(listener, accounts_router(app))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn open_browser(url: String) {
    std::thread::spawn(move || {
        if let Err(error) = open::that(&url) {
            tracing::warn!("Could not open the browser automatically");
            eprintln!("Could not open the browser automatically: {error}. Open {url} manually.");
        }
    });
}

pub fn accounts_router(accounts: Arc<crate::accounts::Accounts>) -> Router {
    Router::new()
        .fallback(account_request)
        .layer(middleware::from_fn(local_boundary))
        .with_state(accounts)
}
async fn account_request(
    State(accounts): State<Arc<crate::accounts::Accounts>>,
    mut request: Request<Body>,
) -> Response {
    use tower::ServiceExt;
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    if path == "/api/state" && method == axum::http::Method::GET {
        return Json(accounts.state().await).into_response();
    }
    if path == "/api/accounts" && method == axum::http::Method::POST {
        return match accounts.create().await {
            Ok(()) => ok(),
            Err(error) => bad(error),
        };
    }
    let scoped = path.strip_prefix("/api/accounts/");
    let (id, tail) = scoped
        .map(|path| path.split_once('/').unwrap_or((path, "")))
        .unwrap_or(("", ""));
    let Some((id, app)) = accounts.app(scoped.map(|_| id)).await else {
        return api_error(
            StatusCode::NOT_FOUND,
            "Account not found.",
            MessageInfo::new("account.not_found"),
        );
    };
    if scoped.is_some() {
        if tail == "active" && method == axum::http::Method::PUT {
            return match accounts.activate(&id).await {
                Ok(()) => ok(),
                Err(error) => bad(error),
            };
        }
        if tail.is_empty() && method == axum::http::Method::DELETE {
            return match accounts
                .remove(&id)
                .instrument(tracing::info_span!("account", account_id = id.as_str()))
                .await
            {
                Ok(()) => ok(),
                Err(error) => match error.downcast::<TelegramError>() {
                    Ok(error) => telegram_error(&app, error).await,
                    Err(error) => api_error(
                        StatusCode::BAD_GATEWAY,
                        &error.to_string(),
                        MessageInfo::from_error(&error),
                    ),
                },
            };
        }
        let query = request
            .uri()
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        *request.uri_mut() = format!("/api/{tail}{query}").parse().unwrap();
    }
    let mut response = router(app)
        .oneshot(request)
        .instrument(tracing::info_span!("account", account_id = id.as_str()))
        .await
        .unwrap();
    if scoped.is_none() {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    } else if response.status() == StatusCode::OK && immutable_media_path(tail) {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, MEDIA_CACHE.parse().unwrap());
    }
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|value| value == "application/json")
    {
        let (mut parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            crate::accounts::scope_media(&mut value, &id);
            parts.headers.remove(header::CONTENT_LENGTH);
            return Response::from_parts(parts, Body::from(serde_json::to_vec(&value).unwrap()));
        }
        return Response::from_parts(parts, Body::from(bytes));
    }
    response
}

const MEDIA_CACHE: &str = "private, max-age=31536000, immutable";

fn immutable_media_path(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        ["photos", "history", id] => id.parse::<i64>().is_ok(),
        ["emojis", id, "thumbnail" | "media"] => id.parse::<i64>().is_ok(),
        _ => false,
    }
}

async fn log_request(request: Request<Body>, next: Next) -> Response {
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_owned())
        .unwrap_or_default();
    let span = tracing::info_span!("request", method = %method, route = route.as_str());
    async move {
        let response = next.run(request).await;
        if route.starts_with("/api/") {
            if response.status().is_success() && method != axum::http::Method::GET {
                tracing::info!(status = response.status().as_u16(), "API request completed");
            } else if (response.status().is_client_error() || response.status().is_server_error())
                && response.extensions().get::<LoggedError>().is_none()
            {
                tracing::warn!(status = response.status().as_u16(), "API request rejected");
            }
        }
        response
    }
    .instrument(span)
    .await
}

async fn local_boundary(request: Request<Body>, next: Next) -> Response {
    if !is_local_request(request.headers()) {
        return api_error(
            StatusCode::FORBIDDEN,
            "Only same-origin requests to Celine’s loopback address are allowed.",
            MessageInfo::new("request.local_only"),
        );
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(header::HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::CONTENT_SECURITY_POLICY,"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}
fn is_local_request(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    if !matches!(host, "127.0.0.1:7766" | "localhost:7766") {
        return false;
    }
    if let Some(origin) = headers.get(header::ORIGIN)
        && origin.to_str().ok() != Some(format!("http://{host}").as_str())
    {
        return false;
    }
    !headers
        .get("sec-fetch-site")
        .is_some_and(|value| value == "cross-site")
}
#[derive(Clone)]
struct LoggedError;

fn api_error(status: StatusCode, message: &str, info: MessageInfo) -> Response {
    tracing::warn!(
        status = status.as_u16(),
        code = info.code,
        "API request failed"
    );
    let mut response = (status, Json(json!({"error":message, "error_info":info}))).into_response();
    response.extensions_mut().insert(LoggedError);
    response
}
fn bad(error: anyhow::Error) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        &error.to_string(),
        MessageInfo::from_error(&error),
    )
}
fn ok() -> Response {
    StatusCode::NO_CONTENT.into_response()
}
async fn telegram_error(app: &App, error: TelegramError) -> Response {
    app.record_telegram_error(&error).await;
    let status = if error.retry_after.is_some() {
        StatusCode::TOO_MANY_REQUESTS
    } else if error.unauthorized {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::BAD_GATEWAY
    };
    let mut response = api_error(status, &error.message, error.message_info());
    if let Some(wait) = error.retry_after {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, wait.to_string().parse().unwrap());
    }
    response
}
async fn state(State(app): State<Arc<App>>) -> impl IntoResponse {
    Json(app.state().await)
}
async fn settings(State(app): State<Arc<App>>, Json(settings): Json<Settings>) -> Response {
    match app.update_settings(settings).await {
        Ok(()) => ok(),
        Err(error) => bad(error),
    }
}
async fn emoji_settings(State(app): State<Arc<App>>, Json(settings): Json<Settings>) -> Response {
    match app.update_emoji_settings(settings).await {
        Ok(()) => ok(),
        Err(error) => bad(error),
    }
}
async fn photo_schedule(State(app): State<Arc<App>>, Path(action): Path<String>) -> Response {
    schedule(app, false, &action).await
}
async fn emoji_schedule(State(app): State<Arc<App>>, Path(action): Path<String>) -> Response {
    schedule(app, true, &action).await
}
async fn schedule(app: Arc<App>, emoji: bool, action: &str) -> Response {
    let action = match action {
        "apply" => ScheduleAction::Apply,
        "start" => ScheduleAction::Start,
        "stop" => ScheduleAction::Stop,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    match app.schedule(emoji, action).await {
        Ok(()) => ok(),
        Err(error) => bad(error),
    }
}
#[derive(Deserialize)]
struct MediaVersion {
    v: Option<String>,
}

fn version_matches(url: Option<&str>, version: Option<&str>) -> bool {
    url.and_then(|url| url.split_once("?v=").map(|(_, version)| version)) == version
        && version.is_some()
}

fn versioned_media(bytes: Vec<u8>, content_type: &'static str, cache: bool) -> Response {
    let mut response = ([(header::CONTENT_TYPE, content_type)], bytes).into_response();
    if cache {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, MEDIA_CACHE.parse().unwrap());
    }
    response
}

async fn profile_photo(
    State(app): State<Arc<App>>,
    Query(version): Query<MediaVersion>,
) -> Response {
    let mut connection = match app.connection().await {
        Ok(connection) => connection,
        Err(error) => return telegram_error(&app, error).await,
    };
    let Some(telegram) = connection.as_mut() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "Profile photo unavailable.",
            MessageInfo::new("photo.profile_unavailable"),
        );
    };
    let cache = version_matches(telegram.profile_photo_url(), version.v.as_deref());
    match telegram.profile_photo().await {
        Ok((bytes, content_type)) => versioned_media(bytes, content_type, cache),
        Err(error) => telegram_error(&app, error).await,
    }
}
async fn emoji_media(State(app): State<Arc<App>>, Path(id): Path<i64>) -> Response {
    let mut connection = match app.connection().await {
        Ok(connection) => connection,
        Err(error) => return telegram_error(&app, error).await,
    };
    let Some(telegram) = connection.as_mut() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "Emoji media unavailable.",
            MessageInfo::new("emoji.media_unavailable"),
        );
    };
    let selected = app
        .repository
        .lock()
        .await
        .data
        .selected_emojis
        .iter()
        .any(|emoji| emoji.document_id.as_deref().unwrap_or(&emoji.id) == id.to_string());
    match telegram.emoji_media(id, selected).await {
        Ok((bytes, content_type)) => {
            ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(error) if error.retry_after.is_some() || error.unauthorized => {
            telegram_error(&app, error).await
        }
        Err(_) => api_error(
            StatusCode::NOT_FOUND,
            "Emoji media unavailable.",
            MessageInfo::new("emoji.media_unavailable"),
        ),
    }
}
async fn upload(State(app): State<Arc<App>>, mut multipart: Multipart) -> Response {
    let field = match multipart.next_field().await {
        Ok(Some(field)) => field,
        _ => return bad(Message::new("upload.file_required", "Choose a JPEG or PNG file.").into()),
    };
    let name = field.file_name().unwrap_or("Profile photo").to_owned();
    let bytes = match field.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => {
            return bad(Message::new(
                "upload.read_failed",
                "Cannot read upload. Maximum request size is 12 MiB.",
            )
            .into());
        }
    };
    let original = bytes.to_vec();
    let jpeg = match tokio::task::spawn_blocking(move || normalize_photo(&bytes)).await {
        Ok(Ok(jpeg)) => jpeg,
        Ok(Err(error)) => return bad(error),
        Err(_) => {
            return bad(
                Message::new("upload.processing_failed", "Image processing failed.").into(),
            );
        }
    };
    match multipart.next_field().await {
        Ok(None) => {}
        _ => return bad(Message::new("upload.one_image", "Upload one image per request.").into()),
    }
    match app.add_local_photo(&name, &original, &jpeg).await {
        Ok(()) => ok(),
        Err(_) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot save the photo. Check disk space and directory permissions.",
            MessageInfo::new("storage.photo_save_failed"),
        ),
    }
}
async fn photo_history(State(app): State<Arc<App>>) -> Response {
    Json(json!({"photos": app.state().await.photo_cache.photos})).into_response()
}

async fn refresh_photo_history(State(app): State<Arc<App>>) -> Response {
    app.refresh_photo_history().await;
    ok()
}
#[derive(Deserialize)]
struct PhotoId {
    id: String,
}
async fn select_history_photo(State(app): State<Arc<App>>, Json(photo): Json<PhotoId>) -> Response {
    if !app.photo_cache.lock().await.contains(&photo.id) {
        return api_error(
            StatusCode::NOT_FOUND,
            "Telegram photo not found in the local cache.",
            MessageInfo::new("photo.telegram_not_found"),
        );
    }
    match app.repository.lock().await.add_history_photo(photo.id) {
        Ok(()) => ok(),
        Err(_) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot save the photo selection.",
            MessageInfo::new("storage.photo_selection_save_failed"),
        ),
    }
}
async fn history_photo(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    history_photo_response(&app, &id).await
}
async fn history_photo_response(app: &App, id: &str) -> Response {
    match app.photo_cache.lock().await.image(id) {
        Some(bytes) => ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
        None => api_error(
            StatusCode::NOT_FOUND,
            "Telegram photo not found in the local cache.",
            MessageInfo::new("photo.telegram_not_found"),
        ),
    }
}
#[derive(Deserialize)]
struct Ids {
    ids: Vec<String>,
}
async fn reorder(State(app): State<Arc<App>>, Json(ids): Json<Ids>) -> Response {
    match app
        .repository
        .lock()
        .await
        .update(|library| library.reorder(&ids.ids))
    {
        Ok(()) => ok(),
        Err(error) => bad(error),
    }
}
async fn reupload_photo(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let _connection = app.lock_telegram().await;
    match app.reupload_photo(&id).await {
        Ok(()) => ok(),
        Err(error) => bad(error),
    }
}
async fn remove(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    match app.remove_photo(&id).await {
        Ok(()) => ok(),
        Err(error) => bad(error),
    }
}
#[derive(Deserialize)]
struct PhotoVersion {
    crop: Option<String>,
}

async fn photo(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Query(version): Query<PhotoVersion>,
) -> Response {
    let repository = app.repository.lock().await;
    let current_crop = repository
        .data
        .photos
        .iter()
        .find(|photo| photo.id == id)
        .map(|photo| &photo.crop);
    let cache = version.crop.as_deref().is_some_and(|crop| {
        serde_json::from_str::<Option<Crop>>(crop).is_ok_and(|crop| current_crop == Some(&crop))
    });
    let uncropped = current_crop == Some(&None);
    let path = match repository.photo_path(&id) {
        Ok(path) => path,
        Err(_) => {
            return api_error(
                StatusCode::NOT_FOUND,
                "Photo not found.",
                MessageInfo::new("photo.not_found"),
            );
        }
    };
    drop(repository);
    match tokio::fs::read(path).await {
        Ok(bytes) => versioned_media(bytes, "image/jpeg", cache),
        Err(_) => match photo_original_bytes(&app, &id).await {
            Ok(original) => match normalize_photo(&original) {
                Ok(jpeg) => versioned_media(jpeg, "image/jpeg", cache && uncropped),
                Err(error) => bad(error),
            },
            Err(response) => *response,
        },
    }
}
async fn photo_original_bytes(app: &App, id: &str) -> Result<Vec<u8>, Box<Response>> {
    let telegram_id = {
        let repository = app.repository.lock().await;
        if let Ok(bytes) = repository.original(id) {
            return Ok(bytes);
        }
        match repository.data.photos.iter().find(|photo| photo.id == id) {
            Some(photo) => photo.telegram_id.clone(),
            None => {
                return Err(Box::new(api_error(
                    StatusCode::NOT_FOUND,
                    "Photo not found.",
                    MessageInfo::new("photo.not_found"),
                )));
            }
        }
    };
    let Some(telegram_id) = telegram_id else {
        return Err(Box::new(api_error(
            StatusCode::NOT_FOUND,
            "Local photo is missing.",
            MessageInfo::new("photo.local_missing"),
        )));
    };
    app.photo_cache
        .lock()
        .await
        .image(&telegram_id)
        .ok_or_else(|| {
            Box::new(api_error(
                StatusCode::NOT_FOUND,
                "Telegram photo not found in the local cache.",
                MessageInfo::new("photo.telegram_not_found"),
            ))
        })
}

async fn original_photo(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    match photo_original_bytes(&app, &id).await {
        Ok(bytes) => {
            let mime = match image::guess_format(&bytes) {
                Ok(image::ImageFormat::Png) => "image/png",
                _ => "image/jpeg",
            };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(response) => *response,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CropRequest {
    crop: Option<Crop>,
}

async fn save_crop(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Json(request): Json<CropRequest>,
) -> Response {
    {
        let repository = app.repository.lock().await;
        let Some(photo) = repository.data.photos.iter().find(|photo| photo.id == id) else {
            return api_error(
                StatusCode::NOT_FOUND,
                "Photo not found.",
                MessageInfo::new("photo.not_found"),
            );
        };
        if photo.crop == request.crop {
            return ok();
        }
    }
    let original = match photo_original_bytes(&app, &id).await {
        Ok(bytes) => bytes,
        Err(response) => return *response,
    };
    // Rotation also holds this lock while linking the image it uploaded.
    let _connection = app.lock_telegram().await;
    let result = app
        .repository
        .lock()
        .await
        .save_crop(&id, request.crop, &original);
    match result {
        Ok(()) => match app.match_cropped_photo(&id).await {
            Ok(()) => ok(),
            Err(error) => bad(error),
        },
        Err(error) => bad(error),
    }
}
async fn qr(State(app): State<Arc<App>>) -> Response {
    match app.login_qr().await {
        Ok(()) => ok(),
        Err(error) => telegram_error(&app, error).await,
    }
}
#[derive(Deserialize)]
struct Password {
    password: String,
}
async fn password(State(app): State<Arc<App>>, Json(password): Json<Password>) -> Response {
    match app.login_password(&password.password).await {
        Ok(()) => ok(),
        Err(error) => telegram_error(&app, error).await,
    }
}
async fn emojis(State(app): State<Arc<App>>) -> Response {
    let mut connection = match app.connection().await {
        Ok(connection) => connection,
        Err(error) => return telegram_error(&app, error).await,
    };
    let Some(telegram) = connection.as_mut() else {
        return telegram_error(&app, unavailable()).await;
    };
    let choices = match telegram.emojis().await {
        Ok(choices) => choices,
        Err(error) => return telegram_error(&app, error).await,
    };
    let sets = match telegram.emoji_sets().await {
        Ok(sets) => sets,
        Err(error) => return telegram_error(&app, error).await,
    };
    app.remember_choices(&choices).await;
    Json(json!({"choices":choices,"sets":sets,"premium":app.auth.read().await.premium}))
        .into_response()
}
async fn search_emojis(State(app): State<Arc<App>>, Query(search): Query<EmojiSearch>) -> Response {
    if search.offset < 0 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "Search offset must be nonnegative.",
            MessageInfo::new("emoji.search_invalid_offset"),
        );
    }
    if search.q.trim().is_empty() && search.emoticon.trim().is_empty() {
        return Json(EmojiSearchResults {
            choices: Vec::new(),
            next_offset: None,
        })
        .into_response();
    }
    let mut connection = match app.connection().await {
        Ok(connection) => connection,
        Err(error) => return telegram_error(&app, error).await,
    };
    let Some(telegram) = connection.as_mut() else {
        return telegram_error(&app, unavailable()).await;
    };
    match telegram.search_emojis(&search).await {
        Ok(results) => {
            app.remember_choices(&results.choices).await;
            Json(results).into_response()
        }
        Err(error) => telegram_error(&app, error).await,
    }
}

async fn emoji_set(State(app): State<Arc<App>>, Path(id): Path<i64>) -> Response {
    let mut connection = match app.connection().await {
        Ok(connection) => connection,
        Err(error) => return telegram_error(&app, error).await,
    };
    let Some(telegram) = connection.as_mut() else {
        return telegram_error(&app, unavailable()).await;
    };
    match telegram.emoji_set(id).await {
        Ok(choices) => {
            app.remember_choices(&choices).await;
            Json(json!({"choices":choices})).into_response()
        }
        Err(error) => telegram_error(&app, error).await,
    }
}
async fn emoji_thumbnail(State(app): State<Arc<App>>, Path(id): Path<i64>) -> Response {
    let mut connection = match app.connection().await {
        Ok(connection) => connection,
        Err(error) => return telegram_error(&app, error).await,
    };
    let Some(telegram) = connection.as_mut() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "Thumbnail unavailable.",
            MessageInfo::new("emoji.thumbnail_unavailable"),
        );
    };
    match telegram.emoji_thumbnail(id).await {
        Ok((bytes, content_type)) => {
            ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(error) if error.retry_after.is_some() || error.unauthorized => {
            telegram_error(&app, error).await
        }
        Err(_) => api_error(
            StatusCode::NOT_FOUND,
            "Thumbnail unavailable. Refresh the emoji catalog to reload previews.",
            MessageInfo::new("emoji.thumbnail_refresh_required"),
        ),
    }
}
async fn emoji_set_cover(
    State(app): State<Arc<App>>,
    Path(id): Path<i64>,
    Query(version): Query<MediaVersion>,
) -> Response {
    let mut connection = match app.connection().await {
        Ok(connection) => connection,
        Err(error) => return telegram_error(&app, error).await,
    };
    let Some(telegram) = connection.as_mut() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "Pack cover unavailable.",
            MessageInfo::new("emoji.cover_unavailable"),
        );
    };
    let cache = version_matches(
        telegram.emoji_set_cover_url(id).as_deref(),
        version.v.as_deref(),
    );
    match telegram.emoji_set_cover(id).await {
        Ok((bytes, content_type)) => versioned_media(bytes, content_type, cache),
        Err(error) if error.retry_after.is_some() || error.unauthorized => {
            telegram_error(&app, error).await
        }
        Err(_) => api_error(
            StatusCode::NOT_FOUND,
            "Pack cover unavailable. Refresh the emoji catalog to reload previews.",
            MessageInfo::new("emoji.cover_refresh_required"),
        ),
    }
}
async fn select_emojis(State(app): State<Arc<App>>, Json(ids): Json<Ids>) -> Response {
    match app.select_emojis(&ids.ids).await {
        Ok(()) => ok(),
        Err(error) => bad(error),
    }
}
async fn assets(request: Request<Body>) -> Response {
    if request.method() != axum::http::Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match ASSETS.get_file(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string();
            ([(header::CONTENT_TYPE, mime)], file.contents()).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    #[tokio::test]
    async fn localized_errors_preserve_english_status_and_numeric_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let response = telegram_error(
            &app,
            TelegramError {
                info: MessageInfo::new("telegram.rate_limited"),
                message: "Telegram rate limit reached. Wait before retrying.".into(),
                retry_after: Some(42),
                unauthorized: false,
            },
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "42");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error"],
            "Telegram rate limit reached. Wait before retrying."
        );
        assert_eq!(
            body["error_info"],
            json!({"code":"telegram.rate_limited","params":{"seconds":42}})
        );
        assert_eq!(
            serde_json::to_value(app.state().await).unwrap()["last_error_info"],
            body["error_info"]
        );

        let error = anyhow::anyhow!("Choose a positive interval in seconds.");
        assert_eq!(MessageInfo::from_error(&error).code, "error.unclassified");
        let response = bad(error);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error_info"],
            json!({"code":"error.unclassified","params":{}})
        );
    }

    #[tokio::test]
    async fn validation_rejections_have_message_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let router = router(App::open(dir.path().into(), None).unwrap());
        let request = Request::builder()
            .method("PUT")
            .uri("/api/settings")
            .header(header::HOST, ADDRESS)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"enabled":false,"mode":"ordered","interval_secs":0}"#,
            ))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["error"].is_string());
        assert_eq!(
            body["error_info"],
            json!({"code":"validation.interval_positive","params":{}})
        );
    }

    fn request(path: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header(header::HOST, ADDRESS)
            .body(Body::empty())
            .unwrap()
    }
    #[tokio::test]
    async fn emoji_search_handles_blank_queries_and_validates_parameters() {
        let dir = tempfile::tempdir().unwrap();
        let router = router(App::open(dir.path().into(), None).unwrap());
        let response = router
            .clone()
            .oneshot(request("/api/emojis/search?q=%20%20&lang=ja-JP%2Cen"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            json!({"choices": [], "next_offset": null})
        );
        for path in [
            "/api/emojis/search?q=cat&offset=-1",
            "/api/emojis/search?q=cat&offset=2147483648",
            "/api/emojis/search?lang=en",
        ] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(request(path))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[test]
    fn media_cache_keys_require_stable_identifiers_and_versions() {
        assert!(immutable_media_path("emojis/9223372036854775806/media"));
        assert!(immutable_media_path("photos/history/42"));
        assert!(!immutable_media_path("emojis/sets/42/cover"));
        assert!(!immutable_media_path("profile/photo"));
        assert!(!immutable_media_path("photos/history/not-an-id"));
        assert!(version_matches(Some("/api/profile/photo?v=42"), Some("42")));
        assert!(!version_matches(
            Some("/api/profile/photo?v=43"),
            Some("42")
        ));
        assert!(!version_matches(None, None));
        assert_eq!(
            versioned_media(vec![1], "image/jpeg", true).headers()[header::CACHE_CONTROL],
            MEDIA_CACHE
        );
        assert!(
            !versioned_media(vec![1], "image/jpeg", false)
                .headers()
                .contains_key(header::CACHE_CONTROL)
        );
    }

    #[tokio::test]
    async fn account_lifecycle_http_contract() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = crate::accounts::Accounts::open(dir.path().into(), None).unwrap();
        let (first, _) = accounts.app(None).await.unwrap();
        std::fs::write(
            dir.path().join("accounts").join(&first).join("identity"),
            "123",
        )
        .unwrap();
        let router = accounts_router(accounts.clone());
        for (method, path, expected) in [
            ("POST", "/api/accounts".to_owned(), StatusCode::NO_CONTENT),
            (
                "PUT",
                format!("/api/accounts/{first}/active"),
                StatusCode::NO_CONTENT,
            ),
            (
                "PUT",
                "/api/accounts/missing/active".to_owned(),
                StatusCode::NOT_FOUND,
            ),
            (
                "DELETE",
                "/api/accounts/missing".to_owned(),
                StatusCode::NOT_FOUND,
            ),
            (
                "DELETE",
                format!("/api/accounts/{first}"),
                StatusCode::NO_CONTENT,
            ),
        ] {
            let req = Request::builder()
                .method(method)
                .uri(path)
                .header(header::HOST, ADDRESS)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                expected
            );
        }
        assert!(accounts.app(Some(&first)).await.is_none());
        assert_eq!(
            accounts.state().await["accounts"].as_array().unwrap().len(),
            1
        );
    }
    #[tokio::test]
    async fn logout_respects_and_reports_the_accounts_persisted_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = crate::accounts::Accounts::open(dir.path().into(), None).unwrap();
        let (id, app) = accounts.app(None).await.unwrap();
        app.record_telegram_error(&TelegramError {
            info: crate::messages::MessageInfo::new("error.unclassified"),
            message: "Flood wait".into(),
            retry_after: Some(3600),
            unauthorized: false,
        })
        .await;
        let router = accounts_router(accounts.clone());
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/accounts/{id}"))
            .header(header::HOST, ADDRESS)
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().contains_key(header::RETRY_AFTER));
        assert!(accounts.app(Some(&id)).await.is_some());
        drop(app);
        drop(accounts);
        tokio::task::yield_now().await;
        let restored = crate::accounts::Accounts::open(dir.path().into(), None).unwrap();
        let (_, app) = restored.app(Some(&id)).await.unwrap();
        assert!(matches!(app.connection().await, Err(error) if error.retry_after.is_some()));
    }

    #[tokio::test]
    async fn scoped_requests_use_explicit_account_and_scope_media() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = crate::accounts::Accounts::open(dir.path().into(), None).unwrap();
        let (first, app) = accounts.app(None).await.unwrap();
        app.repository
            .lock()
            .await
            .add_upload("Portrait", b"jpeg", b"jpeg", None, true)
            .unwrap();
        let photo_id = app.state().await.library.photos[0].id.clone();
        app.repository
            .lock()
            .await
            .update(|library| {
                library.selected_emojis.push(crate::telegram::EmojiChoice {
                    document_id: None,
                    id: "1".into(),
                    label: "Star".into(),
                    source: "Test".into(),
                    source_kind: None,
                    thumbnail_url: Some("/api/emojis/1/thumbnail".into()),
                    text_color: false,
                });
                Ok(())
            })
            .unwrap();
        std::fs::write(
            dir.path().join("accounts").join(&first).join("identity"),
            "123",
        )
        .unwrap();
        accounts.create().await.unwrap();
        let (second, _) = accounts.app(None).await.unwrap();
        let router = accounts_router(accounts.clone());
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/api/accounts/{first}/settings"))
            .header(header::HOST, ADDRESS)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"enabled":false,"mode":"ordered","interval_secs":123}"#,
            ))
            .unwrap();
        assert_eq!(
            router.clone().oneshot(req).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(app.state().await.library.settings.interval_secs, 123);
        let state = accounts.state().await;
        assert_eq!(state["active_account_id"], second);
        assert_eq!(state["settings"]["interval_secs"], 3600);
        for (id, expected) in [(&first, StatusCode::OK), (&second, StatusCode::NOT_FOUND)] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(request(&format!("/api/accounts/{id}/photos/{photo_id}")))
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
        let response = router
            .clone()
            .oneshot(request(&format!("/api/accounts/{first}/photos/{photo_id}")))
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let response = router
            .clone()
            .oneshot(request(&format!("/api/photos/{photo_id}")))
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let response = router
            .clone()
            .oneshot(request(&format!("/api/accounts/{first}/emojis/123/media")))
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            router
                .clone()
                .oneshot(request("/api/accounts/missing/photos/x"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        accounts.activate(&first).await.unwrap();
        let response = router.clone().oneshot(request("/api/state")).await.unwrap();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let state: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            state["selected_emojis"][0]["thumbnail_url"],
            format!("/api/accounts/{first}/emojis/1/thumbnail")
        );
        assert_eq!(state["accounts"].as_array().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn serves_real_embedded_ui_and_unconfigured_api() {
        let dir = tempfile::tempdir().unwrap();
        let router = router(App::open(dir.path().into(), None).unwrap());
        let response = router.clone().oneshot(request("/")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response
                .headers()
                .contains_key(header::CONTENT_SECURITY_POLICY)
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(std::str::from_utf8(&body).unwrap().contains("Celine"));
        let response = router.oneshot(request("/api/state")).await.unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let state: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(state["auth"]["status"], "unconfigured");
        assert_eq!(state["settings"]["enabled"], false);
        assert!(state["settings"]["jitter_secs"].is_null());
        assert_eq!(state["emoji_settings"]["enabled"], false);
        assert!(state["emoji_settings"]["jitter_secs"].is_null());
        assert!(state["profile"].is_null());
    }
    #[tokio::test]
    async fn rejects_cross_origin_and_dns_rebinding() {
        let dir = tempfile::tempdir().unwrap();
        let router = router(App::open(dir.path().into(), None).unwrap());
        for (host, origin) in [
            ("evil.test:7766", "http://evil.test:7766"),
            (ADDRESS, "https://evil.test"),
            (ADDRESS, "null"),
        ] {
            let req = Request::builder()
                .uri("/api/state")
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        let req = Request::builder()
            .method("POST")
            .uri("/api/auth/qr")
            .header(header::HOST, ADDRESS)
            .header(header::ORIGIN, format!("http://{ADDRESS}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router.oneshot(req).await.unwrap().status(),
            StatusCode::BAD_GATEWAY
        );
    }
    #[tokio::test]
    async fn local_photo_url_keeps_its_bytes_after_linking_to_telegram() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = crate::accounts::Accounts::open(dir.path().into(), None).unwrap();
        let (account_id, app) = accounts.app(None).await.unwrap();
        app.repository
            .lock()
            .await
            .add_upload("Portrait", b"local jpeg", b"local jpeg", None, true)
            .unwrap();
        let photo_id = app.state().await.library.photos[0].id.clone();
        let router = accounts_router(accounts);
        let path = format!("/api/accounts/{account_id}/photos/{photo_id}");
        for telegram_id in [None, Some("42")] {
            if let Some(id) = telegram_id {
                app.repository
                    .lock()
                    .await
                    .link_telegram_photo(&photo_id, id.into())
                    .unwrap();
            }
            let response = router.clone().oneshot(request(&path)).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .as_ref(),
                b"local jpeg"
            );
        }
        app.repository
            .lock()
            .await
            .add_history_photo("43".into())
            .unwrap();
        let history_id = app.state().await.library.photos[1].id.clone();
        let response = router
            .oneshot(request(&format!(
                "/api/accounts/{account_id}/photos/{history_id}"
            )))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn crop_routes_preserve_original_and_change_preview() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = crate::accounts::Accounts::open(dir.path().into(), None).unwrap();
        let (account, app) = accounts.app(None).await.unwrap();
        let mut original = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(300, 200, |x, _| {
            if x < 150 {
                image::Rgb([240, 0, 0])
            } else {
                image::Rgb([0, 0, 240])
            }
        }))
        .write_to(&mut original, image::ImageFormat::Png)
        .unwrap();
        let original = original.into_inner();
        let jpeg = normalize_photo(&original).unwrap();
        app.repository
            .lock()
            .await
            .add_upload("test", &original, &jpeg, Some("42".into()), true)
            .unwrap();
        let id = app.state().await.library.photos[0].id.clone();
        let path = format!("/api/accounts/{account}/photos/{id}");
        let router = accounts_router(accounts);
        for (suffix, expected) in [
            ("?crop=null", MEDIA_CACHE),
            ("?crop=invalid", "no-store"),
            ("", "no-store"),
        ] {
            let response = router
                .clone()
                .oneshot(request(&format!("{path}{suffix}")))
                .await
                .unwrap();
            assert_eq!(response.headers()[header::CACHE_CONTROL], expected);
        }
        let response = router
            .clone()
            .oneshot(request(&format!("/api/photos/{id}?crop=null")))
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let response = router
            .clone()
            .oneshot(request(&format!("{path}/original")))
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .as_ref(),
            original
        );
        let crop = |body: &str| {
            Request::builder()
                .method("PUT")
                .uri(format!("{path}/crop"))
                .header(header::HOST, ADDRESS)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_owned()))
                .unwrap()
        };
        assert_eq!(
            router
                .clone()
                .oneshot(crop(r#"{"crop":null}"#))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            app.state().await.library.photos[0].telegram_id.as_deref(),
            Some("42")
        );
        assert_eq!(
            router
                .clone()
                .oneshot(crop(r#"{"crop":{"x":0,"y":0,"size":0.5}}"#))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert!(app.state().await.library.photos[0].telegram_id.is_none());
        let stale = router
            .clone()
            .oneshot(request(&format!("{path}?crop=null")))
            .await
            .unwrap();
        assert_eq!(stale.headers()[header::CACHE_CONTROL], "no-store");
        let current = router
            .clone()
            .oneshot(request(&format!(
                "{path}?crop=%7B%22x%22%3A0%2C%22y%22%3A0%2C%22size%22%3A0.5%7D"
            )))
            .await
            .unwrap();
        assert_eq!(current.headers()[header::CACHE_CONTROL], MEDIA_CACHE);
        let response = router.clone().oneshot(request(&path)).await.unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert!(image.get_pixel(320, 320)[0] > 200);
        assert_eq!(
            router
                .oneshot(crop(r#"{"crop":{"x":0.9,"y":0,"size":1}}"#))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn local_photo_uploads_work_during_cooldown_and_selection_removal_persists() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        app.record_telegram_error(&TelegramError {
            info: MessageInfo::new("telegram.cooldown"),
            message: "Flood wait".into(),
            retry_after: Some(3600),
            unauthorized: false,
        })
        .await;
        let router = router(app.clone());
        for value in 0..12 {
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                180,
                180,
                image::Rgb([value, 0, 0]),
            ))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
            let mut multipart = b"--celine-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"portrait.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
            multipart.extend_from_slice(png.get_ref());
            multipart.extend_from_slice(b"\r\n--celine-test--\r\n");
            let req = Request::builder()
                .method("POST")
                .uri("/api/photos")
                .header(header::HOST, ADDRESS)
                .header(
                    header::CONTENT_TYPE,
                    "multipart/form-data; boundary=celine-test",
                )
                .body(Body::from(multipart))
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::NO_CONTENT
            );
        }
        let state = app.state().await;
        assert_eq!(state.library.photos.len(), 12);
        assert!(
            state
                .library
                .photos
                .iter()
                .all(|photo| !photo.history_checked)
        );
        let id = app.state().await.library.photos[0].id.clone();
        assert_eq!(
            router
                .clone()
                .oneshot(request(&format!("/api/photos/{id}")))
                .await
                .unwrap()
                .headers()[header::CONTENT_TYPE],
            "image/jpeg"
        );
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/photos/{id}"))
            .header(header::HOST, ADDRESS)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router.clone().oneshot(req).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        drop(router);
        drop(app);
        let restored = App::open(dir.path().into(), None).unwrap();
        assert_eq!(restored.state().await.library.photos.len(), 11);
    }
    #[tokio::test]
    async fn reupload_endpoint_rejects_without_ready_history() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let response = router(app)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/photos/missing/reupload")
                    .header(header::HOST, ADDRESS)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error_info"]["code"], "photo.history_not_ready");
    }

    #[tokio::test]
    async fn cached_history_can_be_browsed_selected_and_edited_during_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let jpeg = include_bytes!("../web/public/logo.jpg");
        {
            let mut cache = app.photo_cache.lock().await;
            cache.set_history(vec!["42".into()]).unwrap();
            cache.store("42", jpeg).unwrap();
        }
        app.record_telegram_error(&TelegramError {
            info: MessageInfo::new("telegram.cooldown"),
            message: "Flood wait".into(),
            retry_after: Some(3600),
            unauthorized: false,
        })
        .await;
        let router = router(app.clone());
        for path in ["/api/photos/history", "/api/photos/history/42"] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(request(path))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        let selection = Request::builder()
            .method("POST")
            .uri("/api/photos/history")
            .header(header::HOST, ADDRESS)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"id":"42"}"#))
            .unwrap();
        assert_eq!(
            router.clone().oneshot(selection).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        let id = app.state().await.library.photos[0].id.clone();
        for path in [
            format!("/api/photos/{id}"),
            format!("/api/photos/{id}/original"),
        ] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(request(&path))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        app.photo_cache.lock().await.set_history(vec![]).unwrap();
        let stale_selection = Request::builder()
            .method("POST")
            .uri("/api/photos/history")
            .header(header::HOST, ADDRESS)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"id":"42"}"#))
            .unwrap();
        assert_eq!(
            router
                .clone()
                .oneshot(stale_selection)
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            router
                .oneshot(request(&format!("/api/photos/{id}/original")))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    #[tokio::test]
    async fn manual_telegram_paths_honor_persisted_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        app.record_telegram_error(&TelegramError {
            info: crate::messages::MessageInfo::new("error.unclassified"),
            message: "Flood wait".into(),
            retry_after: Some(3600),
            unauthorized: false,
        })
        .await;
        let router = router(app);
        for path in [
            "/api/emojis",
            "/api/emojis/sets/1",
            "/api/emojis/sets/1/cover",
            "/api/emojis/1/thumbnail",
            "/api/emojis/1/media",
            "/api/profile/photo",
        ] {
            let response = router.clone().oneshot(request(path)).await.unwrap();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert!(response.headers().contains_key(header::RETRY_AFTER));
        }
        for (path, body) in [("/api/auth/qr", "")] {
            let req = Request::builder()
                .method("POST")
                .uri(path)
                .header(header::HOST, ADDRESS)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::TOO_MANY_REQUESTS
            );
        }
    }
    #[tokio::test]
    async fn independent_photo_and_emoji_settings_and_empty_selection() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        app.auth.write().await.status = "authorized".into();
        app.auth.write().await.premium = true;
        app.repository
            .lock()
            .await
            .add_upload("Portrait", b"jpeg", b"jpeg", None, true)
            .unwrap();
        let choice = crate::telegram::EmojiChoice {
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
        let router = router(app.clone());
        for (path, interval) in [("/api/settings", 10), ("/api/emojis/settings", 60)] {
            let req = Request::builder().method("PUT").uri(path).header(header::HOST, ADDRESS)
                .header(header::CONTENT_TYPE,"application/json")
                .body(Body::from(json!({"enabled":true,"mode":"ordered","interval_secs":interval,"jitter_secs":0}).to_string())).unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::NO_CONTENT
            );
        }
        for path in ["/api/settings/start", "/api/emojis/settings/start"] {
            let req = Request::builder()
                .method("POST")
                .uri(path)
                .header(header::HOST, ADDRESS)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::NO_CONTENT
            );
        }
        let state = app.state().await;
        assert_eq!(state.library.settings.interval_secs, 10);
        assert_eq!(state.library.emoji_settings.interval_secs, 60);
        assert!(
            state.library.next_emoji_rotation_at.unwrap() > state.library.next_rotation_at.unwrap()
        );
        let req = Request::builder()
            .method("PUT")
            .uri("/api/emojis")
            .header(header::HOST, ADDRESS)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"ids":[]}"#))
            .unwrap();
        assert_eq!(
            router.oneshot(req).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        let state = app.state().await;
        assert!(state.library.settings.enabled);
        assert!(!state.library.emoji_settings.enabled);
        assert!(state.library.next_emoji_rotation_at.is_none());
    }
    #[tokio::test]
    async fn autosave_and_explicit_actions_expose_saved_and_applied_state() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        app.auth.write().await.status = "authorized".into();
        app.repository
            .lock()
            .await
            .add_history_photo("42".into())
            .unwrap();
        let router = router(app);
        let save = |interval| {
            Request::builder().method("PUT").uri("/api/settings")
            .header(header::HOST, ADDRESS).header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({"enabled":false,"mode":"random","interval_secs":interval,"jitter_secs":0}).to_string())).unwrap()
        };
        let action = |name| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/settings/{name}"))
                .header(header::HOST, ADDRESS)
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            router.clone().oneshot(save(30)).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            router
                .clone()
                .oneshot(action("start"))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            router.clone().oneshot(save(60)).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        let response = router.clone().oneshot(request("/api/state")).await.unwrap();
        let state: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(state["settings"]["enabled"], true);
        assert_eq!(state["settings"]["interval_secs"], 60);
        assert_eq!(state["applied_settings"]["interval_secs"], 30);
        assert_eq!(
            router
                .clone()
                .oneshot(action("apply"))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let response = router.clone().oneshot(request("/api/state")).await.unwrap();
        let state: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(state["applied_settings"]["interval_secs"], 60);
        assert_eq!(
            router
                .clone()
                .oneshot(action("stop"))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let response = router.oneshot(request("/api/state")).await.unwrap();
        let state: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(state["applied_settings"].is_null());
        assert_eq!(state["settings"]["enabled"], false);
    }
    #[tokio::test]
    async fn automatic_and_custom_jitter_round_trip_for_both_schedules() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().into(), None).unwrap();
        let router = router(app.clone());
        for (path, body) in [
            (
                "/api/settings",
                json!({"enabled":false,"mode":"ordered","interval_secs":600}),
            ),
            (
                "/api/emojis/settings",
                json!({"enabled":false,"mode":"random","interval_secs":600,"jitter_secs":0}),
            ),
        ] {
            let req = Request::builder()
                .method("PUT")
                .uri(path)
                .header(header::HOST, ADDRESS)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::NO_CONTENT
            );
        }
        let response = router.clone().oneshot(request("/api/state")).await.unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let state: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(state["settings"]["jitter_secs"].is_null());
        assert_eq!(state["emoji_settings"]["jitter_secs"], 0);

        for (path, jitter) in [
            ("/api/settings", json!(120)),
            ("/api/emojis/settings", json!(null)),
        ] {
            let req = Request::builder()
                .method("PUT")
                .uri(path)
                .header(header::HOST, ADDRESS)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({"enabled":false,"mode":"ordered","interval_secs":600,"jitter_secs":jitter}).to_string()))
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::NO_CONTENT
            );
        }
        drop(router);
        drop(app);
        let restored = App::open(dir.path().into(), None).unwrap();
        let state = restored.state().await;
        assert_eq!(state.library.settings.jitter_secs, Some(120));
        assert_eq!(state.library.emoji_settings.jitter_secs, None);
    }
    #[tokio::test]
    async fn settings_interval_boundaries_and_invalid_photo_ids() {
        let dir = tempfile::tempdir().unwrap();
        let router = router(App::open(dir.path().into(), None).unwrap());
        let req = Request::builder()
            .method("PUT")
            .uri("/api/settings")
            .header(header::HOST, ADDRESS)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"enabled":false,"mode":"ordered","interval_secs":0,"jitter_secs":0}"#,
            ))
            .unwrap();
        assert_eq!(
            router.clone().oneshot(req).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        for (interval_secs, jitter_secs, expected) in [
            (1_u64, 0_u64, StatusCode::NO_CONTENT),
            (600, 599, StatusCode::NO_CONTENT),
            (u64::MAX, u64::MAX - 1, StatusCode::NO_CONTENT),
            (1, 1, StatusCode::BAD_REQUEST),
            (600, 601, StatusCode::BAD_REQUEST),
        ] {
            let body = json!({"enabled":false,"mode":"ordered","interval_secs":interval_secs,"jitter_secs":jitter_secs});
            let req = Request::builder()
                .method("PUT")
                .uri("/api/settings")
                .header(header::HOST, ADDRESS)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                expected
            );
        }
        assert_eq!(
            router
                .oneshot(request("/api/photos/not-a-file"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
