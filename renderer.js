// ===== 니콘 친게 뮤직 플레이어 - renderer.js (Tauri + Rust 고음질 엔진) =====
// Web Audio API 완전 제거 — EQ/볼륨/스펙트럼/VU 모두 Rust DSP 처리
(function() {
  'use strict';

  const { open } = window.__TAURI__.dialog;
  const { readDir } = window.__TAURI__.fs;
  const { invoke } = window.__TAURI__.core;

  const SUPPORTED_EXTS = new Set(['mp3','flac','wav','aac','m4a','ogg','opus','wma',
    'aiff','aif','ape','wv','mpc','tta','spx','amr','mp4','webm','mkv','m4b',
    'mp2','ac3','dts','ra','mid','midi']);

  const state = {
    playlist: [], currentIndex: -1, isPlaying: false,
    isShuffle: false, repeatMode: 0, volume: 80,
    eqEnabled: false, animFrame: null, positionTimer: null,
    currentPosition: 0, currentDuration: 0,
    customEQPresets: JSON.parse(localStorage.getItem('customEQPresets') || '{}')
  };

  // ── EQ 정의 ─────────────────────────────────
  const EQ_BANDS = [
    {freq:32,label:'32'},{freq:64,label:'64'},{freq:125,label:'125'},
    {freq:250,label:'250'},{freq:500,label:'500'},{freq:1000,label:'1k'},
    {freq:2000,label:'2k'},{freq:4000,label:'4k'},{freq:8000,label:'8k'},
    {freq:12000,label:'12k'},{freq:16000,label:'16k'},{freq:20000,label:'20k'}
  ];
  const EQ_PRESETS = {
    flat:      [0,0,0,0,0,0,0,0,0,0,0,0],
    rock:      [5,4,3,2,-1,-1,0,2,4,5,5,4],
    pop:       [-1,0,2,3,4,3,2,1,0,-1,-1,-2],
    jazz:      [4,3,1,2,0,-1,-1,0,2,3,4,4],
    classical: [5,4,3,2,1,0,-1,-1,0,2,3,4],
    bass:      [8,7,6,4,2,0,0,0,0,0,0,0],
    vocal:     [-2,-1,0,1,4,5,5,4,2,1,0,-1],
    electronic:[6,5,3,0,-2,0,2,4,5,6,6,5]
  };
  let eqValues = [...EQ_PRESETS.flat];

  // ── LP / 아암 애니메이션 ─────────────────────
  const lpCanvas = document.getElementById('lp-canvas');
  const lpCtx = lpCanvas.getContext('2d');
  let lpSpinAngle=0, lpColorHue=30;
  const ARM_ANGLE_REST=95, ARM_ANGLE_START=140, ARM_ANGLE_END=162, ARM_LEN=130;
  let armAngle=ARM_ANGLE_REST, armAngleTarget=ARM_ANGLE_REST, armInitialized=false;

  function drawLP() {
    const dW=lpCanvas.offsetWidth, dH=lpCanvas.offsetHeight;
    if(dW>0&&(lpCanvas.width!==dW||lpCanvas.height!==dH)){lpCanvas.width=dW;lpCanvas.height=dH;}
    const W=lpCanvas.width, H=lpCanvas.height, lpR=H/2, lpCx=H/2, lpCy=H/2;
    lpCtx.clearRect(0,0,W,H);
    lpCtx.save();
    lpCtx.beginPath(); lpCtx.arc(lpCx,lpCy,lpR,0,Math.PI*2); lpCtx.clip();
    lpCtx.fillStyle='#1a1208'; lpCtx.fill();
    lpCtx.translate(lpCx,lpCy); lpCtx.rotate(lpSpinAngle);
    for(let i=2;i<=20;i++){
      const pr=(lpR-14)*(i/20);
      lpCtx.beginPath(); lpCtx.arc(0,0,pr,0,Math.PI*2);
      lpCtx.strokeStyle=`rgba(255,220,150,${0.04+(i%4===0?0.05:0)})`; lpCtx.lineWidth=0.7; lpCtx.stroke();
    }
    for(let i=0;i<6;i++){
      const sA=(i/6)*Math.PI*2, hue=(lpColorHue+i*40)%360;
      lpCtx.beginPath(); lpCtx.moveTo(0,0); lpCtx.arc(0,0,lpR-8,sA,sA+Math.PI/6); lpCtx.closePath();
      lpCtx.fillStyle=`hsla(${hue},70%,50%,0.05)`; lpCtx.fill();
    }
    lpCtx.beginPath(); lpCtx.arc(0,0,34,0,Math.PI*2);
    const lg=lpCtx.createRadialGradient(0,-8,4,0,0,34);
    lg.addColorStop(0,'#5c3a1e'); lg.addColorStop(1,'#2d1a0a');
    lpCtx.fillStyle=lg; lpCtx.fill();
    lpCtx.strokeStyle='rgba(200,160,80,0.5)'; lpCtx.lineWidth=1; lpCtx.stroke();
    lpCtx.fillStyle='#c8a050'; lpCtx.font='bold 6px Georgia,serif';
    lpCtx.textAlign='center'; lpCtx.textBaseline='middle';
    lpCtx.fillText('NIKON',0,-8); lpCtx.fillText('CHINGE',0,2);
    lpCtx.font='5px Georgia,serif'; lpCtx.fillStyle='rgba(200,160,80,0.7)';
    lpCtx.fillText('MUSIC',0,11);
    lpCtx.beginPath(); lpCtx.arc(0,0,4,0,Math.PI*2); lpCtx.fillStyle='#0a0806'; lpCtx.fill();
    lpCtx.restore();
    const rg=lpCtx.createRadialGradient(lpCx*0.8,lpCy*0.5,lpR*0.85,lpCx,lpCy,lpR);
    rg.addColorStop(0,'rgba(200,160,80,0.10)'); rg.addColorStop(1,'transparent');
    lpCtx.beginPath(); lpCtx.arc(lpCx,lpCy,lpR,0,Math.PI*2); lpCtx.fillStyle=rg; lpCtx.fill();
    const pivX=W-12, pivY=12, aRad=armAngle*Math.PI/180;
    const tipX=pivX+Math.cos(aRad)*ARM_LEN, tipY=pivY+Math.sin(aRad)*ARM_LEN;
    lpCtx.save();
    lpCtx.shadowColor='rgba(0,0,0,0.6)'; lpCtx.shadowBlur=4;
    lpCtx.beginPath(); lpCtx.moveTo(pivX,pivY); lpCtx.lineTo(tipX,tipY);
    lpCtx.strokeStyle='#8a7050'; lpCtx.lineWidth=5; lpCtx.lineCap='round'; lpCtx.stroke();
    lpCtx.shadowBlur=0;
    lpCtx.beginPath(); lpCtx.moveTo(pivX,pivY); lpCtx.lineTo(tipX,tipY);
    lpCtx.strokeStyle='rgba(255,220,150,0.3)'; lpCtx.lineWidth=1.5; lpCtx.stroke();
    lpCtx.restore();
    lpCtx.save(); lpCtx.translate(tipX,tipY); lpCtx.rotate(aRad+Math.PI/2);
    lpCtx.fillStyle='#6a5540'; lpCtx.strokeStyle='#c8a050'; lpCtx.lineWidth=0.8;
    lpCtx.beginPath(); lpCtx.rect(-5,-2,10,6); lpCtx.fill(); lpCtx.stroke();
    lpCtx.restore();
    lpCtx.save();
    lpCtx.beginPath(); lpCtx.arc(pivX,pivY,7,0,Math.PI*2);
    lpCtx.fillStyle='#8a7050'; lpCtx.fill();
    lpCtx.strokeStyle='#3a2a10'; lpCtx.lineWidth=1; lpCtx.stroke();
    lpCtx.restore();
  }

  // ── 스펙트럼 비주얼라이저 (Rust FFT 데이터) ──
  const specCanvas=document.getElementById('spectrum-canvas'), specCtx=specCanvas.getContext('2d');
  function resizeSpec(){specCanvas.width=specCanvas.offsetWidth*devicePixelRatio;specCanvas.height=specCanvas.offsetHeight*devicePixelRatio;specCtx.scale(devicePixelRatio,devicePixelRatio);}
  window.addEventListener('resize',resizeSpec); resizeSpec();

  let spectrumData = new Float32Array(80).fill(0);

  function drawSpectrum(){
    const w=specCanvas.offsetWidth, h=specCanvas.offsetHeight;
    specCtx.clearRect(0,0,w,h);
    if(!state.isPlaying){
      specCtx.beginPath();specCtx.moveTo(0,h);specCtx.lineTo(w,h);
      specCtx.strokeStyle='rgba(180,130,60,0.2)';specCtx.lineWidth=1;specCtx.stroke();return;
    }
    const bc=spectrumData.length, bw=(w/bc)-1;
    for(let i=0;i<bc;i++){
      const val=spectrumData[i]||0, bh=val*h*0.95;
      const hue=25+(i/bc)*20;
      const g=specCtx.createLinearGradient(0,h-bh,0,h);
      g.addColorStop(0,`hsla(${hue},80%,65%,0.9)`);g.addColorStop(1,`hsla(${hue},60%,35%,0.3)`);
      specCtx.fillStyle=g; specCtx.fillRect(i*(bw+1),h-bh,bw,bh);
    }
  }

  // ── VU 미터 (Rust RMS) ────────────────────────
  let vuNeedleL={angle:0,velocity:0}, vuNeedleR={angle:0,velocity:0};
  function updateVU(n,t){const sp=0.12,dm=0.68;n.velocity=n.velocity*dm+(Math.min(Math.max(t,0),1)-n.angle)*sp;n.angle=Math.max(0,Math.min(1,n.angle+n.velocity));}

  function drawOneVU(ctx,needle,bx,by,bW,bH,label){
    ctx.save();
    const bg=ctx.createLinearGradient(bx,by,bx,by+bH);
    bg.addColorStop(0,'#f0ebe0');bg.addColorStop(1,'#d8d0c0');
    ctx.fillStyle=bg;ctx.fillRect(bx,by,bW,bH);
    ctx.strokeStyle='#8a7a60';ctx.lineWidth=1.5;ctx.strokeRect(bx,by,bW,bH);
    ctx.restore();
    const cx=bx+bW/2,cy=by+bH+8,R=bH*1.05,sA=Math.PI,eA=Math.PI*2,sp=eA-sA;
    ctx.save();ctx.beginPath();ctx.rect(bx,by,bW,bH);ctx.clip();
    ctx.save();ctx.beginPath();ctx.arc(cx,cy,R*0.9,sA+sp*0.8,eA);ctx.lineTo(cx,cy);ctx.closePath();ctx.fillStyle='rgba(200,50,20,0.12)';ctx.fill();ctx.restore();
    [{t:0,txt:'-20',mj:true},{t:0.20,txt:'-10',mj:true},{t:0.38,txt:'-7',mj:false},{t:0.52,txt:'-5',mj:true},{t:0.65,txt:'-3',mj:false},{t:0.77,txt:'0',mj:true},{t:0.88,txt:'+2',mj:false},{t:1,txt:'+3',mj:true}].forEach(({t,txt,mj})=>{
      const a=sA+t*sp,isR=t>=0.77;
      ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*R*(mj?0.68:0.74),cy+Math.sin(a)*R*(mj?0.68:0.74));ctx.lineTo(cx+Math.cos(a)*R*0.88,cy+Math.sin(a)*R*0.88);
      ctx.strokeStyle=isR?'#c02010':'#444430';ctx.lineWidth=mj?1.8:0.9;ctx.stroke();
      if(mj){ctx.fillStyle=isR?'#c02010':'#333320';ctx.font=`bold ${Math.max(8,bH*0.11)}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(txt,cx+Math.cos(a)*R*0.57,cy+Math.sin(a)*R*0.57);}
    });
    ctx.fillStyle='#222210';ctx.font=`bold ${Math.max(9,bH*0.13)}px Georgia,serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('VU',cx,by+bH*0.30);
    ctx.font=`${Math.max(8,bH*0.10)}px sans-serif`;ctx.fillStyle='#666650';ctx.fillText(label,cx,by+bH*0.48);
    const nA=sA+needle.angle*sp,nL=R*0.86;
    ctx.beginPath();ctx.moveTo(cx+Math.cos(nA+Math.PI)*R*0.14,cy+Math.sin(nA+Math.PI)*R*0.14);ctx.lineTo(cx+Math.cos(nA)*nL,cy+Math.sin(nA)*nL);
    ctx.strokeStyle='#bb1100';ctx.lineWidth=2.5;ctx.lineCap='round';ctx.stroke();
    ctx.beginPath();ctx.arc(cx,cy,5,0,Math.PI*2);ctx.fillStyle='#555540';ctx.fill();
    ctx.restore();
  }

  function drawVU(){
    const c=document.getElementById('vu-canvas');if(!c)return;
    const W=c.offsetWidth||380,H=c.offsetHeight||100;
    if(c.width!==W||c.height!==H){c.width=W;c.height=H;}
    const ctx=c.getContext('2d');
    const bg=ctx.createLinearGradient(0,0,0,H);bg.addColorStop(0,'#2a1f0e');bg.addColorStop(1,'#1a1208');
    ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='#5a4020';ctx.lineWidth=2;ctx.strokeRect(1,1,W-2,H-2);
    const gap=6,bW=(W-gap*3)/2,bH=H-gap*2;
    drawOneVU(ctx,vuNeedleL,gap,gap,bW,bH,'L');
    drawOneVU(ctx,vuNeedleR,gap*2+bW,gap,bW,bH,'R');
  }

  // ── 메인 애니메이션 루프 ──────────────────────
  let lastSpectrumFetch = 0;
  let rmsL = 0, rmsR = 0;

  async function fetchAudioData() {
    if (!state.isPlaying) return;
    try {
      const [spectrum, rms] = await Promise.all([
        invoke('audio_get_spectrum'),
        invoke('audio_get_rms'),
      ]);
      spectrumData = spectrum;
      rmsL = Math.min(rms[0] * 5, 1);
      rmsR = Math.min(rms[1] * 5, 1);
    } catch(e) {}
  }

  function animate(ts) {
    state.animFrame = requestAnimationFrame(animate);
    if (state.isPlaying) { lpSpinAngle += 0.012; lpColorHue = (lpColorHue + 0.05) % 360; }
    if (!state.isPlaying) { armAngleTarget = ARM_ANGLE_REST; armInitialized = false; }
    else if (state.currentDuration > 0) {
      const p = state.currentPosition / state.currentDuration;
      armAngleTarget = ARM_ANGLE_START + (ARM_ANGLE_END - ARM_ANGLE_START) * p;
      if (!armInitialized) { armAngle = armAngleTarget; armInitialized = true; }
    } else armAngleTarget = ARM_ANGLE_START;
    const diff = armAngleTarget - armAngle;
    armAngle += state.isPlaying ? diff : diff * 0.05;
    drawLP();
    drawSpectrum();
    updateVU(vuNeedleL, state.isPlaying ? rmsL : 0);
    updateVU(vuNeedleR, state.isPlaying ? rmsR : 0);
    drawVU();
    if (ts - lastSpectrumFetch > 33) { // 30fps
      lastSpectrumFetch = ts;
      fetchAudioData();
    }
  }

  // ── 재생 위치 추적 ────────────────────────────
  function startPositionTracking() {
    stopPositionTracking();
    state.positionTimer = setInterval(async () => {
      if (!state.isPlaying) return;
      try {
        const pos = await invoke('audio_get_position');
        state.currentPosition = pos;
        updateProgressUI(pos, state.currentDuration);
        const finished = await invoke('audio_is_finished');
        if (finished) onTrackFinished();
      } catch(e) {}
    }, 250);
  }

  function stopPositionTracking() {
    if (state.positionTimer) { clearInterval(state.positionTimer); state.positionTimer = null; }
  }

  function updateProgressUI(pos, dur) {
    if (dur > 0) document.getElementById('progress-fill').style.width = (pos / dur * 100) + '%';
    document.getElementById('time-current').textContent = formatTime(pos);
    document.getElementById('time-total').textContent = formatTime(dur);
  }

  function onTrackFinished() {
    if (state.repeatMode === 2) { window.playerAPI.playAt(state.currentIndex); }
    else if (state.repeatMode === 1 || state.currentIndex < state.playlist.length - 1) { window.playerAPI.nextTrack(); }
    else { setPlayState(false); }
  }

  // ── EQ ──────────────────────────────────────
  function buildEQSliders() {
    const c = document.getElementById('eq-sliders'); c.innerHTML = '';
    EQ_BANDS.forEach((band, i) => {
      const d = document.createElement('div'); d.className = 'eq-band';
      d.innerHTML = `<div class="eq-val" id="eq-val-${i}">${eqValues[i]>0?'+':''}${eqValues[i]}</div><div class="eq-slider-wrap"><input type="range" class="eq-range" id="eq-${i}" min="-12" max="12" value="${eqValues[i]}" step="0.5"></div><div class="eq-freq">${band.label}</div>`;
      c.appendChild(d);
      d.querySelector(`#eq-${i}`).addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        eqValues[i] = v;
        document.getElementById(`eq-val-${i}`).textContent = (v > 0 ? '+' : '') + v;
        invoke('audio_set_eq_band', { band: i, gain_db: v }).catch(console.error);
      });
    });
  }

  function applyEQAll() {
    invoke('audio_set_eq_all', { gains: eqValues }).catch(console.error);
  }

  // ── 플레이리스트 ─────────────────────────────
  function renderPlaylist() {
    const list = document.getElementById('playlist-list');
    const empty = document.getElementById('playlist-empty');
    const cnt = document.getElementById('playlist-count');
    cnt.textContent = `${state.playlist.length} 곡`;
    if (!state.playlist.length) { empty.style.display = ''; list.style.display = 'none'; return; }
    empty.style.display = 'none'; list.style.display = '';
    list.innerHTML = '';
    state.playlist.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'pl-item' + (i === state.currentIndex ? ' active' : '');
      const dur = t.duration ? formatTime(t.duration) : '--:--';
      el.innerHTML = `<div class="pl-num">${i+1}</div><div class="pl-playing-indicator"><div class="pl-bar"></div><div class="pl-bar"></div><div class="pl-bar"></div></div><div class="pl-info"><div class="pl-name">${escHtml(t.name)}</div><div class="pl-meta">${escHtml(t.ext.toUpperCase())}</div></div><div class="pl-duration">${dur}</div><button class="pl-remove" onclick="window.playerAPI.removeTrack(${i});event.stopPropagation()">✕</button>`;
      el.addEventListener('dblclick', () => window.playerAPI.playAt(i));
      list.appendChild(el);
    });
  }

  async function loadAndPlay(index) {
    if (index < 0 || index >= state.playlist.length) return;
    state.currentIndex = index;
    const t = state.playlist[index];
    document.querySelectorAll('.pl-item').forEach((el, i) => el.classList.toggle('active', i === index));
    const items = document.querySelectorAll('.pl-item');
    if (items[index]) items[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    document.getElementById('track-title').textContent = t.name;
    document.getElementById('track-artist').textContent = t.ext.toUpperCase() + ' • 니콘 친게 뮤직 플레이어';
    try {
      const duration = await invoke('audio_play', { path: t.path });
      state.currentDuration = duration;
      state.currentPosition = 0;
      if (!t.duration) { t.duration = duration; renderPlaylist(); }
      updateProgressUI(0, duration);
      setPlayState(true);
      startPositionTracking();
    } catch(e) { console.error('재생 오류:', e); }
  }

  function setPlayState(p) {
    state.isPlaying = p;
    document.getElementById('play-icon').style.display = p ? 'none' : '';
    document.getElementById('pause-icon').style.display = p ? '' : 'none';
    if (!p) stopPositionTracking();
  }

  // ── 진행바 ───────────────────────────────────
  document.getElementById('progress-wrap').addEventListener('click', async e => {
    if (!state.currentDuration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const seconds = ((e.clientX - r.left) / r.width) * state.currentDuration;
    await invoke('audio_seek', { seconds });
    state.currentPosition = seconds;
    updateProgressUI(seconds, state.currentDuration);
  });

  // ── 볼륨 슬라이더 ────────────────────────────
  // 슬라이더 0~100 → Rust에서 dB 변환 (심리음향학적 로그 스케일)
  const volSlider = document.getElementById('vol-slider');
  volSlider.addEventListener('input', () => {
    const v = parseInt(volSlider.value);
    state.volume = v;
    document.getElementById('vol-fill').style.width = v + '%';
    document.getElementById('vol-val').textContent = v;
    invoke('audio_set_volume', { volume: v }).catch(console.error);
  });

  // ── 드래그 앤 드롭 ───────────────────────────
  const dropOverlay = document.getElementById('drop-overlay');
  document.addEventListener('dragover', e => { e.preventDefault(); dropOverlay && dropOverlay.classList.add('active'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget || e.relatedTarget === document.documentElement) dropOverlay && dropOverlay.classList.remove('active'); });
  document.addEventListener('drop', async e => {
    e.preventDefault(); dropOverlay && dropOverlay.classList.remove('active');
    const paths = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      if (!f.path) continue;
      const ext = f.name.split('.').pop().toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) paths.push(f.path);
      else { const found = await scanFolder(f.path); paths.push(...found); }
    }
    if (paths.length) addFilesToPlaylist(paths);
  });

  async function scanFolder(dir) {
    const res = [];
    try {
      const entries = await readDir(dir, { recursive: true });
      function collect(items) {
        for (const it of items) {
          if (it.children) collect(it.children);
          else if (it.name) { const ext = it.name.split('.').pop().toLowerCase(); if (SUPPORTED_EXTS.has(ext)) res.push(it.path); }
        }
      }
      collect(entries);
    } catch(e) { console.error(e); }
    return res;
  }

  async function addFilesToPlaylist(fps) {
    const was = state.playlist.length === 0;
    for (const fp of fps) {
      if (state.playlist.some(t => t.path === fp)) continue;
      const parts = fp.replace(/\\/g, '/').split('/');
      const bn = parts[parts.length - 1];
      const ext = bn.split('.').pop().toLowerCase();
      state.playlist.push({ path: fp, name: bn.replace(/\.[^.]+$/, ''), ext, duration: null });
    }
    renderPlaylist();
    if (was && state.playlist.length) loadAndPlay(0);
  }

  // ── Public API ───────────────────────────────
  window.playerAPI = {
    async openFiles() {
      const sel = await open({ multiple: true, filters: [{ name: '음악 파일', extensions: [...SUPPORTED_EXTS] }] });
      if (sel) addFilesToPlaylist(Array.isArray(sel) ? sel : [sel]);
    },
    async openFolder() {
      const sel = await open({ directory: true });
      if (sel) { const f = await scanFolder(sel); if (f.length) addFilesToPlaylist(f); }
    },
    async togglePlay() {
      if (!state.playlist.length) return;
      if (state.currentIndex === -1) { loadAndPlay(0); return; }
      if (state.isPlaying) {
        await invoke('audio_pause');
        setPlayState(false);
      } else {
        await invoke('audio_resume');
        setPlayState(true);
        startPositionTracking();
      }
    },
    nextTrack() {
      if (!state.playlist.length) return;
      loadAndPlay(state.isShuffle ? Math.floor(Math.random() * state.playlist.length) : (state.currentIndex + 1) % state.playlist.length);
    },
    prevTrack() {
      if (!state.playlist.length) return;
      if (state.currentPosition > 3) { invoke('audio_seek', { seconds: 0 }); state.currentPosition = 0; return; }
      loadAndPlay(state.isShuffle ? Math.floor(Math.random() * state.playlist.length) : (state.currentIndex - 1 + state.playlist.length) % state.playlist.length);
    },
    playAt(i) { loadAndPlay(i); },
    removeTrack(i) {
      if (state.currentIndex === i) {
        invoke('audio_stop');
        setPlayState(false);
        state.currentIndex = -1; state.currentPosition = 0; state.currentDuration = 0;
        document.getElementById('track-title').textContent = '음악을 추가하세요';
        document.getElementById('track-artist').textContent = '';
        document.getElementById('progress-fill').style.width = '0%';
      } else if (state.currentIndex > i) state.currentIndex--;
      state.playlist.splice(i, 1);
      renderPlaylist();
    },
    clearPlaylist() {
      invoke('audio_stop');
      setPlayState(false);
      state.playlist = []; state.currentIndex = -1; state.currentPosition = 0; state.currentDuration = 0;
      document.getElementById('track-title').textContent = '음악을 추가하세요';
      document.getElementById('track-artist').textContent = '';
      document.getElementById('progress-fill').style.width = '0%';
      document.getElementById('time-current').textContent = '0:00';
      document.getElementById('time-total').textContent = '0:00';
      renderPlaylist();
    },
    toggleShuffle() {
      state.isShuffle = !state.isShuffle;
      document.getElementById('btn-shuffle').classList.toggle('active', state.isShuffle);
    },
    toggleRepeat() {
      state.repeatMode = (state.repeatMode + 1) % 3;
      const b = document.getElementById('btn-repeat');
      b.classList.toggle('active', state.repeatMode > 0);
      b.style.color = state.repeatMode === 2 ? 'var(--gold)' : '';
    },
    toggleEQ() {
      state.eqEnabled = !state.eqEnabled;
      document.getElementById('eq-switch').classList.toggle('on', state.eqEnabled);
      invoke('audio_set_eq_enabled', { enabled: state.eqEnabled }).catch(console.error);
    },
    setPreset(name) {
      const vals = EQ_PRESETS[name] ? [...EQ_PRESETS[name]] : [...EQ_PRESETS.flat];
      eqValues = vals;
      EQ_BANDS.forEach((_, i) => {
        const s = document.getElementById(`eq-${i}`);
        if (s) { s.value = eqValues[i]; document.getElementById(`eq-val-${i}`).textContent = (eqValues[i] > 0 ? '+' : '') + eqValues[i]; }
      });
      applyEQAll();
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    },
    saveCustomEQ() {
      document.getElementById('save-modal').classList.add('open');
      document.getElementById('preset-name-input').value = '';
      document.getElementById('preset-name-input').focus();
    },
    confirmSaveEQ() {
      const name = document.getElementById('preset-name-input').value.trim();
      if (!name) return;
      state.customEQPresets[name] = [...eqValues];
      localStorage.setItem('customEQPresets', JSON.stringify(state.customEQPresets));
      document.getElementById('save-modal').classList.remove('open');
    },
    resetEQ() {
      eqValues = [...EQ_PRESETS.flat];
      EQ_BANDS.forEach((_, i) => {
        const s = document.getElementById(`eq-${i}`);
        if (s) { s.value = 0; document.getElementById(`eq-val-${i}`).textContent = '0'; }
      });
      applyEQAll();
    }
  };

  // ── 키보드 단축키 ────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); window.playerAPI.togglePlay(); }
    else if (e.code === 'ArrowRight') window.playerAPI.nextTrack();
    else if (e.code === 'ArrowLeft') window.playerAPI.prevTrack();
    else if (e.code === 'ArrowUp') { e.preventDefault(); volSlider.value = Math.min(100, +volSlider.value + 5); volSlider.dispatchEvent(new Event('input')); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); volSlider.value = Math.max(0, +volSlider.value - 5); volSlider.dispatchEvent(new Event('input')); }
  });

  document.getElementById('preset-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') window.playerAPI.confirmSaveEQ();
    if (e.key === 'Escape') document.getElementById('save-modal').classList.remove('open');
  });

  // 초기 볼륨 설정
  invoke('audio_set_volume', { volume: state.volume }).catch(console.error);

  // ── 출력 장치 ────────────────────────────────
  async function loadOutputDevices() {
    try {
      const devices = await invoke('audio_list_devices');
      const sel = document.getElementById('device-select');
      sel.innerHTML = '';
      devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = d.is_default ? `${d.name} (기본)` : d.name;
        if (d.is_default) opt.selected = true;
        sel.appendChild(opt);
      });
    } catch(e) { console.error('장치 목록 로드 실패', e); }
  }

  window.playerAPI.setOutputDevice = async function(deviceName) {
    try {
      await invoke('audio_set_device', { device_name: deviceName });
    } catch(e) {
      console.error('장치 변경 실패', e);
      alert('출력 장치 변경 실패: ' + e);
    }
  };

  // ── 유틸 ─────────────────────────────────────
  function formatTime(s) { if (!s || isNaN(s)) return '0:00'; return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // 시작
  drawVU(); buildEQSliders(); renderPlaylist(); requestAnimationFrame(animate);
  loadOutputDevices();
  console.log('🎵 니콘 친게 뮤직 플레이어 (Rust 고음질 엔진) 로드 완료');
})();
