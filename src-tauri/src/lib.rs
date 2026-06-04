mod audio;

use audio::AudioEngine;
use parking_lot::Mutex;
use std::sync::Arc;
use std::path::Path;
use tauri::{Manager, State};

pub struct AppAudio(pub Arc<Mutex<AudioEngine>>);

// macOS CoreAudio의 OutputStream은 Send/Sync를 구현하지 않지만,
// 실제로는 Mutex로 보호되어 안전하게 사용 가능.
unsafe impl Send for AppAudio {}
unsafe impl Sync for AppAudio {}

// ── 재생 제어 ──────────────────────────────────
#[tauri::command]
fn audio_play(path: String, state: State<AppAudio>) -> Result<f64, String> {
    state.inner().0.lock().play(&path)
}

#[tauri::command]
fn audio_pause(state: State<AppAudio>) {
    state.inner().0.lock().pause();
}

#[tauri::command]
fn audio_resume(state: State<AppAudio>) {
    state.inner().0.lock().resume();
}

#[tauri::command]
fn audio_stop(state: State<AppAudio>) {
    state.inner().0.lock().stop();
}

#[tauri::command]
fn audio_get_position(state: State<AppAudio>) -> f64 {
    state.inner().0.lock().get_position()
}

#[tauri::command]
fn audio_seek(seconds: f64, state: State<AppAudio>) -> Result<(), String> {
    state.inner().0.lock().seek(seconds)
}

#[tauri::command]
fn audio_is_finished(state: State<AppAudio>) -> bool {
    state.inner().0.lock().is_finished()
}

#[tauri::command]
fn audio_get_duration(state: State<AppAudio>) -> f64 {
    state.inner().0.lock().get_duration()
}

// ── 볼륨 (dB 기반 고음질) ──────────────────────
/// 슬라이더 0~100 → 내부에서 dB 변환 후 지수 스무딩 적용
#[tauri::command]
fn audio_set_volume(volume: f32, state: State<AppAudio>) {
    state.inner().0.lock().set_volume_slider(volume);
}

/// dB 직접 설정 (-60 ~ +6)
#[tauri::command]
fn audio_set_volume_db(db: f64, state: State<AppAudio>) {
    state.inner().0.lock().set_volume_db(db);
}

// ── EQ (Rust IIR 필터) ─────────────────────────
/// 단일 밴드 설정 (band: 0~11, gain_db: -12~+12)
#[tauri::command]
fn audio_set_eq_band(band: usize, gain_db: f64, state: State<AppAudio>) {
    state.inner().0.lock().set_eq_band(band, gain_db);
}

/// 12밴드 전체 한번에 설정
#[tauri::command]
fn audio_set_eq_all(gains: Vec<f64>, state: State<AppAudio>) {
    if gains.len() != 12 { return; }
    let mut arr = [0.0f64; 12];
    arr.copy_from_slice(&gains);
    state.inner().0.lock().set_eq_all(arr);
}

/// EQ 활성화/비활성화
#[tauri::command]
fn audio_set_eq_enabled(enabled: bool, state: State<AppAudio>) {
    state.inner().0.lock().set_eq_enabled(enabled);
}

/// 현재 EQ 게인 12밴드 반환
#[tauri::command]
fn audio_get_eq_gains(state: State<AppAudio>) -> Vec<f64> {
    state.inner().0.lock().get_eq_gains().to_vec()
}

// ── 스펙트럼 / VU ──────────────────────────────
/// 80밴드 스펙트럼 (0.0~1.0) — 비주얼라이저용
#[tauri::command]
fn audio_get_spectrum(state: State<AppAudio>) -> Vec<f32> {
    state.inner().0.lock().get_spectrum()
}

/// VU 미터용 RMS 레벨 [L, R]
#[tauri::command]
fn audio_get_rms(state: State<AppAudio>) -> Vec<f32> {
    let (l, r) = state.inner().0.lock().get_rms();
    vec![l, r]
}

// ── 출력 장치 ──────────────────────────────────
/// 사용 가능한 출력 장치 목록 반환
#[tauri::command]
fn audio_list_devices() -> Vec<audio::AudioDevice> {
    audio::list_output_devices()
}

/// 출력 장치 변경 (device_name: 빈 문자열이면 기본 장치)
#[tauri::command]
fn audio_set_device(device_name: String, state: State<AppAudio>) -> Result<(), String> {
    let result = state.inner().0.lock().set_output_device(&device_name);
    result
}

// ── 파일 정보 ──────────────────────────────────
#[tauri::command]
fn audio_get_file_info(path: String) -> Option<audio::FileInfo> {
    audio::get_file_info(&path)
}

// ── 폴더 스캔 (Rust에서 직접 — JS fs 권한 우회) ──
const SUPPORTED_EXTS: &[&str] = &[
    "mp3","flac","wav","aac","m4a","ogg","opus","wma",
    "aiff","aif","ape","wv","mpc","tta","spx","amr",
    "mp4","webm","mkv","m4b","mp2","ac3","dts","ra",
];

fn scan_dir_recursive(dir: &Path, result: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir_recursive(&path, result);
        } else if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if SUPPORTED_EXTS.contains(&ext_lower.as_str()) {
                if let Some(s) = path.to_str() {
                    result.push(s.to_string());
                }
            }
        }
    }
}

/// 폴더를 재귀 스캔해서 지원 오디오 파일 경로 목록 반환
#[tauri::command]
fn scan_folder(path: String) -> Vec<String> {
    let p = Path::new(&path);
    if p.is_file() {
        // 단일 파일이면 그냥 반환
        let ext = p.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if SUPPORTED_EXTS.contains(&ext.as_str()) {
            return vec![path];
        }
        return vec![];
    }
    let mut result = Vec::new();
    scan_dir_recursive(p, &mut result);
    result.sort();
    result
}

// ── 앱 진입점 ──────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let engine = AudioEngine::new().expect("오디오 엔진 초기화 실패");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppAudio(Arc::new(Mutex::new(engine))))
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_play,
            audio_pause,
            audio_resume,
            audio_stop,
            audio_set_volume,
            audio_set_volume_db,
            audio_get_position,
            audio_seek,
            audio_is_finished,
            audio_get_duration,
            audio_set_eq_band,
            audio_set_eq_all,
            audio_set_eq_enabled,
            audio_get_eq_gains,
            audio_get_spectrum,
            audio_get_rms,
            scan_folder,
            audio_get_file_info,
            audio_list_devices,
            audio_set_device,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
