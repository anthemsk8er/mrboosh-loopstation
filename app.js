/* RC-PRO STUDIO — hilo principal.
 *
 * El hilo principal NO procesa audio: solo dibuja, captura gestos y manda comandos
 * al AudioWorklet, que a su vez llama al núcleo Rust/WASM. Toda la mezcla, los buffers
 * y el overdub viven en wasm.
 */

const MAX_SECONDS = 30; // longitud máxima de loop por pista
const TRACKS = 5;

const CMD = { REC: 1, PLAY: 2, DUB: 3, STOP: 4, CLEAR: 5, TOGGLE: 6 };
const P = { VOL: 0, PAN: 1, MUTE: 2, SOLO: 3, REV: 4, FX: 5, SYNC: 6, DRIVE: 7, ECHO: 8, ECHO_FB: 9, ECHO_TIME: 10, SPACE: 11, SPACE_SIZE: 12 };
const G_TRIM = 8;
const G = { MASTER: 0, BPM: 1, METRO: 2, DRIVE: 3, QUANT: 4, SPEAKER: 5, LATCOMP: 6, CLICK: 7 };

const ST = { EMPTY: 0, REC: 1, PLAY: 2, DUB: 3, STOP: 4 };
const ST_KEYS = ['pill.empty', 'pill.rec', 'pill.play', 'pill.dub', 'pill.stop'];
const PAD_STATE = { 0: 'empty', 1: 'rec', 2: 'play', 3: 'dub', 4: 'stop' };
const stLabel = (st) => t(ST_KEYS[st] || 'pill.empty');
const ST_KEY = { 0: 'empty', 1: 'rec', 2: 'play', 3: 'dub', 4: 'stop' };
const PAD_LABEL = { 0: 'REC', 1: 'STOP REC', 2: 'OVERDUB', 3: 'CERRAR', 4: 'PLAY' };

// ------------------------------------------------------------------ estado UI
const state = {
  ready: false,
  booting: false,
  error: null,
  sr: 0,
  engineBytes: 0,
  memBytes: 0,
  mic: false,
  mon: false,
  quant: true,
  speaker: localStorage.getItem('rcpro.speaker') !== '0', // sin audífonos por defecto
  metro: false,
  latComp: 0,
  latUser: false,
  bpm: 120,
  master: 0.85,
  drive: 1,
  loopSeconds: 0,
  loopBeats: 0,
  progress: 0,
  inPeak: 0,
  micBlocked: false,
  latWarned: false,
  silentSince: 0,
  mL: 0,
  mR: 0,
  cpuUs: 0,
  cpuPct: 0,
  underruns: 0,
  captureTrack: -1,
  captureLen: 0,
  tracks: Array.from({ length: TRACKS }, () => ({
    state: 0, peak: 0, vol: 0.55, pan: 0, mute: false, solo: false, rev: false, fx: 1,
    pos: 0, secs: 0, sync: true,
  })),
};

const waves = Array.from({ length: TRACKS }, () => null);
const peakSmooth = new Float32Array(TRACKS);
const peakHold = new Float32Array(TRACKS);
const holdTimer = new Float32Array(TRACKS);

let ctx = null;
let node = null;
let inputBus = null;
let monitorBus = null;
let monitorGain = null;
let micSource = null;
let micStream = null;
let noiseBuf = null;
const strips = [];
let latKnobRef = null;
let clipHold = 0;

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const post = (msg) => { if (node) node.port.postMessage(msg); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDb = (lin) => (lin <= 0.0005 ? '-∞' : (20 * Math.log10(lin)).toFixed(1));

function toast(msg, kind = 'info') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (kind !== 'info' ? ' ' + kind : '');
  t.innerHTML = `<span class="ico">${kind === 'rec' ? '●' : kind === 'warn' ? '!' : kind === 'err' ? '×' : '»'}</span><span>${msg}</span>`;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 240); }, 2800);
  while (box.children.length > 4) box.firstElementChild.remove();
}

// ------------------------------------------------------------------ knobs
const KNOB_SWEEP = 270; // grados

function createKnob({ mount, label, min, max, value, def, step = 0.01, size = 44, format, onChange, title, titleKey }) {
  const c = size / 2;
  const r = c - 5;
  const C = 2 * Math.PI * r;
  if (!mount) return null;
  const wrap = document.createElement('div');
  wrap.className = 'knob';
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'slider');
  wrap.setAttribute('aria-label', label);
  if (titleKey) { wrap.dataset.titleKey = titleKey; wrap.title = t(titleKey); }
  else if (title) wrap.title = title;
  wrap.setAttribute('aria-valuemin', String(min));
  wrap.setAttribute('aria-valuemax', String(max));

  const polar = (cx, cy, rad, deg) => [cx + rad * Math.cos((deg * Math.PI) / 180), cy + rad * Math.sin((deg * Math.PI) / 180)];
  const [nx, ny] = polar(c, c, r - 6, 135 + KNOB_SWEEP);

  wrap.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="kbody" cx="${c}" cy="${c}" r="${r - 3.5}"></circle>
      <circle class="ktrack" cx="${c}" cy="${c}" r="${r}" stroke-dasharray="${(0.75 * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(135 ${c} ${c})"></circle>
      <circle class="karc" cx="${c}" cy="${c}" r="${r}" stroke-dasharray="0 ${C.toFixed(2)}" transform="rotate(135 ${c} ${c})"></circle>
      <line class="kneedle" x1="${c}" y1="${c}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}"></line>
      <circle cx="${c}" cy="${c}" r="3" fill="#0d0d11" stroke="#000" stroke-width="1"></circle>
    </svg>
    <span class="knob-label">${label}</span>
    <span class="knob-val"></span>`;
  mount.replaceWith(wrap);
  // whoops: replaceWith removes the mount node, keep a reference
  const arc = wrap.querySelector('.karc');
  const needle = wrap.querySelector('.kneedle');
  const valEl = wrap.querySelector('.knob-val');
  const [cx, cy] = [c, c];

  let val = value;

  function paint() {
    const t = (val - min) / (max - min);
    arc.setAttribute('stroke-dasharray', `${(t * 0.75 * C).toFixed(2)} ${C.toFixed(2)}`);
    const a = 135 + t * KNOB_SWEEP;
    const [px, py] = polar(cx, cy, r - 6, a);
    needle.setAttribute('x2', px.toFixed(2));
    needle.setAttribute('y2', py.toFixed(2));
    valEl.textContent = format ? format(val) : val.toFixed(2);
    wrap.setAttribute('aria-valuenow', String(+val.toFixed(3)));
    wrap.setAttribute('aria-valuetext', format ? format(val) : String(val));
  }

  function set(v, silent) {
    const next = clamp(v, min, max);
    if (next === val) return;
    val = next;
    paint();
    if (!silent && onChange) onChange(val);
  }

  paint();

  // drag vertical (táctil incluido)
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    wrap.focus();
    drag = { y: e.clientY, v: val, span: (max - min) };
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const scale = e.shiftKey ? 0.25 : 1;
    const dv = ((drag.y - e.clientY) / 150) * drag.span * scale;
    set(drag.v + dv);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { wrap.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(val + (e.deltaY > 0 ? -1 : 1) * step * (e.shiftKey ? 1 : 3));
  }, { passive: false });

  wrap.addEventListener('dblclick', () => set(def !== undefined ? def : value));

  wrap.addEventListener('keydown', (e) => {
    const big = step * 10;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': set(val + step); break;
      case 'ArrowDown': case 'ArrowLeft': set(val - step); break;
      case 'PageUp': set(val + big); break;
      case 'PageDown': set(val - big); break;
      case 'Home': set(min); break;
      case 'End': set(max); break;
      default: return;
    }
    e.preventDefault();
  });

  return { el: wrap, set, get value() { return val; } };
}

// ------------------------------------------------------------------ construcción del rack
function buildRack() {
  const rack = $('#rack');
  const beatGrid = $('#beat-grid');
  beatGrid.innerHTML = '<i></i>'.repeat(16);

  for (let i = 0; i < TRACKS; i++) {
    const el = document.createElement('article');
    el.className = 'strip';
    el.dataset.track = String(i);
    el.dataset.state = 'empty';
    el.innerHTML = `
      <div class="strip-head">
        <span class="strip-name">${t('strip.name', { n: pad2(i + 1) })}</span>
        <span class="pill" data-pill>${t('pill.empty')}</span>
      </div>
      <canvas class="wave" data-wave aria-hidden="true"></canvas>
      <div class="vu" data-vu><div class="vu-fill"></div></div>
      <button class="pad" data-pad data-state="empty">
        <strong data-pad-label>REC</strong><small data-pad-sub>${t('pad.sub.ready')}</small>
      </button>
      <div class="strip-knobs">
        <div data-knob="vol"></div>
        <div data-knob="pan"></div>
      </div>
      <div class="mini-btns">
        <button class="mini" data-on="mute" aria-pressed="false" title="${t('mini.mute.title')}">${t('mini.mute')}</button>
        <button class="mini" data-on="solo" aria-pressed="false" title="${t('mini.solo.title')}">${t('mini.solo')}</button>
        <button class="mini" data-on="rev" aria-pressed="false" title="${t('mini.rev.title')}">${t('mini.rev')}</button>
      </div>
      <div class="mini-btns" style="grid-template-columns:1fr 1fr">
        <button class="mini" data-act="stop" title="${t('mini.stop.title')}">${t('mini.stop')}</button>
        <button class="mini danger" data-act="clear" title="${t('mini.clear.title')}">${t('mini.clear')}</button>
        <button class="mini" data-act="sync" aria-pressed="true" title="${t('mini.sync.title')}">${t('mini.sync')}</button>
        <button class="mini" data-act="undo" title="${t('mini.undo.title')}">${t('mini.undo')}</button>
      </div>
      <div class="strip-fx">
        <span class="fx-title">${t('fx.title')}</span>
        <div class="fx-grid">
          <div data-knob="fx"></div>
          <div data-knob="drive"></div>
          <div data-knob="echo"></div>
          <div data-knob="space"></div>
        </div>
      </div>`;
    rack.appendChild(el);

    const refs = {
      el,
      pill: el.querySelector('[data-pill]'),
      canvas: el.querySelector('[data-wave]'),
      vu: el.querySelector('[data-vu] .vu-fill'),
      pad: el.querySelector('[data-pad]'),
      padLabel: el.querySelector('[data-pad-label]'),
      padSub: el.querySelector('[data-pad-sub]'),
    };

    refs.pad.addEventListener('click', () => padPress(i));

    const kv = createKnob({
      mount: el.querySelector('[data-knob="vol"]'),
      label: 'Vol', min: 0, max: 1.2, value: 0.55, def: 0.55, step: 0.02,
      titleKey: 'knob.vol.title',
      format: (v) => `${Math.round(v * 100)}`,
      onChange: (v) => { state.tracks[i].vol = v; post({ t: 'param', track: i, id: P.VOL, v }); },
    });
    const kp = createKnob({
      mount: el.querySelector('[data-knob="pan"]'),
      label: 'Pan', min: -1, max: 1, value: 0, def: 0, step: 0.05,
      titleKey: 'knob.pan.title',
      format: (v) => (Math.abs(v) < 0.05 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`),
      onChange: (v) => { state.tracks[i].pan = v; post({ t: 'param', track: i, id: P.PAN, v }); },
    });
    const kd = createKnob({
      mount: el.querySelector('[data-knob="drive"]'),
      label: 'Drive', min: 1, max: 8, value: 1, def: 1, step: 0.1, size: 36,
      titleKey: 'knob.drive2.title',
      format: (v) => (v < 1.05 ? 'off' : `${v.toFixed(1)}x`),
      onChange: (v) => post({ t: 'param', track: i, id: P.DRIVE, v }),
    });
    const ke = createKnob({
      mount: el.querySelector('[data-knob="echo"]'),
      label: 'Echo', min: 0, max: 1, value: 0, def: 0, step: 0.02, size: 36,
      titleKey: 'knob.echo.title',
      format: (v) => (v < 0.01 ? 'off' : `${Math.round(v * 100)}`),
      onChange: (v) => {
        post({ t: 'param', track: i, id: P.ECHO, v });
        if (v > 0.01) post({ t: 'param', track: i, id: P.ECHO_FB, v: 0.35 });
      },
    });
    const ks = createKnob({
      mount: el.querySelector('[data-knob="space"]'),
      label: 'Space', min: 0, max: 1, value: 0, def: 0, step: 0.02, size: 36,
      titleKey: 'knob.space.title',
      format: (v) => (v < 0.01 ? 'off' : `${Math.round(v * 100)}`),
      onChange: (v) => post({ t: 'param', track: i, id: P.SPACE, v }),
    });

    const kf = createKnob({
      mount: el.querySelector('[data-knob="fx"]'),
      label: 'Cut', min: 0, max: 1, value: 1, def: 1, step: 0.02, size: 36,
      titleKey: 'knob.cut.title',
      format: (v) => {
        const hz = 220 * Math.pow(18000 / 220, v);
        return hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;
      },
      onChange: (v) => { state.tracks[i].fx = v; post({ t: 'param', track: i, id: P.FX, v }); },
    });

    el.querySelectorAll('.mini[data-on]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const on = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(on));
        const kind = btn.dataset.on;
        const id = kind === 'mute' ? P.MUTE : kind === 'solo' ? P.SOLO : P.REV;
        state.tracks[i][kind] = on;
        post({ t: 'param', track: i, id, v: on ? 1 : 0 });
        const n = pad2(i + 1);
        if (kind === 'mute') toast(t(on ? 't.muteOn' : 't.muteOff', { n }), on ? 'warn' : 'info');
        if (kind === 'solo') toast(t(on ? 't.soloOn' : 't.soloOff', { n }), 'info');
        if (kind === 'rev') toast(t(on ? 't.revOn' : 't.revOff', { n }), 'info');
      });
    });

    // arrastrar y soltar
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      strips.forEach((s) => s.el.classList.remove('drop-target'));
    });
    el.addEventListener('dragover', (e) => {
      const src = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(src) || src === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      strips.forEach((s, idx) => s.el.classList.toggle('drop-target', idx === i));
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const src = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(src) || src === i) return;
      if (state.tracks[src].state === ST.EMPTY) { toast(t('t.srcEmpty'), 'warn'); return; }
      openMergeModal(src, i);
    });

    el.querySelector('[data-act="undo"]').addEventListener('click', () => undoLast(`pista ${pad2(i + 1)}`));

    el.querySelector('[data-act="stop"]').addEventListener('click', () => {
      post({ t: 'cmd', track: i, cmd: CMD.STOP });
      toast(t('t.stopped', { n: pad2(i + 1) }));
    });
    const syncBtn = el.querySelector('[data-act="sync"]');
    syncBtn.addEventListener('click', () => {
      const next = syncBtn.getAttribute('aria-pressed') !== 'true';
      syncBtn.setAttribute('aria-pressed', String(next));
      syncBtn.textContent = next ? t('mini.sync') : t('mini.free');
      state.tracks[i].sync = next;
      post({ t: 'param', track: i, id: P.SYNC, v: next ? 1 : 0 });
      toast(t(next ? 't.syncOn' : 't.syncOff', { n: pad2(i + 1) }), next ? 'info' : 'warn');
    });

    el.querySelector('[data-act="clear"]').addEventListener('click', () => {
      post({ t: 'cmd', track: i, cmd: CMD.CLEAR });
      waves[i] = null;
      toast(t('t.cleared', { n: pad2(i + 1) }), 'warn');
    });

    strips.push({ ...refs, knobs: { vol: kv, pan: kp, fx: kf, drive: kd, echo: ke, space: ks } });
  }
}

async function padPress(i) {
  const tr = state.tracks[i];
  if (state.captureTrack >= 0 && state.captureTrack !== i) {
    toast(t('t.waitCapture', { n: pad2(state.captureTrack + 1) }), 'warn');
    return;
  }
  // el primer toque arranca el contexto y espera al worklet: sin esto el pad "no responde" al inicio
  await ensureAudio();
  if (!(await waitReady())) {
    toast(t('t.engineStarting'), 'warn');
    return;
  }
  // beatbox: si el micro está apagado, se enciende solo al tocar el pad
  if (!state.mic && !state.micBlocked) {
    await toggleMic();
    if (state.mic) toast(t('t.micAuto'));
  }
  const first = state.loopSeconds === 0 && tr.state === ST.EMPTY;
  const before = tr.state;
  post({ t: 'cmd', track: i, cmd: CMD.TOGGLE });
  const n = pad2(i + 1);
  if (before === ST.EMPTY) toast(t('t.recStarted', { n }), 'rec');
  else if (before === ST.REC) {
    toast(t('t.loopClosed', { n }));
    if (first) setTimeout(() => toast(t('t.firstLoop')), 1200);
  }
  else if (before === ST.PLAY) toast(t('t.dubRec', { n }), 'rec');
  else if (before === ST.DUB) toast(t('t.dubSaved', { n }));
  else toast(t('t.resumed', { n }));
}

// ------------------------------------------------------------------ motor de audio
async function boot() {
  if (state.booting || state.ready) return;
  state.booting = true;
  try {
    const res = await fetch('./wasm/loop_engine.wasm?v=11');
    if (!res.ok) throw new Error(`wasm HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    state.engineBytes = bytes.byteLength;

    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    state.sr = ctx.sampleRate;
    await ctx.audioWorklet.addModule('./worklet/loop-processor.js?v=11');

    node = new AudioWorkletNode(ctx, 'loop-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { wasmBytes: bytes, maxSeconds: MAX_SECONDS, tracks: TRACKS },
    });

    inputBus = ctx.createGain();
    inputBus.gain.value = 1;
    inputBus.connect(node);

    monitorBus = ctx.createGain();
    monitorBus.gain.value = 0.9;
    monitorBus.connect(ctx.destination);

    monitorGain = ctx.createGain();
    monitorGain.gain.value = 0; // monitor directo apagado por defecto (evita acople)
    monitorGain.connect(monitorBus);

    node.connect(ctx.destination);

    node.port.onmessage = onEngineMessage;

    // valores iniciales del motor (coinciden con la UI)
    post({ t: 'global', id: G.MASTER, v: state.master });
    post({ t: 'global', id: G.BPM, v: state.bpm });
    post({ t: 'global', id: G.DRIVE, v: state.drive });
    post({ t: 'global', id: G.QUANT, v: state.quant ? 1 : 0 });
    post({ t: 'global', id: G.SPEAKER, v: state.speaker ? 1 : 0 });

    try { await ctx.resume(); } catch { /* el primer gesto del usuario lo reanuda */ }
    paintStaticInfo();
    pollWaves();
  } catch (err) {
    state.error = String(err);
    toast(t('t.engineFail', { err: state.error }), 'err');
    $('#st-engine').textContent = 'ERROR';
    $('#st-engine').classList.add('bad');
    console.error(err);
  } finally {
    state.booting = false;
  }
}

function onEngineMessage(e) {
  const m = e.data;
  if (!m) return;
  if (m.t === 'ready') {
    state.ready = true;
    state.sr = m.sampleRate;
    state.memBytes = m.memoryBytes;
    toast(t('t.engineReady'));
    paintStaticInfo();
    if (!state.latUser) applyLatComp(measuredLatencyMs());
    return;
  }
  if (m.t === 'error') {
    state.error = m.message;
    toast(t('t.engineErr', { msg: m.message }), 'err');
    $('#st-engine').textContent = 'ERROR';
    return;
  }
  if (m.t === 'undone') {
    paintUndo(m.depth);
    for (let i = 0; i < TRACKS; i++) waves[i] = null;
    return;
  }
  if (m.t === 'wave') {
    waves[m.track] = m.data;
    return;
  }
  if (m.t === 'meters') {
    state.inPeak = m.inPeak;
    state.mL = m.mL;
    state.mR = m.mR;
    state.progress = m.progress;
    state.loopSeconds = m.loopSeconds;
    state.loopBeats = m.loopBeats;
    state.cpuUs = m.cpuUs;
    state.cpuPct = m.cpuPct || 0;
    state.underruns = m.underruns;
    state.captureTrack = m.captureTrack;
    if (typeof m.undoDepth === 'number') paintUndo(m.undoDepth);
    state.captureLen = m.captureLen;
    for (let i = 0; i < TRACKS; i++) {
      const src = m.tracks[i];
      const tr = state.tracks[i];
      tr.state = src.s;
      tr.peak = src.p;
      tr.pos = src.pos;
      tr.secs = src.secs;
      tr.sync = src.sync === 1;
    }
  }
}

function paintStaticInfo() {
  const kb = state.engineBytes ? `${Math.round(state.engineBytes / 1024)} KB` : '--';
  $('#engine-size').textContent = kb;
  const eng = $('#st-engine');
  if (state.ready) {
    eng.textContent = `RUST/WASM v1.0 · ${kb} · ${t('footer.ready')}`;
    eng.classList.remove('bad');
    eng.classList.add('ok');
    $('#st-sr').textContent = `${state.sr} Hz`;
    const latMs = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
    $('#lat-tag').textContent = `${latMs.toFixed(1)}ms`;
    $('#st-lat').textContent = `${latMs.toFixed(1)} ${t('footer.ms')}`;
    $('#st-mem').textContent = `${(state.memBytes / 1048576).toFixed(1)} MB`;
  }
}

// ------------------------------------------------------------------ entrada de audio
async function acquireMic() {
  // AEC SIEMPRE off: el cancelador del navegador agrega decenas de ms de retardo y colorea
  // la señal (inaceptable para beatbox). El acople se evita no monitoreando la entrada.
  const aec = false;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      echoCancellation: aec,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      latency: 0.01,
    },
  });
  return { stream, aec };
}

function dropMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micSource) { try { micSource.disconnect(); } catch { /* noop */ } }
  micStream = null;
  micSource = null;
}

function micErrorHint(err) {
  const name = (err && err.name) || 'Error';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return t('t.micErrDenied');
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return t('t.micErrNotFound');
  if (name === 'NotReadableError' || name === 'TrackStartError') return t('t.micErrBusy');
  if (name === 'SecurityError') return t('t.micErrSecurity');
  return t('t.micErrOther');
}

async function reportMicError(err) {
  setMicBlocked(true);
  let inputs = null;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    inputs = devs.filter((d) => d.kind === 'audioinput').length;
    // eslint-disable-next-line no-console
    console.info('[mic] dispositivos de entrada visibles:', devs.map((d) => d.kind + ':' + (d.label || '?')));
  } catch { /* enumerate también puede fallar */ }
  const hint = micErrorHint(err);
  const extra = inputs === 0
    ? ` ${t('t.micErrZero')}`
    : inputs === null ? '' : ` ${t('t.micErrInputs', { n: inputs })}`;
  toast(`${err.name || err}: ${hint}${extra}`, 'err');
}

function setMicBlocked(on) {
  state.micBlocked = on;
  const b = $('#btn-mic');
  b.classList.toggle('btn-stop', on);
  b.classList.remove('btn-live');
  paintTransport();
}

// etiquetas del transporte según estado + idioma
function paintTransport() {
  const mic = $('#btn-mic');
  const mon = $('#btn-mon');
  if (!mic || !mon) return;
  const key = state.micBlocked ? 'btn.micBlocked' : state.mic ? 'btn.micLive' : 'btn.micOff';
  mic.textContent = t(key);
  mic.title = t(`${key}.title`);
  mon.textContent = t(state.mon ? 'btn.monOn' : 'btn.monOff');
  mon.title = t(state.mon ? 'btn.monOn.title' : 'btn.monOff.title');
}

// vuelve a escribir los textos de las tiras en el idioma activo
function localizeRack() {
  strips.forEach((st, i) => {
    const el = st.el;
    const name = el.querySelector('.strip-name');
    if (name) name.textContent = t('strip.name', { n: pad2(i + 1) });
    if (st.pill) st.pill.textContent = stLabel(state.tracks[i].state);
    const pad = el.querySelector('[data-pad]');
    if (pad) {
      pad.title = t(`strip.pad.title.${PAD_STATE[state.tracks[i].state]}`, { n: pad2(i + 1) });
      pad.setAttribute('aria-label', pad.title);
    }
    [['data-on="mute"', 'mini.mute'], ['data-on="solo"', 'mini.solo'], ['data-on="rev"', 'mini.rev'],
     ['data-act="stop"', 'mini.stop'], ['data-act="clear"', 'mini.clear'], ['data-act="undo"', 'mini.undo'],
    ].forEach(([sel, key]) => {
      const btn = el.querySelector(`.mini[${sel}]`);
      if (!btn) return;
      btn.textContent = t(key);
      btn.title = t(`${key}.title`);
    });
    const syncBtn = el.querySelector('[data-act="sync"]');
    if (syncBtn) {
      syncBtn.textContent = t(syncBtn.getAttribute('aria-pressed') === 'true' ? 'mini.sync' : 'mini.free');
      syncBtn.title = t('mini.sync.title');
    }
    const fxTitle = el.querySelector('.fx-title');
    if (fxTitle) fxTitle.textContent = t('fx.title');
  });
  paintTransport();
}

async function toggleMic() {
  if (state.mic) {
    dropMic();
    state.mic = false;
    setMicBlocked(false);
    toast(t('t.micOff'));
    return;
  }
  // getUserMedia PRIMERO: el gesto del clic tiene ~5 s de validez y pedir el permiso
  // después de await ensureAudio() (que crea el contexto y baja el wasm) lo dejaba sin
  // activación -> el navegador rechazaba sin mostrar el prompt.
  let acquired = null;
  let acquireErr = null;
  try {
    acquired = await acquireMic();
  } catch (err) {
    acquireErr = err;
  }

  await ensureAudio();
  if (!ctx) {
    if (acquired) acquired.stream.getTracks().forEach((t) => t.stop());
    toast(t('t.engineUnavailable'), 'err');
    return;
  }

  if (acquireErr) {
    await reportMicError(acquireErr);
    console.error(acquireErr);
    return;
  }
  try {
    const { stream } = acquired;
    micStream = stream;
    micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(inputBus);   // lo que graba el motor
    micSource.connect(monitorGain); // monitor directo (apagado por defecto)
    state.mic = true;
    $('#btn-mic').classList.add('btn-live');
    paintTransport();
    const s = micStream.getAudioTracks()[0]?.getSettings() || {};
    const aecOn = s.echoCancellation === true;
    toast(t('t.micOn', {
      sr: s.sampleRate || '?',
      mode: t(aecOn ? 't.micModeAec' : 't.micModeRaw'),
    }), aecOn ? 'info' : 'warn');
    $('#st-engine').title = JSON.stringify(s);
  } catch (err) {
    await reportMicError(err);
    console.error(err);
  }
}

function toggleMonitor() {
  state.mon = !state.mon;
  if (monitorGain) monitorGain.gain.value = state.mon ? 1 : 0;
  const b = $('#btn-mon');
  b.classList.toggle('btn-live', state.mon);
  paintTransport();
  if (state.mon && !state.mic) toast(t('t.monNeedMic'), 'warn');
  else toast(t(state.mon ? 't.monOn' : 't.monOff'), state.mon ? 'warn' : 'info');
}

// ---------------------------------------------------------------- calibración manual
const CAL = { buf: null, offset: 0, listening: false, timer: 0, next: 0, period: 0.5, track: 0 };

function calOffsetMs(v) {
  return Math.max(0, Math.min(300, Math.round(v)));
}

function drawCal() {
  const cv = $('#cal-canvas');
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  g.clearRect(0, 0, W, H);

  for (let ms = 0; ms <= 300; ms += 10) {
    const x = (ms / 300) * W;
    g.strokeStyle = ms % 50 === 0 ? 'rgba(0,255,102,.22)' : 'rgba(0,255,102,.09)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
    g.stroke();
  }
  g.font = '10px ui-monospace, monospace';
  g.fillStyle = 'rgba(0,255,102,.45)';
  for (let ms = 0; ms <= 300; ms += 50) g.fillText(`${ms}`, (ms / 300) * W + 3, H - 3);

  if (CAL.buf && CAL.buf.length) {
    const sr = state.sr || 48000;
    const n = Math.min(CAL.buf.length, Math.round((sr * 300) / 1000));
    const peak = CAL.buf.slice(0, n).reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / Math.max(1, Math.round((sr * 300) / 1000))) * W;
      const y = H / 2 - (CAL.buf[i] / peak) * (H / 2 - 8);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(0,255,102,.85)';
    g.lineWidth = 1.2;
    g.stroke();

    const thr = peak * 0.5;
    let idx = -1;
    for (let i = 0; i < n; i++) if (Math.abs(CAL.buf[i]) >= thr) { idx = i; break; }
    if (idx > 0) {
      const x = (idx / n) * W;
      g.strokeStyle = 'rgba(255,170,0,.55)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
      g.setLineDash([]);
    }
  }

  const lx = (CAL.offset / 300) * W;
  g.strokeStyle = '#38bdf8';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(lx, 0);
  g.lineTo(lx, H);
  g.stroke();
  g.fillStyle = '#38bdf8';
  g.beginPath();
  g.moveTo(lx, 0);
  g.lineTo(lx - 5, 9);
  g.lineTo(lx + 5, 9);
  g.closePath();
  g.fill();
}

function setCalOffset(ms) {
  CAL.offset = calOffsetMs(ms);
  const range = $('#cal-range');
  if (range && Number(range.value) !== CAL.offset) range.value = String(CAL.offset);
  const lbl = $('#cal-ms');
  if (lbl) lbl.textContent = String(CAL.offset);
  drawCal();
}

function calClick(at) {
  if (!ctx) return;
  // click de referencia: seno corto con envolvente (un "tick", no un zumbido)
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1200;
  const dur = 0.04;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.22, at + 0.005);
  g.gain.linearRampToValueAtTime(0, at + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.01);
}

function calStopListening() {
  CAL.listening = false;
  clearTimeout(CAL.timer);
  const b = $('#cal-listen');
  if (b) { b.setAttribute('aria-pressed', 'false'); b.textContent = t('cal.listen'); }
}

function calTick() {
  if (!CAL.listening || !ctx) return;
  calClick(CAL.next + CAL.offset / 1000);
  CAL.next += CAL.period;
  CAL.timer = setTimeout(calTick, Math.max(30, (CAL.next - ctx.currentTime - 0.1) * 1000));
}

function calStartListening() {
  if (!CAL.buf) { toast(t('cal.needPulse'), 'warn'); return; }
  calStopListening();
  CAL.listening = true;
  const b = $('#cal-listen');
  if (b) { b.setAttribute('aria-pressed', 'true'); b.textContent = t('cal.listening'); }
  CAL.period = Math.max(0.35, Math.min(2.5, state.tracks[CAL.track].secs || 0.5));
  CAL.next = (ctx ? ctx.currentTime : 0) + 0.15;
  calTick();
}

function closeCal() {
  calStopListening();
  post({ t: 'cmd', track: CAL.track, cmd: CMD.STOP });
  post({ t: 'cmd', track: CAL.track, cmd: CMD.CLEAR });
  post({ t: 'global', id: G_TRIM, v: msToTrim(state.latComp) });
  $('#cal-modal').classList.remove('open');
}

function openCal() {
  CAL.track = TRACKS - 1;
  CAL.buf = null;
  $('#cal-modal').classList.add('open');
  setCalOffset(state.latComp);
  drawCal();
  $('#cal-record').focus();
}

async function calRecord() {
  if (!(await waitReady(4000))) { toast(t('t.engineStarting'), 'warn'); return; }
  if (!state.mic) { await toggleMic(); if (!state.mic) return; }
  calStopListening();
  for (let i = 0; i < TRACKS; i++) post({ t: 'cmd', track: i, cmd: CMD.STOP });
  post({ t: 'cmd', track: CAL.track, cmd: CMD.CLEAR });
  post({ t: 'global', id: G_TRIM, v: 0 });
  await new Promise((r) => setTimeout(r, 120));

  const delayMs = 200;
  const ok = await new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const prev = node.port.onmessage;
    node.port.onmessage = (e) => {
      if (e.data && e.data.t === 'pingStarted' && e.data.ok) { node.port.onmessage = prev; resolve(true); return; }
      prev && prev(e);
    };
    node.port.postMessage({ t: 'ping', track: CAL.track, delay: delayMs, id });
    setTimeout(() => { node.port.onmessage = prev; resolve(false); }, 3000);
  });
  if (!ok) { toast(t('t.calFail'), 'err'); post({ t: 'global', id: G_TRIM, v: msToTrim(state.latComp) }); return; }

  toast(t('cal.recording'));
  await new Promise((r) => setTimeout(r, delayMs + 700));
  post({ t: 'cmd', track: CAL.track, cmd: CMD.PLAY });
  await new Promise((r) => setTimeout(r, 350));

  const buf = await window.RCPRO.dump(CAL.track, 0, 8192);
  if (!buf || buf.length < 512) { toast(t('t.calFail'), 'err'); return; }
  CAL.buf = buf;
  const peak = buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak < 0.01) { toast(t('t.calSilent'), 'warn'); drawCal(); return; }

  const sr = state.sr || 48000;
  const thr = peak * 0.5;
  let idx = -1;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) >= thr) { idx = i; break; }
  if (idx > 0) setCalOffset((idx / sr) * 1000 - delayMs);
  drawCal();
  toast(t('cal.ready'));
  calStartListening();
}

function applyCal() {
  const ms = CAL.offset;
  applyLatComp(ms, { fromUser: true });
  try { localStorage.setItem('mrboosh.lat', String(ms)); } catch { /* modo privado */ }
  if (latKnobRef) latKnobRef.set(ms, true);
  toast(t('cal.applied', { ms }), 'ok');
  closeCal();
}

// ------------------------------------------------------------------ fusión de pistas
let mergePending = null;

function mergeTracks(src, dst) {
  return new Promise((resolve) => {
    if (!node || src === dst) { resolve(false); return; }
    const id = Math.random().toString(36).slice(2);
    const prev = node.port.onmessage;
    node.port.onmessage = (e) => {
      if (e.data && e.data.t === 'merged' && e.data.id === id) {
        node.port.onmessage = prev;
        resolve(!!e.data.ok);
        return;
      }
      prev && prev(e);
    };
    node.port.postMessage({ t: 'merge', id, src, dst });
    setTimeout(() => { node.port.onmessage = prev; resolve(false); }, 3000);
  });
}

function openMergeModal(src, dst) {
  mergePending = { src, dst };
  $('#merge-text').innerHTML = t('modal.merge.body', { a: pad2(src + 1), b: pad2(dst + 1) });
  $('#merge-modal').classList.add('open');
  $('#merge-ok').focus();
}

function closeMergeModal() {
  mergePending = null;
  $('#merge-modal').classList.remove('open');
}

async function confirmMerge() {
  const job = mergePending;
  closeMergeModal();
  if (!job) return;
  const ok = await mergeTracks(job.src, job.dst);
  if (ok) {
    waves[job.src] = null;
    toast(t('t.merged', { a: pad2(job.src + 1), b: pad2(job.dst + 1) }));
    toast(t('t.mergedNorm'));
  } else {
    toast(t('t.mergeFailed'), 'warn');
  }
}

// ------------------------------------------------------------------ undo
let undoBusy = false;

function undoLast(where = '') {
  if (!node || undoBusy) return;
  undoBusy = true;
  node.port.postMessage({ t: 'undo' });
  setTimeout(() => { undoBusy = false; }, 120);
  toast(where ? t('t.undoWhere', { where }) : t('t.undo'));
}

function paintUndo(depth) {
  const btn = $('#btn-undo');
  if (!btn) return;
  $('#undo-badge').textContent = String(depth);
  btn.disabled = depth === 0;
}

// ------------------------------------------------------------------ anti-acople / latencia
function measuredLatencyMs() {
  if (!ctx) return 0;
  return ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
}

function msToTrim(ms) {
  return Math.max(0, Math.min(300, Math.round(ms)));
}

function applyLatComp(ms, { fromUser = false } = {}) {
  state.latComp = Math.round(ms);
  if (fromUser) state.latUser = true;
  post({ t: 'global', id: G.LATCOMP, v: state.latComp });
  // el mismo valor recorta el inicio de la toma y alarga el cierre: no se pierde nada
  post({ t: 'global', id: G_TRIM, v: msToTrim(state.latComp) });
  const el = $('#st-comp');
  if (el) el.textContent = `${state.latComp} ms`;
  if (latKnobRef && !fromUser) latKnobRef.set(state.latComp, true);
}

// ---------------------------------------------------------------- calibración real
// Emite un pulso DENTRO del motor y lo vuelve a capturar por el micrófono: el desfase
// medido es la latencia de ida y vuelta de verdad (no la estimación del navegador).
async function calibrateLatency() {
  const track = TRACKS - 1;
  if (!(await waitReady(4000))) { toast(t('t.engineStarting'), 'warn'); return; }
  if (!state.mic) { await toggleMic(); if (!state.mic) return; }

  const savedTrim = state.latComp;
  post({ t: 'global', id: G_TRIM, v: 0 }); // sin recorte: los índices quedan exactos
  for (let i = 0; i < TRACKS; i++) post({ t: 'cmd', track: i, cmd: CMD.STOP });
  post({ t: 'cmd', track, cmd: CMD.CLEAR });
  await new Promise((r) => setTimeout(r, 120));

  const delayMs = 200;
  const started = await new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const prev = node.port.onmessage;
    node.port.onmessage = (e) => {
      if (e.data && e.data.t === 'pingStarted' && e.data.ok) { node.port.onmessage = prev; resolve(true); return; }
      prev && prev(e);
    };
    node.port.postMessage({ t: 'ping', track, delay: delayMs, id });
    setTimeout(() => { node.port.onmessage = prev; resolve(false); }, 3000);
  });
  if (!started) {
    toast(t('t.calFail'), 'err');
    post({ t: 'global', id: G_TRIM, v: msToTrim(savedTrim) });
    return;
  }

  await new Promise((r) => setTimeout(r, delayMs + 900));
  post({ t: 'cmd', track, cmd: CMD.PLAY }); // cierra la toma (con cola 0: trim estaba en 0)
  await new Promise((r) => setTimeout(r, 400));

  const sr = state.sr || 48000;
  const buf = await window.RCPRO.dump(track, 0, 8192);
  post({ t: 'cmd', track, cmd: CMD.CLEAR });
  if (!buf || buf.length < 1024) {
    toast(t('t.calFail'), 'err');
    post({ t: 'global', id: G_TRIM, v: msToTrim(savedTrim) });
    return;
  }

  const peak = buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak < 0.01) {
    toast(t('t.calSilent'), 'warn');
    post({ t: 'global', id: G_TRIM, v: msToTrim(savedTrim) });
    return;
  }
  // primer cruce por encima de la mitad del pico
  const thr = peak * 0.5;
  let idx = -1;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) >= thr) { idx = i; break; }
  const measured = ((idx - (delayMs / 1000) * sr) / sr) * 1000;
  if (!(measured > 0 && measured < 600)) {
    toast(t('t.calRange', { ms: measured.toFixed(0) }), 'warn');
    post({ t: 'global', id: G_TRIM, v: msToTrim(savedTrim) });
    return;
  }
  const rounded = Math.round(measured);
  applyLatComp(rounded, { fromUser: true });
  if (latKnobRef) latKnobRef.set(rounded, true);
  toast(t('t.calDone', { ms: rounded }), 'ok');
}

async function reacquireMic() {
  if (!state.mic || !ctx) return;
  dropMic();
  try {
    const { stream } = await acquireMic();
    micStream = stream;
    micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(inputBus);
    micSource.connect(monitorGain);
    const s = micStream.getAudioTracks()[0]?.getSettings() || {};
    toast(t('t.micReconnected', { mode: t(s.echoCancellation ? 't.micModeAec' : 't.micModeRaw') }), 'info');
  } catch (err) {
    state.mic = false;
    $('#btn-mic').classList.remove('btn-live');
    paintTransport();
    toast(t('t.micReconnectFail'), 'err');
    console.error(err);
  }
}

async function toggleSpeaker() {
  state.speaker = !state.speaker;
  localStorage.setItem('rcpro.speaker', state.speaker ? '1' : '0');
  $('#btn-speaker').setAttribute('aria-pressed', String(state.speaker));
  post({ t: 'global', id: G.SPEAKER, v: state.speaker ? 1 : 0 });
  if (state.mic) await reacquireMic();
  toast(t(state.speaker ? 't.antiOn' : 't.antiOff'), state.speaker ? 'info' : 'warn');
}

async function waitReady(ms = 2000) {
  const t0 = Date.now();
  while (!state.ready && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 30));
  return state.ready;
}

// ------------------------------------------------------------------ generadores de prueba
function ensureNoise() {
  if (noiseBuf || !ctx) return;
  const len = Math.floor(ctx.sampleRate * 0.5);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
}

function drum(type) {
  if (!ctx) return;
  ensureNoise();
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(inputBus);
  out.connect(monitorBus);

  const noise = (dur, hp, gain, decay) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(now); src.stop(now + dur);
  };
  const tone = (f0, f1, dur, gain, type2 = 'sine') => {
    const o = ctx.createOscillator();
    o.type = type2;
    o.frequency.setValueAtTime(f0, now);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g); g.connect(out);
    o.start(now); o.stop(now + dur);
  };

  if (type === 'kick') { tone(140, 42, 0.28, 1.0); tone(320, 60, 0.04, 0.5, 'triangle'); }
  else if (type === 'snare') { noise(0.16, 1400, 0.7, 0.14); tone(220, 170, 0.09, 0.35, 'triangle'); }
  else if (type === 'hat') { noise(0.06, 7000, 0.4, 0.05); }
  else if (type === 'clap') { noise(0.1, 1100, 0.45, 0.03); setTimeout(() => noise(0.1, 1100, 0.4, 0.03), 18); setTimeout(() => noise(0.14, 1100, 0.4, 0.08), 36); }

  if (state.captureTrack >= 0 || state.tracks.some((t) => t.state === ST.REC || t.state === ST.DUB)) {
    toast(t('t.drumSent', { type: type.toUpperCase() }), 'rec');
  }
}

function synthNote(freq) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const o = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  o.type = 'sawtooth';
  o2.type = 'triangle';
  o.frequency.value = freq;
  o2.frequency.value = freq * 2.005;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(4200, now);
  f.frequency.exponentialRampToValueAtTime(700, now + 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.28, now + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
  const mix = ctx.createGain();
  mix.gain.value = 0.6;
  o.connect(f); o2.connect(f); f.connect(g); g.connect(mix);
  mix.connect(inputBus);
  mix.connect(monitorBus);
  o.start(now); o2.start(now);
  o.stop(now + 0.75); o2.stop(now + 0.75);
  toast(t('t.synthSent', { hz: freq.toFixed(0) }));
}

// ------------------------------------------------------------------ render
function drawStrip(i) {
  const s = strips[i];
  const tr = state.tracks[i];
  const cv = s.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);

  // línea central
  g.strokeStyle = 'rgba(255,255,255,.06)';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

  const data = waves[i];
  const barW = w / 96;
  const color = tr.state === ST.REC ? '#ff4f63' : tr.state === ST.DUB ? '#ffb724'
    : tr.state === ST.PLAY ? '#22dd84' : tr.state === ST.STOP ? '#6b7280' : '#2f2f39';

  if (data && data.length) {
    g.fillStyle = color;
    const mid = h / 2;
    for (let p = 0; p < data.length; p++) {
      const amp = Math.min(1, data[p]) * (mid - 1.5);
      const x = p * barW;
      const bh = Math.max(1, amp * 1.9);
      g.fillRect(x, mid - bh / 2, Math.max(1, barW - 0.8), bh);
    }
  } else {
    g.fillStyle = 'rgba(255,255,255,.05)';
    for (let p = 0; p < 96; p += 2) g.fillRect(p * barW, h / 2 - 1, Math.max(1, barW - 0.8), 2);
  }

  // cabezal del loop
  const ownLen = tr.secs > 0 ? tr.secs : state.loopSeconds;
  if (ownLen > 0 && tr.state !== ST.EMPTY) {
    const x = (tr.pos || 0) * w;
    g.strokeStyle = tr.state === ST.STOP ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.75)';
    g.lineWidth = Math.max(1, dpr);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
}

function render() {
  for (let i = 0; i < TRACKS; i++) {
    const s = strips[i];
    const tr = state.tracks[i];

    // estado
    if (s.lastSync !== tr.sync) {
      s.lastSync = tr.sync;
      const sb = s.el.querySelector('[data-act="sync"]');
      if (sb) { sb.setAttribute('aria-pressed', String(tr.sync)); sb.textContent = tr.sync ? 'Sync' : 'Libre'; }
    }
    if (s.lastState !== tr.state) {
      s.lastState = tr.state;
      s.pill.textContent = stLabel(tr.state);
      s.pill.className = 'pill' + (ST_KEY[tr.state] !== 'empty' ? ' ' + ST_KEY[tr.state] : '');
      s.el.dataset.state = ST_KEY[tr.state];
      s.pad.dataset.state = ST_KEY[tr.state];
      s.padLabel.textContent = PAD_LABEL[tr.state];
      s.pad.title = t(`strip.pad.title.${PAD_STATE[tr.state]}`, { n: pad2(i + 1) });
      s.pad.setAttribute('aria-label', s.pad.title);
    }
    s.padSub.textContent = tr.state === ST.REC && state.captureTrack === i
      ? `${(state.captureLen / (state.sr || 48000)).toFixed(1)}s`
      : tr.state === ST.EMPTY ? t(tr.sync ? 'pad.sub.empty' : 'pad.sub.free') : `${(tr.secs || state.loopSeconds).toFixed(1)}s`;

    // VU con caída suave
    const target = Math.min(1, tr.peak * 1.6);
    peakSmooth[i] = Math.max(target, peakSmooth[i] * 0.86);
    if (peakSmooth[i] >= peakHold[i]) { peakHold[i] = peakSmooth[i]; holdTimer[i] = 26; }
    else if (holdTimer[i] > 0) holdTimer[i] -= 1;
    else peakHold[i] = Math.max(0, peakHold[i] - 0.012);
    s.vu.style.width = `${(peakSmooth[i] * 100).toFixed(1)}%`;

    drawStrip(i);
  }

  // medidores globales
  const inP = Math.min(1, state.inPeak * 1.6);
  $('#vu-in .vu-fill').style.width = `${(inP * 100).toFixed(1)}%`;
  const outP = Math.min(1, Math.max(state.mL, state.mR) * 1.6);
  $('#vu-out .vu-fill').style.width = `${(outP * 100).toFixed(1)}%`;
  // LED de clip: el limitador del master entró en acción en los últimos ~700 ms
  if (Math.max(state.mL, state.mR) >= 0.985) clipHold = 42;
  else if (clipHold > 0) clipHold -= 1;
  $('#clip-led').classList.toggle('on', clipHold > 0);

  // OLED
  const capturing = state.captureTrack >= 0;
  $('#oled-bpm').textContent = String(Math.round(state.bpm));
  $('#oled-loop').textContent = capturing
    ? `${(state.captureLen / (state.sr || 48000)).toFixed(2)}s`
    : state.loopSeconds > 0 ? `${state.loopSeconds.toFixed(2)}s` : '00.00s';
  $('#oled-bars').textContent = state.loopBeats > 0 ? `${(state.loopBeats / 4).toFixed(2)}` : '--';
  const oledState = $('#oled-state');
  const recCount = state.tracks.filter((t) => t.state === ST.REC || t.state === ST.DUB).length;
  const playCount = state.tracks.filter((t) => t.state === ST.PLAY).length;
  let label = t('state.idle');
  oledState.className = 'value small';
  if (capturing) { label = t('state.rec'); oledState.classList.add('rec'); }
  else if (recCount > 0) { label = t('state.dub'); oledState.classList.add('warn'); }
  else if (playCount > 0) { label = t('state.play'); oledState.classList.add('small'); }
  else if (state.loopSeconds > 0) label = t('state.stop');
  oledState.textContent = label;
  $('#oled-bar').classList.toggle('rec', capturing);
  if (!capturing) $('#loop-fill').style.width = `${(state.progress * 100).toFixed(1)}%`;

  // footer
  $('#st-cpu').textContent = state.cpuUs
    ? `${state.cpuPct.toFixed(1)}% · ${state.cpuUs.toFixed(0)}µs`
    : '--';
  $('#st-cpu').className = state.cpuPct > 60 ? 'bad' : 'ok';

  requestAnimationFrame(render);
}

// ------------------------------------------------------------------ waves polling
function pollWaves() {
  setInterval(() => {
    if (!state.ready || document.hidden) return;
    for (let i = 0; i < TRACKS; i++) {
      if (state.tracks[i].state !== ST.EMPTY) post({ t: 'wave', track: i });
    }
  }, 420);
}

// La latencia de salida real solo aparece cuando el grafo suena: se refresca en vivo.
setInterval(() => {
  if (!state.ready || !ctx) return;
  const ms = measuredLatencyMs();
  if (ms <= 0) return;
  $('#lat-tag').textContent = `${ms.toFixed(1)}ms`;
  $('#st-lat').textContent = `${ms.toFixed(1)} ${t('footer.msTotal')}`;
  if (!state.latUser) applyLatComp(ms);
  // si el navegador está usando un buffer grande, avisarlo una vez
  if (!state.latWarned && ms > 30) {
    state.latWarned = true;
    toast(t('t.latHigh', { ms: Math.round(ms) }), 'warn');
  }
}, 1000);

// ------------------------------------------------------------------ wiring
async function ensureAudio() {
  if (!state.ready) await boot();
  if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* noop */ } }
}

function wire() {
  $('#btn-all-start').addEventListener('click', async () => {
    await ensureAudio();
    if (!state.ready) return;
    if (state.captureTrack >= 0) post({ t: 'cmd', track: state.captureTrack, cmd: CMD.PLAY });
    for (let i = 0; i < TRACKS; i++) {
      if (i !== state.captureTrack && state.tracks[i].state !== ST.EMPTY) {
        post({ t: 'cmd', track: i, cmd: CMD.PLAY });
      }
    }
    toast(t('t.allStart'));
  });

  $('#btn-all-stop').addEventListener('click', async () => {
    await ensureAudio();
    for (let i = 0; i < TRACKS; i++) post({ t: 'cmd', track: i, cmd: CMD.STOP });
    toast(t('t.allStop'));
  });

  $('#btn-undo').addEventListener('click', () => undoLast());

  $('#btn-mic').addEventListener('click', toggleMic);
  $('#btn-mon').addEventListener('click', toggleMonitor);

  createKnob({
    mount: $('#knob-click'), label: 'Click', min: 0, max: 1, value: 0.32, def: 0.32, step: 0.02,
    titleKey: 'knob.click.title',
    size: 40, format: (v) => `${Math.round(v * 100)}`,
    onChange: (v) => post({ t: 'global', id: G.CLICK, v }),
  });

  $('#btn-metro').addEventListener('click', async (e) => {
    await ensureAudio();
    state.metro = !state.metro;
    e.currentTarget.setAttribute('aria-pressed', String(state.metro));
    post({ t: 'global', id: G.METRO, v: state.metro ? 1 : 0 });
    toast(state.metro ? t('t.metroOn', { bpm: Math.round(state.bpm) }) : t('t.metroOff'));
  });

  $('#btn-speaker').setAttribute('aria-pressed', String(state.speaker));
  $('#btn-speaker').addEventListener('click', toggleSpeaker);

  latKnobRef = createKnob({
    mount: $('#knob-lat'), label: 'Lat comp', min: 0, max: 150, value: 0, def: 0, step: 1,
    titleKey: 'knob.lat.title',
    size: 40, format: (v) => `${Math.round(v)}ms`,
    onChange: (v) => applyLatComp(v, { fromUser: true }),
  });
  if (latKnobRef && !latKnobRef.el.title) latKnobRef.el.title = t('knob.lat.title');

  $('#btn-cal').addEventListener('click', calibrateLatency);

  $('#btn-quant').addEventListener('click', (e) => {
    state.quant = !state.quant;
    e.currentTarget.setAttribute('aria-pressed', String(state.quant));
    post({ t: 'global', id: G.QUANT, v: state.quant ? 1 : 0 });
    post({ t: 'global', id: G.SPEAKER, v: state.speaker ? 1 : 0 });
    toast(t(state.quant ? 't.snapOn' : 't.snapOff'));
  });

  createKnob({
    mount: $('#knob-master'), label: 'Master', min: 0, max: 1.2, value: 0.85, def: 0.85, step: 0.02,
    titleKey: 'knob.master.title',
    size: 52, format: (v) => `${Math.round(v * 100)}`,
    onChange: (v) => { state.master = v; post({ t: 'global', id: G.MASTER, v }); },
  });

  const bpmKnob = createKnob({
    mount: $('#knob-bpm'), label: 'BPM', min: 40, max: 240, value: 120, def: 120, step: 1,
    size: 52, format: (v) => String(Math.round(v)),
    onChange: (v) => {
      state.bpm = v;
      post({ t: 'global', id: G.BPM, v });
      $('#oled-bpm').textContent = String(Math.round(v));
    },
  });
  bpmKnob.el.title = 'Tempo: metrónomo, snap y compases del OLED';

  createKnob({
    mount: $('#knob-drive'), label: 'Drive', min: 1, max: 12, value: 1, def: 1, step: 0.1,
    size: 44, format: (v) => `${v.toFixed(1)}x`,
    onChange: (v) => { state.drive = v; post({ t: 'global', id: G.DRIVE, v }); },
  });

  // calibración manual
  $('#btn-cal-manual').addEventListener('click', openCal);
  $('#cal-record').addEventListener('click', calRecord);
  $('#cal-listen').addEventListener('click', () => (CAL.listening ? calStopListening() : calStartListening()));
  $('#cal-cancel').addEventListener('click', closeCal);
  $('#cal-apply').addEventListener('click', applyCal);
  $('#cal-range').addEventListener('input', (e) => setCalOffset(Number(e.target.value)));
  {
    const cv = $('#cal-canvas');
    let dragging = false;
    const fromEvent = (e) => {
      const r = cv.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      setCalOffset(x * 300);
    };
    cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); fromEvent(e); });
    cv.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
    cv.addEventListener('pointerup', () => { dragging = false; });
    cv.addEventListener('pointercancel', () => { dragging = false; });
  }
  window.addEventListener('keydown', (e) => {
    if (!$('#cal-modal').classList.contains('open')) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setCalOffset(CAL.offset + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
  });
  $('#cal-modal').addEventListener('click', (e) => { if (e.target.id === 'cal-modal') closeCal(); });

  $('#merge-ok').addEventListener('click', confirmMerge);
  $('#merge-cancel').addEventListener('click', closeMergeModal);
  $('#merge-modal').addEventListener('click', (e) => { if (e.target.id === 'merge-modal') closeMergeModal(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#merge-modal').classList.contains('open')) closeMergeModal();
  });

  document.querySelectorAll('[data-drum]').forEach((b) => {
    b.addEventListener('click', () => ensureAudio().then(() => drum(b.dataset.drum)));
  });
  document.querySelectorAll('[data-note]').forEach((b) => {
    b.addEventListener('click', () => ensureAudio().then(() => synthNote(parseFloat(b.dataset.note))));
  });
  localizeGenerators();

  // primer gesto: arrancar el contexto (política de autoplay)
  const kick = () => { ensureAudio(); window.removeEventListener('pointerdown', kick); };
  window.addEventListener('pointerdown', kick, { once: false });

  window.addEventListener('resize', () => { for (let i = 0; i < TRACKS; i++) drawStrip(i); });
}

// API de inspección (útil para pruebas automatizadas y para depurar)
window.RCPRO = {
  get ready() { return state.ready; },
  state,
  waves,
  cmd: (track, cmd) => post({ t: 'cmd', track, cmd }),
  merge: (src, dst) => mergeTracks(src, dst),
  undo: () => { node && node.port.postMessage({ t: 'undo' }); },
  debug: (track = 0) => new Promise((resolve) => {
    if (!node) { resolve(null); return; }
    const id = Math.random().toString(36).slice(2);
    const prev = node.port.onmessage;
    node.port.onmessage = (e) => { if (e.data && e.data.t === 'debug' && e.data.id === id) { node.port.onmessage = prev; resolve(e.data); return; } prev && prev(e); };
    node.port.postMessage({ t: 'debug', id, track });
    setTimeout(() => { node.port.onmessage = prev; resolve(null); }, 1500);
  }),
  openMergeModal, confirmMerge, closeMergeModal,
  openCal, closeCal, setCalOffset, applyCal, calRecord,
  cal: () => ({ offset: CAL.offset, listening: CAL.listening, hasBuf: !!CAL.buf }),
  param: (track, id, v) => post({ t: 'param', track, id, v }),
  global: (id, v) => post({ t: 'global', id, v }),
  CMD, P, G, ST,
  node: () => node,
  ctx: () => ctx,
  // muestras crudas del buffer de una pista (para medir distorsión real)
  dump: (track, start = 0, len = 4096) => new Promise((resolve) => {
    if (!node) { resolve(null); return; }
    const id = Math.random().toString(36).slice(2);
    const prev = node.port.onmessage;
    node.port.onmessage = (e) => {
      if (e.data && e.data.t === 'copy' && e.data.id === id) {
        node.port.onmessage = prev;
        resolve(e.data.data ? Array.from(e.data.data) : null);
        return;
      }
      prev && prev(e);
    };
    node.port.postMessage({ t: 'copy', id, track, start, len });
    setTimeout(() => { node.port.onmessage = prev; resolve(null); }, 2000);
  }),
  telemetry: () => ({
    ready: state.ready,
    error: state.error,
    sr: state.sr,
    engineBytes: state.engineBytes,
    memBytes: state.memBytes,
    loopSeconds: state.loopSeconds,
    loopBeats: state.loopBeats,
    progress: state.progress,
    inPeak: state.inPeak,
    mL: state.mL,
    mR: state.mR,
    cpuUs: state.cpuUs,
    cpuPct: state.cpuPct,
    captureTrack: state.captureTrack,
    captureLen: state.captureLen,
    speaker: state.speaker,
    latComp: state.latComp,
    tracks: state.tracks.map((t) => ({ state: t.state, peak: t.peak, secs: t.secs, pos: t.pos, sync: t.sync })),
    audio: ctx ? { state: ctx.state, sr: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency } : null,
  }),
};

// ---------------------------------------------------------------- atajos (beatbox: manos en el mic)
function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.target?.closest('.knob')) return;

    // Ctrl/Cmd+Z = deshacer
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLast();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // 1..5 -> pad de esa pista
    if (/^[1-5]$/.test(e.key)) {
      e.preventDefault();
      ensureAudio().then(() => padPress(Number(e.key) - 1));
      return;
    }
    switch (e.key.toLowerCase()) {
      case '0':
        e.preventDefault();
        for (let i = 0; i < TRACKS; i++) post({ t: 'cmd', track: i, cmd: CMD.STOP });
        toast(t('t.allStop'));
        break;
      case 'u':
        e.preventDefault();
        undoLast();
        break;
      case 'm':
        e.preventDefault();
        $('#btn-metro').click();
        break;
      case ' ':
        e.preventDefault();
        if (state.tracks.some((tr) => tr.state === ST.PLAY || tr.state === ST.REC || tr.state === ST.DUB)) {
          $('#btn-all-stop').click();
        } else {
          $('#btn-all-start').click();
        }
        break;
      default:
        break;
    }
  });
}

// tooltips de los generadores que llevan la frecuencia en el texto
function localizeGenerators() {
  document.querySelectorAll('[data-note]').forEach((b) => {
    b.title = t('synth.note.title', { hz: Math.round(parseFloat(b.dataset.note)) });
  });
}

// LED de "sin señal": beatboxer con el mic muteado o mal ruteado
function watchSignal() {
  const led = $('#signal-led');
  if (!led) return;
  const now = performance.now();
  if (!state.mic) { led.hidden = true; state.silentSince = 0; return; }
  if (state.inPeak > 0.004) { led.hidden = true; state.silentSince = 0; return; }
  if (!state.silentSince) state.silentSince = now;
  led.hidden = now - state.silentSince < 2500;
}

// ---------------------------------------------------------------- idioma
function bindLang() {
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.addEventListener('click', () => {
      applyLang(b.dataset.lang, { persist: true });
      toast(t('lang.label') + ': ' + b.dataset.lang.toUpperCase());
    });
  });
  try {
    const saved = Number(localStorage.getItem('mrboosh.lat'));
    if (Number.isFinite(saved) && saved > 0) {
      applyLatComp(saved, { fromUser: true });
      if (latKnobRef) latKnobRef.set(saved, true);
    }
  } catch { /* modo privado */ }

  onLangChange(() => {
    localizeRack();
    localizeGenerators();
    // textos que también dependen del estado del motor
    const eng = $('#st-engine');
    if (eng && !state.ready) eng.textContent = t('footer.loading');
    if (state.ready) paintStaticInfo();
    if (state.tracks) {
      strips.forEach((st, i) => { if (st.pill) st.pill.textContent = stLabel(state.tracks[i].state); });
    }
  });
}

applyLang(getLang());
bindLang();
buildRack();
wire();
bindShortcuts();
render();
setInterval(watchSignal, 400);
// arranca el motor al cargar (el AudioContext se reanuda con el primer gesto)
boot();
