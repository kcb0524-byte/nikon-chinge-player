/// 니콘 친게 뮤직 플레이어 - 고음질 오디오 엔진
///
/// 설계 원칙:
/// - 모든 DSP는 f64 (64-bit 부동소수점) 으로 처리
/// - EQ: RBJ 오디오 EQ 쿡북 기반 IIR 바이쿼드 필터 직접 구현
///       (Web Audio API BiquadFilter 보다 정밀하고 위상 특성이 예측 가능)
/// - 볼륨: dB 단위 처리 + 지수 스무딩으로 클릭 노이즈 방지
/// - 스펙트럼: FFT 기반 실시간 주파수 분석 (VU 미터 + 비주얼라이저)
use parking_lot::Mutex;
use realfft::RealFftPlanner;
use rodio::{OutputStream, OutputStreamHandle, Sink, Source};
use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;
use std::time::Duration;
use serde::Serialize;

// ─────────────────────────────────────────────
//  파일 포맷 정보
// ─────────────────────────────────────────────
#[derive(Serialize, Clone, Debug)]
pub struct FileInfo {
    pub format: String,       // "FLAC", "MP3", "WAV" 등
    pub sample_rate: u32,     // 44100, 48000, 96000, 192000 등
    pub bit_depth: u32,       // 16, 24, 32 (0 = 손실 압축이라 해당없음)
    pub channels: u16,        // 1=모노, 2=스테레오
    pub bitrate_kbps: u32,    // 320, 1411 등 (0 = 알 수 없음)
    pub is_lossless: bool,
    pub label: String,        // "24bit / 96kHz / FLAC" 같은 표시용 문자열
}

pub fn get_file_info(path: &str) -> Option<FileInfo> {
    use rodio::Decoder;
    let file = File::open(path).ok()?;
    let buf = BufReader::new(file);
    let decoder = Decoder::new(buf).ok()?;

    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();
    let total_dur = decoder.total_duration();

    // 확장자로 포맷 판단
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .unwrap_or_default();

    let is_lossless = matches!(ext.as_str(), "FLAC"|"WAV"|"AIFF"|"AIF"|"APE"|"WV"|"TTA"|"ALAC"|"M4A");

    // 비트뎁스: rodio Decoder는 f32 출력이라 원본 비트뎁스를 직접 못 얻음.
    // symphonia 직접 probe로 얻기
    let (bit_depth, bitrate_kbps) = probe_bit_depth_bitrate(path, total_dur);

    let label = build_label(&ext, sample_rate, bit_depth, bitrate_kbps, is_lossless);

    Some(FileInfo {
        format: ext.to_string(),
        sample_rate,
        bit_depth,
        channels,
        bitrate_kbps,
        is_lossless,
        label,
    })
}

fn probe_bit_depth_bitrate(path: &str, duration: Option<Duration>) -> (u32, u32) {
    use rodio::decoder::DecoderError;
    use std::io::Read;

    // symphonia로 직접 probe
    // rodio가 내부적으로 symphonia를 쓰므로 같은 방식으로 접근
    let file_size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    // 파일 크기 + 재생시간으로 비트레이트 추정
    let bitrate_kbps = if let Some(dur) = duration {
        let secs = dur.as_secs_f64();
        if secs > 0.0 && file_size > 0 {
            ((file_size as f64 * 8.0) / secs / 1000.0) as u32
        } else { 0 }
    } else { 0 };

    // 확장자로 비트뎁스 추정 (symphonia probe 없이 간단히)
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .unwrap_or_default();

    let bit_depth = estimate_bit_depth(path, &ext, bitrate_kbps);

    (bit_depth, bitrate_kbps)
}

fn estimate_bit_depth(path: &str, ext: &str, bitrate_kbps: u32) -> u32 {
    // FLAC/WAV는 파일 헤더에서 비트뎁스를 읽을 수 있음
    match ext {
        "FLAC" => read_flac_bit_depth(path).unwrap_or(16),
        "WAV" | "AIFF" | "AIF" => read_wav_bit_depth(path).unwrap_or(16),
        "MP3" | "AAC" | "OGG" | "OPUS" | "WMA" => 0, // 손실 압축
        _ => 0,
    }
}

fn read_flac_bit_depth(path: &str) -> Option<u32> {
    // FLAC STREAMINFO 레이아웃 (RFC):
    // offset 0-3:  "fLaC" 마커
    // offset 4-7:  메타데이터 블록 헤더
    // offset 8-9:  min_block_size (16bit)
    // offset 10-11: max_block_size (16bit)
    // offset 12-14: min_frame_size (24bit)
    // offset 15-17: max_frame_size (24bit)
    // offset 18-20: sample_rate(20bit) | channels-1(3bit) | bit_depth-1 최상위 1bit
    // offset 21:   bit_depth-1 하위 4bit (상위 4비트) | total_samples 최상위 4bit (하위 4비트)
    //
    // bit_depth-1 = 5비트: byte20의 bit0 (1비트) + byte21의 bit7~4 (4비트)
    let mut f = File::open(path).ok()?;
    let mut buf = [0u8; 22];
    use std::io::Read;
    f.read_exact(&mut buf).ok()?;
    if &buf[0..4] != b"fLaC" { return None; }
    let b20 = buf[20] as u32;
    let b21 = buf[21] as u32;
    // bit_depth - 1: 상위 1비트는 b20의 LSB, 하위 4비트는 b21의 상위 4비트
    let bit_depth_minus1 = ((b20 & 0x01) << 4) | (b21 >> 4);
    Some(bit_depth_minus1 + 1)
}

fn read_wav_bit_depth(path: &str) -> Option<u32> {
    // WAV fmt 청크에서 BitsPerSample 읽기
    let mut f = File::open(path).ok()?;
    let mut buf = [0u8; 44];
    use std::io::Read;
    f.read_exact(&mut buf).ok()?;
    if &buf[0..4] != b"RIFF" { return None; }
    if &buf[8..12] != b"WAVE" { return None; }
    // fmt 청크 offset 12, BitsPerSample at offset 34
    let bits = u16::from_le_bytes([buf[34], buf[35]]);
    Some(bits as u32)
}

fn build_label(ext: &str, sample_rate: u32, bit_depth: u32, bitrate_kbps: u32, is_lossless: bool) -> String {
    let sr = if sample_rate % 1000 == 0 {
        format!("{}kHz", sample_rate / 1000)
    } else {
        format!("{:.1}kHz", sample_rate as f64 / 1000.0)
    };

    if is_lossless {
        if bit_depth > 0 {
            format!("{}bit / {} / {}", bit_depth, sr, ext)
        } else {
            format!("{} / {}", sr, ext)
        }
    } else {
        if bitrate_kbps > 0 {
            format!("{}kbps / {} / {}", bitrate_kbps, sr, ext)
        } else {
            format!("{} / {}", sr, ext)
        }
    }
}

// ─────────────────────────────────────────────
//  RBJ 오디오 EQ 쿡북 기반 IIR 바이쿼드 필터
// ─────────────────────────────────────────────
#[derive(Clone, Debug)]
pub struct BiquadCoeffs {
    pub b0: f64, pub b1: f64, pub b2: f64,
    pub a1: f64, pub a2: f64,
}

impl BiquadCoeffs {
    pub fn identity() -> Self {
        BiquadCoeffs { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 }
    }

    /// 피킹 EQ 필터
    pub fn peaking(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        if gain_db.abs() < 1e-6 { return Self::identity(); }
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let (sin_w0, cos_w0) = (w0.sin(), w0.cos());
        let alpha = sin_w0 / (2.0 * q);
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / a;
        BiquadCoeffs { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 }
    }

    /// 로우 쉘프 필터
    pub fn low_shelf(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        if gain_db.abs() < 1e-6 { return Self::identity(); }
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let (sin_w0, cos_w0) = (w0.sin(), w0.cos());
        let alpha = sin_w0 / 2.0 * ((a + 1.0/a) * (1.0/q - 1.0) + 2.0).sqrt();
        let sqrt_a = a.sqrt();
        let b0 =       a*((a+1.0) - (a-1.0)*cos_w0 + 2.0*sqrt_a*alpha);
        let b1 =   2.0*a*((a-1.0) - (a+1.0)*cos_w0);
        let b2 =       a*((a+1.0) - (a-1.0)*cos_w0 - 2.0*sqrt_a*alpha);
        let a0 =         (a+1.0) + (a-1.0)*cos_w0 + 2.0*sqrt_a*alpha;
        let a1 =  -2.0*( (a-1.0) + (a+1.0)*cos_w0);
        let a2 =         (a+1.0) + (a-1.0)*cos_w0 - 2.0*sqrt_a*alpha;
        BiquadCoeffs { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 }
    }

    /// 하이 쉘프 필터
    pub fn high_shelf(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        if gain_db.abs() < 1e-6 { return Self::identity(); }
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let (sin_w0, cos_w0) = (w0.sin(), w0.cos());
        let alpha = sin_w0 / 2.0 * ((a + 1.0/a) * (1.0/q - 1.0) + 2.0).sqrt();
        let sqrt_a = a.sqrt();
        let b0 =       a*((a+1.0) + (a-1.0)*cos_w0 + 2.0*sqrt_a*alpha);
        let b1 = -2.0*a*((a-1.0) + (a+1.0)*cos_w0);
        let b2 =       a*((a+1.0) + (a-1.0)*cos_w0 - 2.0*sqrt_a*alpha);
        let a0 =         (a+1.0) - (a-1.0)*cos_w0 + 2.0*sqrt_a*alpha;
        let a1 =   2.0*( (a-1.0) - (a+1.0)*cos_w0);
        let a2 =         (a+1.0) - (a-1.0)*cos_w0 - 2.0*sqrt_a*alpha;
        BiquadCoeffs { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 }
    }
}

/// Direct Form II Transposed — 수치 안정성 우수
#[derive(Clone, Debug)]
pub struct BiquadState {
    pub coeffs: BiquadCoeffs,
    s1: f64,
    s2: f64,
}

impl BiquadState {
    pub fn new(coeffs: BiquadCoeffs) -> Self {
        BiquadState { coeffs, s1: 0.0, s2: 0.0 }
    }

    #[inline(always)]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.coeffs.b0 * x + self.s1;
        self.s1 = self.coeffs.b1 * x - self.coeffs.a1 * y + self.s2;
        self.s2 = self.coeffs.b2 * x - self.coeffs.a2 * y;
        y
    }

    pub fn update_coeffs(&mut self, coeffs: BiquadCoeffs) {
        self.coeffs = coeffs;
        // 상태(s1, s2)는 유지 → 클릭 노이즈 방지
    }

    pub fn reset(&mut self) { self.s1 = 0.0; self.s2 = 0.0; }
}

// ─────────────────────────────────────────────
//  EQ 밴드 정의 (12밴드)
// ─────────────────────────────────────────────
#[derive(Clone, Debug)]
pub enum FilterType { LowShelf, Peaking, HighShelf }

pub struct EqBandDef {
    pub freq: f64,
    pub q: f64,
    pub filter_type: FilterType,
}

pub const NUM_EQ_BANDS: usize = 12;

pub fn eq_band_defs() -> [EqBandDef; NUM_EQ_BANDS] {
    [
        EqBandDef { freq: 32.0,    q: 0.7, filter_type: FilterType::LowShelf  },
        EqBandDef { freq: 64.0,    q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 125.0,   q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 250.0,   q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 500.0,   q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 1000.0,  q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 2000.0,  q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 4000.0,  q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 8000.0,  q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 12000.0, q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 16000.0, q: 1.0, filter_type: FilterType::Peaking   },
        EqBandDef { freq: 20000.0, q: 0.7, filter_type: FilterType::HighShelf },
    ]
}

// ─────────────────────────────────────────────
//  EQ 프로세서 (좌/우 채널 독립 처리)
// ─────────────────────────────────────────────
pub struct EqProcessor {
    filters_l: Vec<BiquadState>,
    filters_r: Vec<BiquadState>,
    gains_db: [f64; NUM_EQ_BANDS],
    enabled: bool,
    sample_rate: f64,
}

impl EqProcessor {
    pub fn new(sample_rate: f64) -> Self {
        let identity = BiquadState::new(BiquadCoeffs::identity());
        EqProcessor {
            filters_l: vec![identity.clone(); NUM_EQ_BANDS],
            filters_r: vec![identity.clone(); NUM_EQ_BANDS],
            gains_db: [0.0f64; NUM_EQ_BANDS],
            enabled: false,
            sample_rate,
        }
    }

    pub fn set_band(&mut self, band: usize, gain_db: f64) {
        if band >= NUM_EQ_BANDS { return; }
        self.gains_db[band] = gain_db;
        let defs = eq_band_defs();
        let def = &defs[band];
        let coeffs = match def.filter_type {
            FilterType::LowShelf  => BiquadCoeffs::low_shelf(def.freq, gain_db, def.q, self.sample_rate),
            FilterType::Peaking   => BiquadCoeffs::peaking(def.freq, gain_db, def.q, self.sample_rate),
            FilterType::HighShelf => BiquadCoeffs::high_shelf(def.freq, gain_db, def.q, self.sample_rate),
        };
        self.filters_l[band].update_coeffs(coeffs.clone());
        self.filters_r[band].update_coeffs(coeffs);
    }

    pub fn set_enabled(&mut self, enabled: bool) { self.enabled = enabled; }

    pub fn update_sample_rate(&mut self, sample_rate: f64) {
        if (self.sample_rate - sample_rate).abs() < 1.0 { return; }
        self.sample_rate = sample_rate;
        let gains = self.gains_db;
        for i in 0..NUM_EQ_BANDS { self.set_band(i, gains[i]); }
        for f in &mut self.filters_l { f.reset(); }
        for f in &mut self.filters_r { f.reset(); }
    }

    #[inline(always)]
    pub fn process(&mut self, l: f64, r: f64) -> (f64, f64) {
        if !self.enabled { return (l, r); }
        let mut sl = l;
        let mut sr = r;
        for i in 0..NUM_EQ_BANDS {
            sl = self.filters_l[i].process(sl);
            sr = self.filters_r[i].process(sr);
        }
        (sl, sr)
    }

    pub fn get_gains(&self) -> [f64; NUM_EQ_BANDS] { self.gains_db }
}

// ─────────────────────────────────────────────
//  볼륨 프로세서 (dB 단위, 지수 스무딩)
// ─────────────────────────────────────────────
pub struct VolumeProcessor {
    target_linear: f64,
    current_linear: f64,
    smooth_coeff: f64,
}

impl VolumeProcessor {
    pub fn new() -> Self {
        VolumeProcessor {
            target_linear: 1.0,
            current_linear: 1.0,
            smooth_coeff: 0.9995,
        }
    }

    /// dB 값으로 볼륨 설정 (-60 ~ +6 dB)
    pub fn set_volume_db(&mut self, db: f64) {
        let clamped = db.max(-60.0).min(6.0);
        self.target_linear = if clamped <= -60.0 {
            0.0
        } else {
            10f64.powf(clamped / 20.0)
        };
    }

    /// 슬라이더 0~100 → dB 변환 (심리음향학적 로그 스케일)
    /// 슬라이더 100 = 0dB, 슬라이더 50 ≈ -12dB, 슬라이더 0 = -60dB
    pub fn slider_to_db(slider: f64) -> f64 {
        if slider <= 0.0 { return -60.0; }
        let normalized = slider / 100.0;
        -60.0 * (1.0 - normalized).powi(2)
    }

    #[inline(always)]
    pub fn process(&mut self, sample: f64) -> f64 {
        self.current_linear = self.current_linear * self.smooth_coeff
            + self.target_linear * (1.0 - self.smooth_coeff);
        sample * self.current_linear
    }
}

// ─────────────────────────────────────────────
//  스펙트럼 분석기 (실시간 FFT + VU 미터)
// ─────────────────────────────────────────────
const SPECTRUM_SIZE: usize = 2048;
const SPECTRUM_BANDS: usize = 80;

pub struct SpectrumAnalyzer {
    buffer_l: Vec<f32>,
    buffer_r: Vec<f32>,
    write_pos: usize,
    planner: RealFftPlanner<f32>,
}

impl SpectrumAnalyzer {
    pub fn new() -> Self {
        SpectrumAnalyzer {
            buffer_l: vec![0.0f32; SPECTRUM_SIZE],
            buffer_r: vec![0.0f32; SPECTRUM_SIZE],
            write_pos: 0,
            planner: RealFftPlanner::new(),
        }
    }

    pub fn push(&mut self, l: f32, r: f32) {
        self.buffer_l[self.write_pos] = l;
        self.buffer_r[self.write_pos] = r;
        self.write_pos = (self.write_pos + 1) % SPECTRUM_SIZE;
    }

    /// 80밴드 스펙트럼 (0.0~1.0)
    pub fn get_spectrum(&mut self) -> Vec<f32> {
        let fft = self.planner.plan_fft_forward(SPECTRUM_SIZE);
        let pos = self.write_pos;

        let mut input_l: Vec<f32> = {
            let mut v = Vec::with_capacity(SPECTRUM_SIZE);
            v.extend_from_slice(&self.buffer_l[pos..]);
            v.extend_from_slice(&self.buffer_l[..pos]);
            v
        };
        let mut input_r: Vec<f32> = {
            let mut v = Vec::with_capacity(SPECTRUM_SIZE);
            v.extend_from_slice(&self.buffer_r[pos..]);
            v.extend_from_slice(&self.buffer_r[..pos]);
            v
        };

        // Hann 윈도우 (스펙트럼 누출 방지)
        let n = SPECTRUM_SIZE as f32;
        for (i, (sl, sr)) in input_l.iter_mut().zip(input_r.iter_mut()).enumerate() {
            let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n - 1.0)).cos());
            *sl *= w;
            *sr *= w;
        }

        let mut out_l = fft.make_output_vec();
        let mut out_r = fft.make_output_vec();
        let _ = fft.process(&mut input_l, &mut out_l);
        let _ = fft.process(&mut input_r, &mut out_r);

        let bin_count = out_l.len();
        let mut result = vec![0.0f32; SPECTRUM_BANDS];
        for i in 0..SPECTRUM_BANDS {
            let start = ((i as f32 / SPECTRUM_BANDS as f32) * (bin_count as f32 * 0.7)) as usize;
            let end = (((i + 1) as f32 / SPECTRUM_BANDS as f32) * (bin_count as f32 * 0.7)) as usize;
            let end = end.max(start + 1).min(bin_count);
            let count = (end - start) as f32;
            let mut sum = 0.0f32;
            for j in start..end {
                let mag_l = (out_l[j].re * out_l[j].re + out_l[j].im * out_l[j].im).sqrt();
                let mag_r = (out_r[j].re * out_r[j].re + out_r[j].im * out_r[j].im).sqrt();
                sum += (mag_l + mag_r) / 2.0;
            }
            let avg = sum / count;
            let db = if avg > 1e-10 { 20.0 * avg.log10() } else { -80.0 };
            result[i] = ((db + 80.0) / 80.0).max(0.0).min(1.0);
        }
        result
    }

    /// RMS 레벨 (VU 미터용) → (L, R)
    pub fn get_rms(&self) -> (f32, f32) {
        let window = 512usize;
        let pos = self.write_pos;
        let start = (pos + SPECTRUM_SIZE - window) % SPECTRUM_SIZE;
        let (mut sum_l, mut sum_r) = (0.0f32, 0.0f32);
        for i in 0..window {
            let idx = (start + i) % SPECTRUM_SIZE;
            sum_l += self.buffer_l[idx] * self.buffer_l[idx];
            sum_r += self.buffer_r[idx] * self.buffer_r[idx];
        }
        ((sum_l / window as f32).sqrt(), (sum_r / window as f32).sqrt())
    }
}

// ─────────────────────────────────────────────
//  고음질 소스 래퍼 (DSP 체인 적용)
// ─────────────────────────────────────────────
pub struct HifiSource<S: Source<Item = f32>> {
    inner: S,
    eq: Arc<Mutex<EqProcessor>>,
    volume: Arc<Mutex<VolumeProcessor>>,
    spectrum: Arc<Mutex<SpectrumAnalyzer>>,
    channels: u16,
    // 스테레오 L 샘플 임시 저장
    pending_r: Option<f32>,
}

impl<S: Source<Item = f32>> HifiSource<S> {
    pub fn new(
        inner: S,
        eq: Arc<Mutex<EqProcessor>>,
        volume: Arc<Mutex<VolumeProcessor>>,
        spectrum: Arc<Mutex<SpectrumAnalyzer>>,
    ) -> Self {
        let channels = inner.channels();
        let sr = inner.sample_rate() as f64;
        eq.lock().update_sample_rate(sr);
        HifiSource { inner, eq, volume, spectrum, channels, pending_r: None }
    }
}

impl<S: Source<Item = f32>> Iterator for HifiSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.channels >= 2 {
            if let Some(r_processed) = self.pending_r.take() {
                // 이전에 계산된 R 샘플 반환
                return Some(r_processed);
            }
            // L 샘플 읽기
            let l_raw = self.inner.next()? as f64;
            let r_raw = self.inner.next().unwrap_or(0.0) as f64;

            let (eq_l, eq_r) = self.eq.lock().process(l_raw, r_raw);
            let vol_l = self.volume.lock().process(eq_l) as f32;
            let vol_r = {
                let mut vol = self.volume.lock();
                vol.process(eq_r) as f32
            };
            self.spectrum.lock().push(eq_l as f32, eq_r as f32);
            self.pending_r = Some(vol_r);
            Some(vol_l)
        } else {
            let s = self.inner.next()? as f64;
            let (eq_s, _) = self.eq.lock().process(s, s);
            let out = self.volume.lock().process(eq_s) as f32;
            self.spectrum.lock().push(s as f32, s as f32);
            Some(out)
        }
    }
}

impl<S: Source<Item = f32>> Source for HifiSource<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.inner.channels() }
    fn sample_rate(&self) -> u32 { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
}

// ─────────────────────────────────────────────
//  메인 오디오 엔진
// ─────────────────────────────────────────────
pub struct AudioEngine {
    sink: Arc<Mutex<Option<Sink>>>,
    _stream: OutputStream,
    stream_handle: OutputStreamHandle,
    current_path: Arc<Mutex<Option<String>>>,
    duration: Arc<Mutex<Option<f64>>>,

    pub eq: Arc<Mutex<EqProcessor>>,
    pub volume: Arc<Mutex<VolumeProcessor>>,
    pub spectrum: Arc<Mutex<SpectrumAnalyzer>>,
}

// macOS CoreAudio OutputStream은 *mut () 때문에 Send/Sync 미구현.
// Mutex로 보호되어 실제로는 안전하므로 unsafe impl로 허용.
unsafe impl Send for AudioEngine {}
unsafe impl Sync for AudioEngine {}

impl AudioEngine {
    pub fn new() -> Result<Self, String> {
        let (stream, stream_handle) = OutputStream::try_default()
            .map_err(|e| e.to_string())?;
        Ok(AudioEngine {
            sink: Arc::new(Mutex::new(None)),
            _stream: stream,
            stream_handle,
            current_path: Arc::new(Mutex::new(None)),
            duration: Arc::new(Mutex::new(None)),
            eq: Arc::new(Mutex::new(EqProcessor::new(44100.0))),
            volume: Arc::new(Mutex::new(VolumeProcessor::new())),
            spectrum: Arc::new(Mutex::new(SpectrumAnalyzer::new())),
        })
    }

    pub fn play(&self, path: &str) -> Result<f64, String> {
        if let Some(sink) = self.sink.lock().take() { sink.stop(); }

        let file = File::open(path).map_err(|e| format!("파일 열기 실패: {}", e))?;
        let buf = BufReader::new(file);
        let decoder = rodio::Decoder::new(buf)
            .map_err(|e| format!("디코딩 실패: {}", e))?
            .convert_samples::<f32>();

        let total_duration = decoder.total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);

        let hifi = HifiSource::new(
            decoder,
            Arc::clone(&self.eq),
            Arc::clone(&self.volume),
            Arc::clone(&self.spectrum),
        );

        let sink = Sink::try_new(&self.stream_handle)
            .map_err(|e| format!("Sink 생성 실패: {}", e))?;
        sink.append(hifi);
        sink.play();

        *self.sink.lock() = Some(sink);
        *self.current_path.lock() = Some(path.to_string());
        *self.duration.lock() = Some(total_duration);

        Ok(total_duration)
    }

    pub fn pause(&self) {
        if let Some(sink) = &*self.sink.lock() { sink.pause(); }
    }

    pub fn resume(&self) {
        if let Some(sink) = &*self.sink.lock() { sink.play(); }
    }

    pub fn stop(&self) {
        if let Some(sink) = self.sink.lock().take() { sink.stop(); }
        *self.current_path.lock() = None;
        *self.duration.lock() = None;
    }

    /// 슬라이더(0~100) → dB 변환 → 볼륨 설정
    pub fn set_volume_slider(&self, slider: f32) {
        let db = VolumeProcessor::slider_to_db(slider as f64);
        self.volume.lock().set_volume_db(db);
    }

    /// dB 직접 설정
    pub fn set_volume_db(&self, db: f64) {
        self.volume.lock().set_volume_db(db);
    }

    /// 단일 EQ 밴드 설정 (band: 0~11, gain_db: -12~+12)
    pub fn set_eq_band(&self, band: usize, gain_db: f64) {
        self.eq.lock().set_band(band, gain_db);
    }

    /// EQ 전체 12밴드 한번에 설정
    pub fn set_eq_all(&self, gains: [f64; 12]) {
        let mut eq = self.eq.lock();
        for (i, &g) in gains.iter().enumerate() { eq.set_band(i, g); }
    }

    /// EQ 활성화/비활성화
    pub fn set_eq_enabled(&self, enabled: bool) {
        self.eq.lock().set_enabled(enabled);
    }

    pub fn get_position(&self) -> f64 {
        if let Some(sink) = &*self.sink.lock() {
            sink.get_pos().as_secs_f64()
        } else { 0.0 }
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        if let Some(sink) = &*self.sink.lock() {
            sink.try_seek(Duration::from_secs_f64(seconds))
                .map_err(|e| format!("Seek 실패: {}", e))?;
        }
        Ok(())
    }

    pub fn is_finished(&self) -> bool {
        if let Some(sink) = &*self.sink.lock() { sink.empty() } else { true }
    }

    pub fn get_duration(&self) -> f64 {
        self.duration.lock().unwrap_or(0.0)
    }

    /// 스펙트럼 80밴드 (0.0~1.0) 반환
    pub fn get_spectrum(&self) -> Vec<f32> {
        self.spectrum.lock().get_spectrum()
    }

    /// VU 미터용 RMS (L, R)
    pub fn get_rms(&self) -> (f32, f32) {
        self.spectrum.lock().get_rms()
    }

    /// 현재 EQ 게인 반환
    pub fn get_eq_gains(&self) -> [f64; 12] {
        self.eq.lock().get_gains()
    }
}
