/**
 * Fully procedural audio — no sample files ship with the game.
 *
 * Everything is synthesised from oscillators and one shared noise buffer,
 * routed through three buses (sfx / music / ui) into a limiter. The music
 * layer is adaptive: `setIntensity()` crossfades a calm pad into a driving
 * arp + drum pattern as a wave ramps up.
 */

type Bus = 'sfx' | 'music' | 'ui';

export type SfxName =
  | 'shoot' | 'shootHeavy' | 'laser' | 'tesla'
  | 'hit' | 'hitArmor' | 'kill' | 'explode' | 'explodeBig'
  | 'mine' | 'mineDone' | 'build' | 'sell' | 'repair'
  | 'pickup' | 'pickupEssence' | 'levelUp'
  | 'waveStart' | 'bossRoar' | 'coreHit' | 'coreCritical' | 'gameOver' | 'victory'
  | 'uiHover' | 'uiClick' | 'uiBack' | 'error' | 'achievement';

const MAX_VOICES = 28;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<Bus, GainNode>;
  private noise!: AudioBuffer;
  private voices = 0;
  private started = false;

  /** Per-bus user volume, 0..1. Persisted by the save layer. */
  volumes: Record<Bus, number> = { sfx: 0.85, music: 0.5, ui: 0.7 };
  muted = false;

  // --- crowding ---
  /** Recent play timestamps per sfx, used to duck stacked fire into a mix instead of a wall. */
  private recentPlays: Partial<Record<SfxName, number[]>> = {};

  // --- music state ---
  private musicTimer = 0;
  private step = 0;
  private intensity = 0;
  private targetIntensity = 0;
  private key = 0;
  private playing = false;

  /** Must be called from a user gesture; browsers block audio otherwise. */
  unlock() {
    if (this.started) {
      if (this.ctx?.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.started = true;

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(limiter);
    limiter.connect(ctx.destination);

    this.buses = {
      sfx: ctx.createGain(),
      music: ctx.createGain(),
      ui: ctx.createGain(),
    };
    for (const k of Object.keys(this.buses) as Bus[]) {
      this.buses[k].gain.value = this.volumes[k];
      this.buses[k].connect(this.master);
    }

    // One second of white noise, reused by every percussive voice.
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  setVolume(bus: Bus, v: number) {
    this.volumes[bus] = v;
    if (this.ctx) this.buses[bus].gain.value = this.muted ? 0 : v;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (!this.ctx) return;
    for (const k of Object.keys(this.buses) as Bus[]) {
      this.buses[k].gain.value = m ? 0 : this.volumes[k];
    }
  }

  private get t() { return this.ctx!.currentTime; }

  /**
   * Volume multiplier that drops as copies of `name` pile up within `window`
   * seconds. A dozen turrets firing at once should read as a dense mix, not a
   * dozen full-volume clicks stacked into a solid drone.
   */
  private crowding(name: SfxName, window = 0.15): number {
    const now = this.t;
    const list = (this.recentPlays[name] ??= []);
    while (list.length && now - list[0] > window) list.shift();
    list.push(now);
    return 1 / (1 + (list.length - 1) * 0.3);
  }

  /** Reserve a polyphony slot; returns false when the voice should be dropped. */
  private take(dur: number): boolean {
    if (!this.ctx || this.muted) return false;
    if (this.voices >= MAX_VOICES) return false;
    this.voices++;
    setTimeout(() => this.voices--, dur * 1000 + 60);
    return true;
  }

  /**
   * ADSR-ish envelope feeding `bus`, optionally through a panner.
   * Returns the node callers should connect their source into.
   */
  private env(bus: Bus, peak: number, attack: number, decay: number, at = 0, pan?: number): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t0 = this.t + at;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    if (pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(this.buses[bus]);
    } else {
      g.connect(this.buses[bus]);
    }
    return g;
  }

  private tone(
    bus: Bus,
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    peak: number,
    opts: { at?: number; attack?: number; detune?: number; pan?: number } = {},
  ) {
    const ctx = this.ctx!;
    const at = opts.at ?? 0;
    const attack = opts.attack ?? 0.005;
    const g = this.env(bus, peak, attack, dur, at, opts.pan);
    const o = ctx.createOscillator();
    o.type = type;
    const t0 = this.t + at;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    if (opts.detune) o.detune.value = opts.detune;
    o.connect(g);
    o.start(t0);
    o.stop(t0 + attack + dur + 0.02);
  }

  private burst(
    bus: Bus,
    dur: number,
    peak: number,
    filter: BiquadFilterType,
    f0: number,
    f1: number,
    q = 1,
    at = 0,
  ) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bq = ctx.createBiquadFilter();
    bq.type = filter;
    const t0 = this.t + at;
    bq.frequency.setValueAtTime(f0, t0);
    bq.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    bq.Q.value = q;
    const g = this.env(bus, peak, 0.004, dur, at);
    src.connect(bq); bq.connect(g);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ---------------------------------------------------------------------- */
  /* Public one-shots                                                        */
  /* ---------------------------------------------------------------------- */

  /** `variance` slightly detunes repeat fire so bursts don't sound machine-stamped. */
  play(name: SfxName, variance = 1) {
    if (!this.ctx || this.muted) return;
    const v = variance;

    switch (name) {
      case 'shoot': {
        if (!this.take(0.12)) return;
        const a = this.crowding(name);
        this.tone('sfx', 'square', 620 * v, 160, 0.07, 0.14 * a);
        this.burst('sfx', 0.05, 0.1 * a, 'highpass', 1400, 700);
        break;
      }

      case 'shootHeavy': {
        if (!this.take(0.3)) return;
        const a = this.crowding(name);
        this.tone('sfx', 'sawtooth', 210 * v, 48, 0.22, 0.3 * a);
        this.burst('sfx', 0.14, 0.24 * a, 'lowpass', 1800, 240);
        break;
      }

      case 'laser': {
        if (!this.take(0.2)) return;
        const a = this.crowding(name);
        this.tone('sfx', 'sawtooth', 1500 * v, 420, 0.13, 0.1 * a);
        this.tone('sfx', 'sine', 2600 * v, 900, 0.09, 0.05 * a);
        break;
      }

      case 'tesla': {
        if (!this.take(0.25)) return;
        const a = this.crowding(name);
        this.burst('sfx', 0.18, 0.22 * a, 'bandpass', 4200, 1100, 6);
        this.tone('sfx', 'square', 900 * v, 2400, 0.05, 0.06 * a);
        break;
      }

      case 'hit':
        if (!this.take(0.08)) return;
        this.burst('sfx', 0.05, 0.12, 'bandpass', 2400 * v, 900, 3);
        break;

      case 'hitArmor':
        if (!this.take(0.12)) return;
        this.tone('sfx', 'triangle', 1800 * v, 1200, 0.06, 0.1);
        this.burst('sfx', 0.07, 0.1, 'highpass', 3000, 2000, 5);
        break;

      case 'kill':
        if (!this.take(0.24)) return;
        this.burst('sfx', 0.16, 0.2, 'lowpass', 1500, 180);
        this.tone('sfx', 'triangle', 320 * v, 70, 0.15, 0.14);
        break;

      case 'explode':
        if (!this.take(0.6)) return;
        this.burst('sfx', 0.45, 0.42, 'lowpass', 1700, 90);
        this.tone('sfx', 'sine', 150, 32, 0.4, 0.4);
        break;

      case 'explodeBig':
        if (!this.take(1.4)) return;
        this.burst('sfx', 1.1, 0.6, 'lowpass', 2000, 60);
        this.tone('sfx', 'sine', 110, 22, 1.0, 0.6);
        this.tone('sfx', 'sawtooth', 70, 18, 0.8, 0.25, { at: 0.03 });
        break;

      case 'mine':
        if (!this.take(0.09)) return;
        this.tone('sfx', 'triangle', 1300 * v, 1650 * v, 0.05, 0.05);
        this.burst('sfx', 0.04, 0.05, 'bandpass', 5200, 3800, 8);
        break;

      case 'mineDone':
        if (!this.take(0.4)) return;
        this.tone('sfx', 'sine', 880, 1320, 0.16, 0.16);
        this.tone('sfx', 'sine', 1320, 1760, 0.2, 0.1, { at: 0.09 });
        break;

      case 'build':
        if (!this.take(0.45)) return;
        this.tone('sfx', 'sine', 300, 620, 0.14, 0.2);
        this.burst('sfx', 0.2, 0.16, 'lowpass', 900, 260);
        this.tone('sfx', 'triangle', 780, 900, 0.16, 0.1, { at: 0.11 });
        break;

      case 'sell':
        if (!this.take(0.3)) return;
        this.tone('sfx', 'triangle', 700, 300, 0.16, 0.14);
        this.burst('sfx', 0.14, 0.1, 'bandpass', 2200, 700, 2);
        break;

      case 'repair':
        if (!this.take(0.3)) return;
        this.tone('sfx', 'sine', 520, 900, 0.18, 0.12);
        break;

      case 'pickup':
        if (!this.take(0.14)) return;
        this.tone('ui', 'sine', 1100 * v, 1700 * v, 0.08, 0.09);
        break;

      case 'pickupEssence':
        if (!this.take(0.2)) return;
        this.tone('ui', 'sine', 760, 1520, 0.1, 0.1);
        this.tone('ui', 'triangle', 1520, 2280, 0.09, 0.05, { at: 0.05 });
        break;

      case 'levelUp':
        if (!this.take(0.9)) return;
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
          this.tone('ui', 'triangle', f, f, 0.3, 0.16, { at: i * 0.075, attack: 0.01 }),
        );
        break;

      case 'waveStart':
        if (!this.take(1.4)) return;
        this.tone('sfx', 'sawtooth', 90, 150, 0.9, 0.24, { attack: 0.25 });
        this.tone('sfx', 'sawtooth', 91.5, 151, 0.9, 0.2, { attack: 0.25, detune: 12 });
        this.burst('sfx', 0.8, 0.14, 'bandpass', 400, 1400, 1.4);
        break;

      case 'bossRoar':
        if (!this.take(2.6)) return;
        this.tone('sfx', 'sawtooth', 62, 34, 2.0, 0.5, { attack: 0.35 });
        this.tone('sfx', 'square', 41, 26, 2.2, 0.3, { attack: 0.4, detune: -18 });
        this.burst('sfx', 1.8, 0.3, 'lowpass', 900, 120, 1);
        this.burst('sfx', 1.2, 0.16, 'bandpass', 1800, 320, 3, 0.2);
        break;

      case 'coreHit':
        if (!this.take(0.5)) return;
        this.tone('sfx', 'square', 190, 60, 0.3, 0.3);
        this.burst('sfx', 0.3, 0.24, 'lowpass', 1200, 150);
        break;

      case 'coreCritical':
        if (!this.take(1.0)) return;
        this.tone('sfx', 'sawtooth', 440, 220, 0.5, 0.24);
        this.tone('sfx', 'sawtooth', 330, 165, 0.5, 0.2, { at: 0.35 });
        break;

      case 'gameOver':
        if (!this.take(3.2)) return;
        [220, 174.6, 138.6, 110].forEach((f, i) =>
          this.tone('sfx', 'sawtooth', f, f * 0.5, 1.4, 0.22, { at: i * 0.34, attack: 0.08 }),
        );
        this.burst('sfx', 2.4, 0.2, 'lowpass', 700, 60);
        break;

      case 'victory':
        if (!this.take(2.6)) return;
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) =>
          this.tone('ui', 'triangle', f, f, 0.6, 0.16, { at: i * 0.12, attack: 0.015 }),
        );
        this.tone('ui', 'sine', 130.8, 130.8, 1.8, 0.16, { attack: 0.2 });
        break;

      case 'uiHover':
        if (!this.take(0.05)) return;
        this.tone('ui', 'sine', 1500, 1500, 0.03, 0.03);
        break;

      case 'uiClick':
        if (!this.take(0.1)) return;
        this.tone('ui', 'square', 900, 1400, 0.05, 0.07);
        break;

      case 'uiBack':
        if (!this.take(0.12)) return;
        this.tone('ui', 'square', 700, 380, 0.07, 0.07);
        break;

      case 'error':
        if (!this.take(0.25)) return;
        this.tone('ui', 'square', 200, 150, 0.12, 0.12);
        this.tone('ui', 'square', 150, 110, 0.12, 0.1, { at: 0.09 });
        break;

      case 'achievement':
        if (!this.take(1.4)) return;
        [659.25, 830.6, 987.77, 1318.5].forEach((f, i) =>
          this.tone('ui', 'triangle', f, f, 0.45, 0.15, { at: i * 0.09, attack: 0.012 }),
        );
        this.tone('ui', 'sine', 164.8, 164.8, 1.0, 0.1, { attack: 0.1 });
        break;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Adaptive music                                                          */
  /* ---------------------------------------------------------------------- */

  startMusic(keyOffset = 0) {
    this.playing = true;
    this.key = keyOffset;
    this.step = 0;
    this.musicTimer = 0;
  }

  stopMusic() {
    this.playing = false;
  }

  /** 0 = build phase calm, 1 = boss fight. Smoothed internally. */
  setIntensity(v: number) {
    this.targetIntensity = Math.max(0, Math.min(1, v));
  }

  private static readonly SCALE = [0, 3, 5, 7, 10]; // minor pentatonic
  private static readonly BASS = [0, 0, -5, -5, 3, 3, -2, -2];

  /** Call once per frame with real dt. Sequences a 16th-note grid. */
  update(dt: number) {
    if (!this.ctx || !this.playing || this.muted) return;
    this.intensity += (this.targetIntensity - this.intensity) * Math.min(1, dt * 0.7);

    const bpm = 84 + this.intensity * 44;
    const stepDur = 60 / bpm / 4;
    this.musicTimer += dt;

    let guard = 0;
    while (this.musicTimer >= stepDur && guard++ < 8) {
      this.musicTimer -= stepDur;
      this.tick(this.step, this.intensity);
      this.step = (this.step + 1) & 31;
    }
  }

  private tick(step: number, I: number) {
    const root = 55 * Math.pow(2, this.key / 12); // A1-ish
    const semi = (n: number) => root * Math.pow(2, n / 12);

    // Sustained pad, retriggered every bar. Always present, quieter when hot.
    if (step % 16 === 0) {
      const bassNote = AudioEngine.BASS[(step >> 2) & 7];
      const f = semi(bassNote);
      const dur = 60 / (84 + I * 44) * 4;
      this.tone('music', 'sawtooth', f, f, dur, 0.05 + (1 - I) * 0.05, { attack: 0.5 });
      this.tone('music', 'sawtooth', f * 1.5, f * 1.5, dur, 0.025, { attack: 0.7, detune: 7 });
    }

    // Sub bass pulse — comes in from low intensity upward.
    if (I > 0.12 && step % 4 === 0) {
      const bassNote = AudioEngine.BASS[(step >> 2) & 7];
      this.tone('music', 'sine', semi(bassNote), semi(bassNote) * 0.94, 0.2, 0.1 + I * 0.14);
    }

    // Kick / hat groove.
    if (I > 0.3) {
      if (step % 8 === 0) {
        this.tone('music', 'sine', 130, 42, 0.16, 0.22 * I);
        this.burst('music', 0.05, 0.08 * I, 'lowpass', 400, 120);
      }
      if (step % 8 === 4 && I > 0.55) {
        this.burst('music', 0.14, 0.1 * I, 'highpass', 1400, 900, 1.5);
      }
      if (step % 2 === 1 && I > 0.45) {
        this.burst('music', 0.03, 0.035 * I, 'highpass', 7000, 6000, 2);
      }
    }

    // Arpeggio, only when things are genuinely hot.
    if (I > 0.5 && step % 2 === 0) {
      const idx = (step >> 1) % AudioEngine.SCALE.length;
      const oct = ((step >> 3) & 1) ? 24 : 12;
      const f = semi(AudioEngine.SCALE[idx] + oct + 12);
      this.tone('music', 'square', f, f, 0.1, 0.035 * (I - 0.5) * 2);
    }
  }
}

export const audio = new AudioEngine();
