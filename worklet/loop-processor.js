// RC-PRO STUDIO — AudioWorklet that hosts the Rust/WASM loop engine.
//
// Why no wasm-bindgen glue here: an AudioWorkletGlobalScope has no `fetch` and no
// ES module loader, so the bindgen bootstrap (`import.meta.url` + fetch + init) can't
// run. We fetch the .wasm on the main thread, send the ArrayBuffer in processorOptions
// and instantiate the raw module inside the audio thread. The module has zero imports,
// so `WebAssembly.instantiate(bytes, {})` is enough.
//
// Buffers live in wasm memory: main thread <-> audio thread never shares Float32Arrays
// except through the pointers returned by le_alloc (no allocation inside process()).

const BLOCK = 128;

// performance.now() no está garantizado en AudioWorkletGlobalScope
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const WAVE_POINTS = 96;
const DUMP_MAX = 8192;

class LoopProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.ready = false;
    this.failed = null;
    this.trackCount = opts.tracks || 5;
    this.meterTick = 0;
    this.meterEvery = 6;
    this.cpuAcc = 0;
    this.cpuBlocks = 0;
    this.cpuUs = 0;
    this.cpuPct = 0;
    this.underruns = 0;
    this.wavePoints = WAVE_POINTS;
    this.port.onmessage = (e) => this.onMessage(e.data);

    const bytes = opts.wasmBytes;
    if (!bytes) {
      this.failed = 'no wasm bytes';
      this.port.postMessage({ t: 'error', message: 'No se recibió el binario WebAssembly.' });
      return;
    }
    if (typeof WebAssembly === 'undefined') {
      this.failed = 'WebAssembly no disponible en AudioWorklet';
      this.port.postMessage({ t: 'error', message: this.failed });
      return;
    }

    WebAssembly.instantiate(bytes, {})
      .then(({ instance }) => {
        const le = instance.exports;
        this.le = le;
        le.le_init(sampleRate | 0, opts.maxSeconds || 30);
        // Un bloque de 128 frames por llamada; reservamos para 128 y reusamos vistas.
        this.ptrIn = le.le_alloc(BLOCK * 4);
        this.ptrL = le.le_alloc(BLOCK * 4);
        this.ptrR = le.le_alloc(BLOCK * 4);
        this.ptrWave = le.le_alloc(WAVE_POINTS * 4);
        this.ptrDump = le.le_alloc(DUMP_MAX * 4);
        this.memory = le.memory;
        this.refreshViews();
        this.ready = true;
        this.port.postMessage({
          t: 'ready',
          sampleRate: sampleRate | 0,
          version: le.le_version(),
          memoryBytes: le.memory.buffer.byteLength,
          maxSeconds: opts.maxSeconds || 30,
        });
      })
      .catch((err) => {
        this.failed = String(err);
        this.port.postMessage({ t: 'error', message: 'WebAssembly.instantiate: ' + String(err) });
      });
  }

  refreshViews() {
    const buf = this.memory.buffer;
    if (this._memBuf === buf) return;
    this._memBuf = buf;
    this.viewIn = new Float32Array(buf, this.ptrIn, BLOCK);
    this.viewL = new Float32Array(buf, this.ptrL, BLOCK);
    this.viewR = new Float32Array(buf, this.ptrR, BLOCK);
    this.viewWave = new Float32Array(buf, this.ptrWave, WAVE_POINTS);
    this.viewDump = new Float32Array(buf, this.ptrDump, DUMP_MAX);
  }

  onMessage(msg) {
    if (!msg || !this.ready) return;
    const le = this.le;
    switch (msg.t) {
      case 'cmd':
        le.le_command(msg.track | 0, msg.cmd | 0);
        break;
      case 'param':
        le.le_set_param(msg.track | 0, msg.id | 0, +msg.v);
        break;
      case 'global':
        le.le_set_global(msg.id | 0, +msg.v);
        break;
      case 'wave': {
        // Se calcula acá (el buffer vive en wasm) y se copia al hilo principal.
        const track = msg.track | 0;
        const n = le.le_waveform(track, this.ptrWave, WAVE_POINTS);
        if (n > 0) {
          this.port.postMessage({ t: 'wave', track, data: this.viewWave.slice(0, n) });
        } else {
          this.port.postMessage({ t: 'wave', track, data: null });
        }
        break;
      }
      case 'copy': {
        // diagnóstico: muestras crudas del buffer de una pista
        const len = Math.min(msg.len | 0, DUMP_MAX);
        const n = le.le_copy(msg.track | 0, this.ptrDump, msg.start | 0, len);
        this.port.postMessage({ t: 'copy', id: msg.id, track: msg.track, data: n > 0 ? this.viewDump.slice(0, n) : null });
        break;
      }
      case 'debug': {
        this.port.postMessage({
          t: 'debug',
          id: msg.id,
          v: [le.le_trim_debug(0), le.le_trim_debug(1), le.le_trim_debug(2), le.le_trim_debug(3),
              le.le_trim_debug(4), le.le_trim_debug(5), le.le_trim_debug(6)],
          state: le.le_track_state(msg.track | 0),
          cap: le.le_capture_track(),
        });
        break;
      }
      case 'ping': {
        const ok = le.le_ping_start(msg.track | 0, msg.delay | 0) === 1;
        this.port.postMessage({ t: 'pingStarted', ok, track: msg.track, pos: le.le_ping_capture_pos() });
        break;
      }
      case 'undo': {
        const ok = le.le_undo() === 1;
        this.port.postMessage({ t: 'undone', ok, depth: le.le_undo_depth() });
        break;
      }
      case 'merge': {
        const ok = le.le_merge(msg.src | 0, msg.dst | 0) === 1;
        this.port.postMessage({ t: 'merged', id: msg.id, src: msg.src, dst: msg.dst, ok });
        break;
      }
      case 'mute-all':
        for (let i = 0; i < this.trackCount; i++) le.le_command(i, 4);
        break;
      default:
        break;
    }
  }

  publishMeters() {
    const le = this.le;
    const tracks = [];
    for (let i = 0; i < this.trackCount; i++) {
      tracks.push({
        s: le.le_track_state(i),
        p: le.le_track_peak(i),
        pos: le.le_track_progress(i),
        secs: le.le_track_seconds(i),
        sync: le.le_track_sync(i),
      });
    }
    const msg = {
      t: 'meters',
      inPeak: le.le_input_peak(),
      mL: le.le_master_peak_l(),
      mR: le.le_master_peak_r(),
      progress: le.le_loop_progress(),
      loopSeconds: le.le_loop_seconds(),
      loopBeats: le.le_loop_beats(),
      captureLen: le.le_capture_len(),
      captureTrack: le.le_capture_track(),
      bpm: le.le_bpm(),
      undoDepth: le.le_undo_depth(),
      cpuUs: this.cpuUs,
      cpuPct: this.cpuPct,
      underruns: this.underruns,
      tracks,
    };
    le.le_reset_meters();
    this.port.postMessage(msg);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];

    if (!this.ready) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }

    const t0 = nowMs();
    this.refreshViews();

    const inp = inputs[0];
    if (inp && inp[0] && inp[0].length >= BLOCK) {
      this.viewIn.set(inp[0]);
    } else {
      this.viewIn.fill(0);
    }

    this.le.le_process(this.ptrIn, this.ptrL, this.ptrR, BLOCK);

    outL.set(this.viewL);
    if (outR !== outL) outR.set(this.viewR);

    // CPU: promedio sobre 256 bloques (~0.68 s a 48 kHz)
    this.cpuAcc += nowMs() - t0;
    this.cpuBlocks++;
    if (this.cpuBlocks >= 256) {
      const audioMs = (this.cpuBlocks * BLOCK * 1000) / sampleRate;
      this.cpuUs = (this.cpuAcc * 1000) / this.cpuBlocks;
      this.cpuPct = (this.cpuAcc / audioMs) * 100;
      this.cpuAcc = 0;
      this.cpuBlocks = 0;
    }

    if (++this.meterTick >= this.meterEvery) {
      this.meterTick = 0;
      this.publishMeters();
    }
    return true;
  }
}

registerProcessor('loop-processor', LoopProcessor);
