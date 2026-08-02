// Tiny Web Audio tones for the gate screen. Success = bright double beep
// (works with hands busy / eyes on the car line); NOT FOUND = low buzz.
// All calls are no-ops if audio is unavailable or not yet allowed.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function playTone(freq: number, durationMs = 150, type: OscillatorType = 'sine', gain = 0.15): void {
  const audio = getCtx();
  if (!audio) return;
  try {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + durationMs / 1000);
    osc.connect(g);
    g.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + durationMs / 1000);
  } catch { /* audio not available — silent */ }
}

/** Bright success chime (two ascending tones). */
export function successBeep(): void {
  playTone(880, 120);
  window.setTimeout(() => playTone(1174.66, 180), 130);
}

/** Low buzz for NOT FOUND. */
export function errorBuzz(): void {
  playTone(220, 380, 'sawtooth', 0.12);
}
