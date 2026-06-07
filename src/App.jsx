import React, { useState, useEffect, useRef } from 'react';
import { Bell, Home, Settings, Shield, Phone, Baby, Car, AlertTriangle, Volume2, VolumeX, Smartphone, Watch, Lightbulb, Vibrate, Users, Wifi, Cpu, BarChart2, Activity, Key, CloudOff } from 'lucide-react';
import hearoLogo from './images/hearo_logo.png';

// ==================== CONFIGURATION ====================
const DetectionConfig = {
  sampleRate: 16000,
  bufferDuration: 2,       // seconds of audio per classification
  detectionInterval: 8000, // ms between runs (8s = 7.5 req/min, safely under Gemini 2.5 Flash 10 RPM free tier)
  defaultSensitivity: 7,   // more aggressive by default so more sounds trigger
  hfModel: 'MIT/ast-finetuned-audioset-10-10-0.4593',
  hfEndpoint: 'https://api-inference.huggingface.co/models/MIT/ast-finetuned-audioset-10-10-0.4593',
  whisperEndpoint: 'https://api-inference.huggingface.co/models/openai/whisper-large-v3',
  // Gemini 2.5 Flash — latest model, supports audio inline, 10 req/min free tier
  geminiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
};

// Hearo sound categories
const SoundCategories = {
  fire_alarm:    { type: 'emergency', severity: 'critical', location: 'Whole House' },
  smoke_detector:{ type: 'emergency', severity: 'critical', location: 'Whole House' },
  doorbell:      { type: 'doorbell',  severity: 'medium',   location: 'Front Door'  },
  phone_ring:    { type: 'phone',     severity: 'high',     location: 'Living Room' },
  baby_cry:      { type: 'baby',      severity: 'high',     location: 'Nursery'     },
  car_horn:      { type: 'car',       severity: 'medium',   location: 'Outside'     },
  glass_break:   { type: 'emergency', severity: 'critical', location: 'Unknown'     },
  scream:        { type: 'emergency', severity: 'critical', location: 'Unknown'     },
  dog_bark:      { type: 'dog',       severity: 'low',      location: 'Outside'     },
  knock:         { type: 'knock',     severity: 'medium',   location: 'Front Door'  },
  siren:         { type: 'emergency', severity: 'high',     location: 'Outside'     },
  alarm:         { type: 'emergency', severity: 'high',     location: 'Unknown'     },
};

// AudioSet label patterns → Hearo category
// These match the exact label text returned by MIT/ast-finetuned-audioset-10-10-0.4593
const AUDIOSET_CLASS_PATTERNS = [
  { patterns: ['fire alarm', 'smoke detector', 'smoke alarm', 'civil defense siren', 'fire truck siren'],
    category: 'fire_alarm' },
  { patterns: ['doorbell', 'ding-dong', 'bell'],
    category: 'doorbell' },
  { patterns: ['telephone bell ringing', 'telephone', 'ringtone', 'phone'],
    category: 'phone_ring' },
  { patterns: ['baby cry', 'infant cry', 'whimper', 'crying'],
    category: 'baby_cry' },
  { patterns: ['car horn', 'honking', 'car alarm', 'vehicle horn', 'beep, bleep'],
    category: 'car_horn' },
  { patterns: ['breaking', 'glass', 'shatter', 'smash', 'crash'],
    category: 'glass_break' },
  { patterns: ['screaming', 'shouting', 'yelling', 'scream', 'shriek'],
    category: 'scream' },
  { patterns: ['dog', 'bark', 'bow-wow', 'growling'],
    category: 'dog_bark' },
  { patterns: ['knock', 'tap', 'rapping'],
    category: 'knock' },
  { patterns: ['siren', 'ambulance', 'police siren'],
    category: 'siren' },
  { patterns: ['alarm clock', 'buzzer', 'alarm', 'beeping'],
    category: 'alarm' },
];

function matchAudioSetLabel(label) {
  const lower = label.toLowerCase();
  for (const { patterns, category } of AUDIOSET_CLASS_PATTERNS) {
    if (patterns.some(p => lower.includes(p))) return category;
  }
  return null;
}

// ==================== WAV ENCODER ====================
// Converts Float32Array audio samples → WAV Blob for sending to cloud APIs
function encodeWAV(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4,  36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1,  true);          // PCM
  view.setUint16(22, 1,  true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2,  true);
  view.setUint16(34, 16, true);          // 16-bit
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ==================== BASE64 HELPER ====================
// Converts a Blob → base64 string (no data-URI prefix) for Gemini inline_data
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ==================== SERVICE MANAGER ====================
class ServiceManager {
  constructor() {
    this.services = { geminiApi: false, hfApi: false, hfAuthenticated: false, localStorage: false };
    this.apiKey = '';        // Hugging Face key
    this.geminiKey = '';     // Google Gemini key
    this.hfStatus = 'idle';     // 'idle' | 'checking' | 'ready' | 'warming' | 'rate_limited' | 'offline'
    this.geminiStatus = 'idle'; // 'idle' | 'ready' | 'offline'
  }

  // ---------- HF key ----------
  loadApiKey() {
    const envKey = process.env.REACT_APP_HF_API_KEY || '';
    const storedKey = localStorage.getItem('hearo_hf_key') || '';
    this.apiKey = envKey || storedKey;
    return this.apiKey;
  }
  saveApiKey(key) {
    this.apiKey = key.trim();
    if (this.apiKey) localStorage.setItem('hearo_hf_key', this.apiKey);
    else localStorage.removeItem('hearo_hf_key');
  }

  // ---------- Gemini key ----------
  loadGeminiKey() {
    const envKey = process.env.REACT_APP_GEMINI_API_KEY || '';
    const storedKey = localStorage.getItem('hearo_gemini_key') || '';
    this.geminiKey = envKey || storedKey;
    return this.geminiKey;
  }
  saveGeminiKey(key) {
    this.geminiKey = key.trim();
    if (this.geminiKey) localStorage.setItem('hearo_gemini_key', this.geminiKey);
    else localStorage.removeItem('hearo_gemini_key');
  }

  async initialize(onStatusChange) {
    // localStorage
    try {
      localStorage.setItem('_hearo_test', '1');
      localStorage.removeItem('_hearo_test');
      this.services.localStorage = true;
    } catch (_) {}

    // Load saved keys
    this.loadApiKey();
    this.loadGeminiKey();
    this.services.hfAuthenticated = !!this.apiKey;
    this.services.geminiApi = !!this.geminiKey; // assume ready if key present; validated on first call

    if (this.geminiKey) {
      this.geminiStatus = 'ready';
    }

    if (onStatusChange) onStatusChange({ ...this.services }, 'checking');

    // Ping HF to see if API is reachable
    try {
      const headers = { 'Content-Type': 'audio/wav' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      // Tiny 0.1s silent WAV just to check connectivity / model status
      const silentSamples = new Float32Array(1600).fill(0);
      const wav = encodeWAV(silentSamples, 16000);

      const res = await fetch(DetectionConfig.hfEndpoint, {
        method: 'POST', headers, body: wav,
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 200 || res.status === 400) {
        this.services.hfApi = true;
        this.hfStatus = 'ready';
      } else if (res.status === 503) {
        const body = await res.json().catch(() => ({}));
        this.services.hfApi = true;
        this.hfStatus = 'warming';
        console.log(`⏳ HF model warming up (~${Math.round(body.estimated_time || 20)}s)`);
      } else if (res.status === 429) {
        this.services.hfApi = true;
        this.hfStatus = 'rate_limited';
      } else {
        this.hfStatus = 'offline';
      }
    } catch (_) {
      this.hfStatus = 'offline';
    }

    if (onStatusChange) onStatusChange({ ...this.services }, this.hfStatus);
    return this.hfStatus !== 'offline' || this.geminiStatus === 'ready';
  }

  getServiceStatus() { return { ...this.services }; }
}

// ==================== AUDIO PROCESSOR ====================
class AudioProcessor {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;
    this.scriptProcessor = null;
    this.isActive = false;
    this.audioLevel = 0;
    this.onAudioLevelChange = null;
    this.rollingBuffer = null;
    this.bufferPos = 0;
    this.bufferFilled = false;
  }

  async initialize() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }
      });
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.stream);

      // Analyser for audio level bar
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.7;
      source.connect(this.analyser);

      // Rolling buffer: 2 seconds of raw samples
      const bufSize = Math.ceil(this.audioContext.sampleRate * DetectionConfig.bufferDuration);
      this.rollingBuffer = new Float32Array(bufSize);

      const proc = this.audioContext.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        if (!this.isActive) return;
        const data = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          this.rollingBuffer[this.bufferPos] = data[i];
          this.bufferPos = (this.bufferPos + 1) % this.rollingBuffer.length;
          if (this.bufferPos === 0) this.bufferFilled = true;
        }
      };
      // Silent gain: keeps ScriptProcessor in the graph (required) without looping mic → speaker
      const silentGain = this.audioContext.createGain();
      silentGain.gain.value = 0;
      source.connect(proc);
      proc.connect(silentGain);
      silentGain.connect(this.audioContext.destination);
      this.scriptProcessor = proc;

      this.isActive = true;
      this.startLevelMonitoring();
      return true;
    } catch (e) {
      console.error('Audio init failed:', e);
      return false;
    }
  }

  startLevelMonitoring() {
    const arr = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.analyser || !this.isActive) return;
      this.analyser.getByteFrequencyData(arr);
      let sum = 0;
      for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
      this.audioLevel = Math.round((Math.sqrt(sum / arr.length) / 128) * 100);
      if (this.onAudioLevelChange) this.onAudioLevelChange(this.audioLevel);
      if (this.isActive) requestAnimationFrame(tick);
    };
    tick();
  }

  // Returns 16kHz mono Float32Array (resampled if needed) for sending to cloud
  async captureAudioBuffer() {
    if (!this.isActive || !this.bufferFilled) return null;
    const raw = new Float32Array(this.rollingBuffer.length);
    for (let i = 0; i < raw.length; i++)
      raw[i] = this.rollingBuffer[(this.bufferPos + i) % raw.length];

    const srcRate = this.audioContext.sampleRate;
    if (srcRate === DetectionConfig.sampleRate) return raw;

    // Resample to 16 kHz
    const targetLen = Math.round(raw.length * DetectionConfig.sampleRate / srcRate);
    const offCtx = new OfflineAudioContext(1, targetLen, DetectionConfig.sampleRate);
    const buf = offCtx.createBuffer(1, raw.length, srcRate);
    buf.getChannelData(0).set(raw);
    const src = offCtx.createBufferSource();
    src.buffer = buf; src.connect(offCtx.destination); src.start(0);
    const rendered = await offCtx.startRendering();
    return rendered.getChannelData(0);
  }

  getFrequencyData() {
    if (!this.analyser) return null;
    const data = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(data);
    return data;
  }

  stop() {
    this.isActive = false;
    this.analyser = null; // null before closing context so level monitor exits cleanly
    if (this.scriptProcessor) { try { this.scriptProcessor.disconnect(); } catch (_) {} this.scriptProcessor = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
    this.audioLevel = 0; this.rollingBuffer = null; this.bufferFilled = false;
  }

  getAudioLevel() { return this.audioLevel; }
}

// ==================== SOUND CLASSIFIER ====================
class SoundClassifier {
  constructor(serviceManager) {
    this.svc = serviceManager;
    this.isProcessing = false;
    this.onProcessingChange = null;
    this.onTopPredictionsUpdate = null;
    this.sensitivityThreshold = 0.35;
    this.warmingUp = false;
    this.currentAbort = null; // AbortController for the active fetch
    this.onTranscriptUpdate = null; // (text: string) => void — called even when no sound category matched
  }

  setSensitivity(v) {
    this.sensitivityThreshold = Math.max(0.12, 0.55 - (v / 10) * 0.43);
  }

  // Call this from stopListening() to instantly cancel any in-flight API call
  abort() {
    if (this.currentAbort) { this.currentAbort.abort(); this.currentAbort = null; }
    this.isProcessing = false;
    if (this.onProcessingChange) this.onProcessingChange(false);
  }

  async classifySound(audioBuffer, freqData) {
    if (this.isProcessing) return null;
    this.isProcessing = true;
    if (this.onProcessingChange) this.onProcessingChange(true);
    try {
      // 1. Try Gemini first — best accuracy + transcription in one call
      if (this.svc.geminiKey && this.svc.geminiStatus !== 'offline' && audioBuffer) {
        const result = await this.classifyWithGemini(audioBuffer);
        if (result) return result;
      }
      // 2. Fall back to Hugging Face AST cloud
      if (this.svc.hfStatus !== 'offline' && audioBuffer) {
        const result = await this.classifyWithHuggingFace(audioBuffer);
        if (result) return result;
      }
      // 3. Local frequency analysis (always available)
      return this.classifyWithFrequencyAnalysis(freqData);
    } catch (e) {
      console.warn('Classification error, falling back:', e.message);
      return this.classifyWithFrequencyAnalysis(freqData);
    } finally {
      this.isProcessing = false;
      if (this.onProcessingChange) this.onProcessingChange(false);
    }
  }

  async classifyWithGemini(audioBuffer) {
    const startTime = performance.now();
    this.currentAbort = new AbortController();
    const { signal } = this.currentAbort;
    try {
      console.log('🎙️ Sending audio to Gemini...');
      const wavBlob = encodeWAV(audioBuffer, DetectionConfig.sampleRate);
      const base64Audio = await blobToBase64(wavBlob);
      if (signal.aborted) return null;

      const prompt = `You are an environmental sound classifier for a hearing-impaired alert system. Your PRIMARY job is to detect important non-speech sounds.

Listen carefully to this 2-second audio clip and return ONLY a JSON object:
{
  "sounds": [
    {"label": "<sound name>", "confidence": <0.0 to 1.0>}
  ],
  "transcript": "<Thai or English speech only, empty string otherwise>"
}

IMPORTANT — actively listen for these alert sounds and label them EXACTLY:
- "fire alarm" — any fire alarm, smoke alarm beeping
- "smoke detector" — smoke detector chirp/beep
- "siren" — emergency vehicle siren, ambulance, police, fire truck
- "baby cry" — infant or baby crying/whimpering
- "dog bark" — dog barking or growling
- "doorbell" — doorbell ring, ding-dong
- "phone ringing" — telephone or mobile phone ringing
- "car horn" — vehicle horn honking
- "glass breaking" — glass shattering or breaking
- "screaming" — human scream or shout of distress
- "knocking" — knocking or banging on door
- "alarm" — alarm clock, buzzer, beeping alarm

Rules:
- Report ANY of the above sounds if heard, even at confidence 0.2+
- Also report "speech" if someone is talking
- For transcript: ONLY include Thai or English speech. Any other language → ""
- Return ONLY the JSON, no other text`;

      const body = {
        contents: [{
          parts: [
            { inline_data: { mime_type: 'audio/wav', data: base64Audio } },
            { text: prompt }
          ]
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      };

      const res = await fetch(
        `${DetectionConfig.geminiEndpoint}?key=${this.svc.geminiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
      );

      if (res.status === 429) {
        console.warn('⚠️ Gemini rate limited — falling back to HF');
        return null;
      }
      if (res.status === 400) {
        const errBody = await res.json().catch(() => ({}));
        console.warn('❌ Gemini 400 bad request:', errBody?.error?.message || 'unknown');
        return null;
      }
      if (res.status === 403) {
        const errBody = await res.json().catch(() => ({}));
        console.warn('❌ Gemini 403 — invalid API key:', errBody?.error?.message || 'check key in Settings');
        this.svc.geminiStatus = 'offline';
        return null;
      }
      if (!res.ok) {
        console.warn('❌ Gemini HTTP', res.status, '— falling back');
        return null;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('✅ Gemini raw response:', text.slice(0, 200));
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) {
        console.warn('❌ Gemini response not valid JSON:', text.slice(0, 100));
        return null;
      }

      const sounds = Array.isArray(parsed?.sounds) ? parsed.sounds : [];
      const transcript = typeof parsed?.transcript === 'string' ? parsed.transcript.trim() : '';
      const processingTime = `${((performance.now() - startTime) / 1000).toFixed(1)}s`;

      // Build topPredictions for display
      const topPredictions = sounds
        .sort((a, b) => b.confidence - a.confidence)
        .map(s => ({
          className: s.label,
          confidence: s.confidence,
          category: matchAudioSetLabel(s.label),
        }));

      if (this.onTopPredictionsUpdate) this.onTopPredictionsUpdate(topPredictions);

      // Best Hearo-relevant sound above threshold
      const best = topPredictions.find(p => p.category && p.confidence >= this.sensitivityThreshold);

      // Always surface transcript even when no alert category matched
      if (!best) {
        if (transcript && this.onTranscriptUpdate) this.onTranscriptUpdate(transcript);
        return null;
      }

      return {
        soundType: best.category,
        confidence: Math.round(best.confidence * 100),
        source: 'Gemini 2.5 Flash AI',
        processingTime,
        topPredictions,
        transcript: transcript || null,
        transcriptConfidence: transcript ? 95 : null,
      };
    } catch (e) {
      if (e.name === 'AbortError') return null; // user pressed Stop — silent exit
      console.warn('Gemini classification error:', e.message);
      return null;
    }
  }

  async classifyWithHuggingFace(audioBuffer) {
    const startTime = performance.now();
    this.currentAbort = new AbortController();
    const { signal } = this.currentAbort;
    const wavBlob = encodeWAV(audioBuffer, DetectionConfig.sampleRate);

    const headers = { 'Content-Type': 'audio/wav' };
    if (this.svc.apiKey) headers['Authorization'] = `Bearer ${this.svc.apiKey}`;

    let res;
    try {
      res = await fetch(DetectionConfig.hfEndpoint, {
        method: 'POST', headers, body: wavBlob, signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') return null; // user pressed Stop
      this.svc.hfStatus = 'offline';
      return null;
    }

    // Model warming up (cold start)
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.min((body.estimated_time || 20) * 1000, 25000);
      this.svc.hfStatus = 'warming';
      this.warmingUp = true;
      console.log(`⏳ HF model warming up, waiting ${Math.round(wait / 1000)}s...`);
      await new Promise(r => setTimeout(r, wait));
      this.warmingUp = false;
      this.svc.hfStatus = 'ready';
      return this.classifyWithHuggingFace(audioBuffer); // retry
    }

    if (res.status === 429) { this.svc.hfStatus = 'rate_limited'; return null; }
    if (!res.ok) { return null; }

    const results = await res.json(); // [{label, score}, ...]
    if (!Array.isArray(results) || results.length === 0) return null;

    const processingTime = `${((performance.now() - startTime) / 1000).toFixed(1)}s`;

    // Build top predictions for display
    const topPredictions = results.slice(0, 10).map(r => ({
      className: r.label,
      confidence: r.score,
      category: matchAudioSetLabel(r.label),
    }));

    if (this.onTopPredictionsUpdate) this.onTopPredictionsUpdate(topPredictions);

    // Find highest-score Hearo-relevant sound above threshold
    const best = topPredictions.find(p => p.category && p.confidence >= this.sensitivityThreshold);
    if (!best) return null;

    return {
      soundType: best.category,
      confidence: Math.round(best.confidence * 100),
      source: `HF AST AI${this.svc.apiKey ? '' : ' (free tier)'}`,
      processingTime,
      topPredictions,
    };
  }

  classifyWithFrequencyAnalysis(freqData) {
    if (!freqData) return null;

    const binHz = (44100 / 2) / freqData.length;
    const linear = Array.from(freqData).map(db => Math.pow(10, Math.max(db, -100) / 20));
    const totalEnergy = linear.reduce((s, v) => s + v, 0);
    if (totalEnergy < 0.05) return null;

    const bandFrac = (fLow, fHigh) => {
      const iLo = Math.max(0, Math.floor(fLow / binHz));
      const iHi = Math.min(linear.length - 1, Math.ceil(fHigh / binHz));
      let s = 0;
      for (let i = iLo; i <= iHi; i++) s += linear[i];
      return s / totalEnergy;
    };

    const rawScores = {
      fire_alarm:     bandFrac(2500, 4500),
      smoke_detector: bandFrac(3000, 4000),
      baby_cry:       bandFrac(250, 700),
      car_horn:       bandFrac(300, 520),
      phone_ring:     bandFrac(850, 1800),
      doorbell:       bandFrac(700, 1300),
      scream:         bandFrac(500, 4000),
      glass_break:    bandFrac(1500, 8000),
    };

    const freqThreshold = this.sensitivityThreshold * 0.35;

    const topPredictions = Object.entries(rawScores)
      .map(([cat, score]) => ({
        className: UIUtils.getAlertText(SoundCategories[cat]?.type || cat),
        confidence: Math.min(1, score / 0.25),
        category: cat,
      }))
      .sort((a, b) => b.confidence - a.confidence);

    if (this.onTopPredictionsUpdate) this.onTopPredictionsUpdate(topPredictions);

    const best = topPredictions[0];
    if (rawScores[best.category] < freqThreshold) return null;

    return {
      soundType: best.category,
      confidence: Math.round(best.confidence * 100),
      source: 'Frequency Analysis (local)',
      processingTime: '< 0.1s',
      topPredictions,
    };
  }
}

// ==================== SPEECH TRANSCRIBER ====================
class SpeechTranscriber {
  constructor() {
    this.recognition = null;
    this.isActive = false;
    this.lines = [];          // [{text, time, confidence}]
    this.interim = '';
    this.language = 'th-TH'; // default Thai; switches to en-US if Thai fails
    this.onUpdate = null;     // (lines, interim) => void
    this.supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  initialize(lang = 'th-TH') {
    if (!this.supported) return false;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.language = lang;

    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = lang;
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text.length > 0) {
            this.lines.push({
              text,
              time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              confidence: Math.round((r[0].confidence || 0.8) * 100),
            });
            this.lines = this.lines.slice(-30); // keep last 30 lines
          }
        } else {
          interim += r[0].transcript;
        }
      }
      this.interim = interim;
      if (this.onUpdate) this.onUpdate([...this.lines], this.interim);
    };

    this.recognition.onerror = (e) => {
      // 'no-speech' is normal — just ignore
      if (e.error === 'language-not-supported' && lang !== 'en-US') {
        // Fall back to English
        this.stop();
        this.initialize('en-US');
        this.start();
      }
    };

    // Auto-restart if it stops (browser stops recognition after silence)
    this.recognition.onend = () => {
      if (this.isActive) {
        try { this.recognition.start(); } catch (_) {}
      }
    };

    return true;
  }

  start(lang) {
    if (!this.recognition) this.initialize(lang || this.language);
    if (!this.recognition) return false;
    this.isActive = true;
    try { this.recognition.start(); return true; } catch (_) { return false; }
  }

  stop() {
    this.isActive = false;
    this.interim = '';
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) {}
    }
    if (this.onUpdate) this.onUpdate([...this.lines], '');
  }

  setLanguage(lang) {
    const wasActive = this.isActive;
    this.stop();
    this.recognition = null;
    this.initialize(lang);
    if (wasActive) this.start();
  }

  clearTranscript() {
    this.lines = [];
    this.interim = '';
    if (this.onUpdate) this.onUpdate([], '');
  }
}

// ==================== ALERT PROCESSOR ====================
class AlertProcessor {
  constructor() { this.onAlertGenerated = null; }

  async initializeNotifications() {
    if ('Notification' in window) await Notification.requestPermission();
  }

  async processAlert(classification) {
    const alertData = this.createAlertData(classification);
    this.saveToLocalStorage(alertData);
    this.triggerLocalAlert(alertData);
    if (this.onAlertGenerated) this.onAlertGenerated(alertData);
    return alertData;
  }

  createAlertData(c) {
    const info = SoundCategories[c.soundType] || { type: 'unknown', severity: 'medium', location: 'Unknown' };
    return {
      id: Date.now(), type: info.type, soundType: c.soundType,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      severity: info.severity, location: info.location,
      confidence: c.confidence, source: c.source,
      timestamp: new Date().toISOString(), processingTime: c.processingTime,
    };
  }

  saveToLocalStorage(alert) {
    try {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const stored = JSON.parse(localStorage.getItem('hearo_alerts') || '[]')
        .filter(a => new Date(a.timestamp) > cutoff).slice(0, 99);
      localStorage.setItem('hearo_alerts', JSON.stringify([alert, ...stored]));
    } catch (_) {}
  }

  triggerLocalAlert(alert) {
    document.body.style.backgroundColor = this.severityColor(alert.severity);
    setTimeout(() => { document.body.style.backgroundColor = ''; }, 300);
    if ('vibrate' in navigator) {
      const p = this.vibrationPattern(alert.severity);
      navigator.vibrate(p);
      if (alert.severity === 'critical') setTimeout(() => navigator.vibrate(p), 2000);
    }
    this.playTone(alert.severity);
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`Hearo: ${alert.soundType.replace('_', ' ')}`, {
        body: `${alert.location} — ${alert.confidence}% confidence (${alert.source})`,
        icon: '/favicon.ico', tag: 'hearo-alert',
        requireInteraction: alert.severity === 'critical',
      });
    }
  }

  severityColor(s) {
    return { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' }[s] || '#eab308';
  }

  vibrationPattern(s) {
    return {
      critical: [0, 500, 100, 500, 100, 500, 100, 500],
      high:     [0, 300, 150, 300, 150, 300],
      medium:   [0, 200, 100, 200],
      low:      [0, 150],
    }[s] || [0, 200, 100, 200];
  }

  playTone(severity) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const profiles = {
        critical: { f: 800, d: 1.0, n: 3 }, high: { f: 600, d: 0.8, n: 2 },
        medium:   { f: 450, d: 0.5, n: 1 }, low:  { f: 350, d: 0.3, n: 1 },
      };
      const p = profiles[severity] || profiles.medium;
      let t = ctx.currentTime;
      for (let i = 0; i < p.n; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = p.f;
        osc.type = severity === 'critical' ? 'square' : 'sine';
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + p.d / p.n);
        osc.start(t); osc.stop(t + p.d / p.n);
        t += p.d / p.n + 0.1;
      }
    } catch (_) {}
  }
}

// ==================== UI UTILITIES ====================
class UIUtils {
  static getAlertIcon(type) {
    return {
      doorbell: <Bell className="w-8 h-8" />, phone: <Phone className="w-8 h-8" />,
      emergency: <AlertTriangle className="w-8 h-8" />, baby: <Baby className="w-8 h-8" />,
      car: <Car className="w-8 h-8" />, dog: <span className="text-2xl">🐕</span>,
      knock: <span className="text-2xl">🚪</span>, siren: <AlertTriangle className="w-8 h-8" />,
      alarm: <Bell className="w-8 h-8" />,
    }[type] || <Bell className="w-8 h-8" />;
  }
  static getAlertText(type) {
    return {
      doorbell: 'Doorbell', phone: 'Phone Call', emergency: 'Emergency',
      baby: 'Baby Crying', car: 'Car Horn', dog: 'Dog Barking',
      knock: 'Knocking', siren: 'Siren', alarm: 'Alarm',
    }[type] || 'Unknown Sound';
  }
  static getSeverityColor(s) {
    return { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' }[s] || '#eab308';
  }
}

// ==================== MAIN APP ====================
const HearoApp = () => {
  const [currentScreen, setCurrentScreen]   = useState('home');
  const [isListening, setIsListening]       = useState(false);
  const [isProcessing, setIsProcessing]     = useState(false);
  const [audioLevel, setAudioLevel]         = useState(0);
  const [hfStatus, setHfStatus]             = useState('idle');
  const [modelServices, setModelServices]   = useState({ hfApi: false, hfAuthenticated: false, localStorage: false });
  const [apiKeyInput, setApiKeyInput]       = useState('');
  const [apiKeySaved, setApiKeySaved]       = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [geminiKeySaved, setGeminiKeySaved] = useState(false);
  const [liveTopPredictions, setLivePreds]  = useState([]);
  const [sensitivity, setSensitivity]       = useState(DetectionConfig.defaultSensitivity);
  const [recentAlerts, setRecentAlerts]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('hearo_alerts') || '[]').slice(0, 5); } catch (_) { return []; }
  });
  const [vibrationSettings, setVibrationSettings] = useState({
    doorbell: 'medium', emergency: 'strong', phone: 'gentle', baby: 'strong',
  });
  const [emergencyScenario, setEmergencyScenario] = useState(null);
  const [scenarioStep, setScenarioStep]     = useState(0);
  const [warmingUp, setWarmingUp]           = useState(false);
  const [isStarting, setIsStarting]         = useState(false);

  const [transcriptLines, setTranscriptLines]   = useState([]);
  const [interimText, setInterimText]           = useState('');
  const [transcriptLang, setTranscriptLang]     = useState('th-TH');
  const [transcriptEnabled, setTranscriptEnabled] = useState(true);
  const [showTranscript, setShowTranscript]     = useState(true);

  const svcRef         = useRef(new ServiceManager());
  const audioRef       = useRef(new AudioProcessor());
  const classRef       = useRef(new SoundClassifier(svcRef.current));
  const alertRef       = useRef(new AlertProcessor());
  const transcriberRef = useRef(new SpeechTranscriber());
  const intervalRef    = useRef(null);
  const listeningRef   = useRef(false); // ref so async callbacks can read current value
  const isStartingRef  = useRef(false); // ref mirror of isStarting — readable synchronously

  useEffect(() => {
    init();
    return () => cleanup();
  }, []);

  const init = async () => {
    alertRef.current.initializeNotifications();
    audioRef.current.onAudioLevelChange = setAudioLevel;
    classRef.current.onProcessingChange = setIsProcessing;
    classRef.current.onTopPredictionsUpdate = setLivePreds;
    classRef.current.onTranscriptUpdate = (text) => {
      transcriberRef.current.lines.push({
        text,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        confidence: 90,
      });
      transcriberRef.current.lines = transcriberRef.current.lines.slice(-30);
      setTranscriptLines([...transcriberRef.current.lines]);
    };
    alertRef.current.onAlertGenerated = (a) => setRecentAlerts(prev => [a, ...prev.slice(0, 9)]);

    // Wire up transcriber callbacks
    transcriberRef.current.onUpdate = (lines, interim) => {
      setTranscriptLines([...lines]);
      setInterimText(interim);
    };

    setHfStatus('checking');
    await svcRef.current.initialize((services, status) => {
      setModelServices({ ...services });
      setHfStatus(status);
    });
    setApiKeyInput(svcRef.current.apiKey);
    setGeminiKeyInput(svcRef.current.geminiKey);
  };

  const cleanup = () => {
    audioRef.current.stop();
    if (intervalRef.current) clearInterval(intervalRef.current);
  };

  const startListening = async () => {
    // Guard uses REFS (not state) — state lags behind by one render cycle so
    // isListening/isStarting from closure can be stale when the user clicks fast.
    if (listeningRef.current || isStartingRef.current) return;

    isStartingRef.current = true;
    setIsStarting(true);

    // Mark intent BEFORE the await so stopListening() can cancel us
    listeningRef.current = true;

    const ok = await audioRef.current.initialize();

    isStartingRef.current = false;
    setIsStarting(false);

    if (!ok) {
      listeningRef.current = false;
      alert('Microphone access denied. Please check permissions.');
      return;
    }

    // Stop was pressed while the mic permission prompt was showing
    if (!listeningRef.current) {
      audioRef.current.stop();
      return;
    }

    setIsListening(true);
    classRef.current.setSensitivity(sensitivity);

    // Clear any stale interval from a previous run (defensive)
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }

    // Start speech transcription in parallel (Web Speech API)
    if (transcriptEnabled && transcriberRef.current.supported) {
      transcriberRef.current.clearTranscript();
      transcriberRef.current.start(transcriptLang);
    }

    intervalRef.current = setInterval(async () => {
      if (!listeningRef.current) return; // guard: stop() may have been called mid-await
      const level = audioRef.current.getAudioLevel();
      if (level > 10) {
        const audioBuffer = await audioRef.current.captureAudioBuffer();
        if (!listeningRef.current) return; // check again after async capture
        const freqData = audioRef.current.getFrequencyData();
        setWarmingUp(classRef.current.warmingUp);
        const result = await classRef.current.classifySound(audioBuffer, freqData);
        if (!listeningRef.current) return; // check again after slow cloud call
        setWarmingUp(false);
        setHfStatus(svcRef.current.hfStatus);
        // Merge Gemini transcript into the transcript panel if available
        if (result?.transcript) {
          transcriberRef.current.lines.push({
            text: result.transcript,
            time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            confidence: result.transcriptConfidence || 90,
          });
          setTranscriptLines([...transcriberRef.current.lines.slice(-30)]);
        }
        if (result) await alertRef.current.processAlert(result);
      }
    }, DetectionConfig.detectionInterval);
  };

  const stopListening = () => {
    listeningRef.current = false;       // signal all pending async ops to bail out
    isStartingRef.current = false;
    setIsListening(false);
    setIsStarting(false);
    setIsProcessing(false);
    setAudioLevel(0);
    try { classRef.current.abort(); } catch (_) {}   // cancel in-flight Gemini/HF fetch
    try { audioRef.current.stop(); } catch (_) {}
    try { transcriberRef.current.stop(); } catch (_) {}
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setLivePreds([]);
    setInterimText('');
    setWarmingUp(false);
  };

  const saveApiKey = () => {
    svcRef.current.saveApiKey(apiKeyInput);
    setApiKeySaved(true);
    setModelServices(prev => ({ ...prev, hfAuthenticated: !!apiKeyInput.trim() }));
    setTimeout(() => setApiKeySaved(false), 2000);
    // Re-check HF status with new key
    setHfStatus('checking');
    svcRef.current.initialize((services, status) => {
      setModelServices({ ...services });
      setHfStatus(status);
    });
  };

  const saveGeminiKey = () => {
    svcRef.current.saveGeminiKey(geminiKeyInput);
    const hasKey = !!geminiKeyInput.trim();
    svcRef.current.geminiStatus = hasKey ? 'ready' : 'idle';
    setModelServices(prev => ({ ...prev, geminiApi: hasKey }));
    setGeminiKeySaved(true);
    setTimeout(() => setGeminiKeySaved(false), 2000);
  };

  const simulateCriticalScenario = () => {
    setEmergencyScenario('kitchen_fire'); setScenarioStep(1); setIsListening(true);
    setTimeout(() => { setScenarioStep(2); setIsProcessing(true); setAudioLevel(85); }, 2000);
    setTimeout(() => {
      setIsProcessing(false);
      const a = { id: Date.now(), type: 'emergency', soundType: 'fire_alarm',
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        severity: 'critical', location: 'Kitchen', confidence: 97,
        source: 'HF AST AI', timestamp: new Date().toISOString() };
      setRecentAlerts(prev => [a, ...prev.slice(0, 9)]);
      setScenarioStep(3);
      alertRef.current.triggerLocalAlert(a);
    }, 4000);
    setTimeout(() => setScenarioStep(4), 6000);
    setTimeout(() => setScenarioStep(5), 8000);
    setTimeout(() => { setEmergencyScenario(null); setScenarioStep(0); setAudioLevel(0); }, 12000);
  };

  // ==================== STATUS BADGE ====================
  const StatusBadge = () => {
    // If Gemini key is configured, show Gemini as primary
    if (modelServices.geminiApi) {
      return (
        <div className="flex items-center space-x-1.5 text-xs px-2 py-1 rounded-full bg-[#00A8E1]/10 text-[#00A8E1]">
          <Cpu className="w-3 h-3" />
          <span>Gemini 2.5 Flash (primary) + HF AST fallback</span>
        </div>
      );
    }
    const badges = {
      idle:         { color: 'bg-white/10 text-white/60',              text: 'Initializing...' },
      checking:     { color: 'bg-[#FFE600]/10 text-[#FFE600]',         text: 'Connecting to AI...' },
      ready:        { color: 'bg-green-500/10 text-green-400',          text: 'HF AST AI ready' },
      warming:      { color: 'bg-[#FFE600]/10 text-[#FFE600]',         text: 'AI warming up (~20s)...' },
      rate_limited: { color: 'bg-[#FFE600]/10 text-[#FFE600]',         text: 'HF rate limited — add API key' },
      offline:      { color: 'bg-[#00A8E1]/10 text-[#00A8E1]',         text: 'Frequency analysis (offline)' },
    };
    const b = badges[hfStatus] || badges.idle;
    const spinning = hfStatus === 'checking' || hfStatus === 'warming';
    return (
      <div className={`flex items-center space-x-1.5 text-xs px-2 py-1 rounded-full ${b.color}`}>
        {spinning
          ? <div className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          : hfStatus === 'offline' ? <CloudOff className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
        <span>{b.text}</span>
      </div>
    );
  };

  // ==================== HOME SCREEN ====================
  const HomeScreen = () => (
    <div className="bg-[#0B1740] min-h-screen">
      <div className="bg-[#1E3FB8] px-6 py-8 text-white border-b border-white/10">
        <div className="flex items-center space-x-4 mb-1">
          <img src={hearoLogo} alt="Hearo" className="w-14 h-14 object-contain drop-shadow-lg" />
          <div>
            <p className="text-[#00A8E1] text-sm font-medium tracking-wide">AI-Powered Sound Alert System</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6 -mt-6 pb-24">
        {/* Status Card */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10 relative z-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold text-white">System Status</h2>
            <div className={`p-2 rounded-full ${isListening ? 'bg-[#00A8E1]/20' : 'bg-white/10'}`}>
              {isListening ? <Volume2 className="w-6 h-6 text-[#00A8E1]" /> : <VolumeX className="w-6 h-6 text-white/50" />}
            </div>
          </div>

          <div className="mb-3"><StatusBadge /></div>

          <div className="flex items-center justify-between mb-4">
            <span className="text-white/70">
              {isListening ? 'Listening for sounds' : isStarting ? 'Starting…' : 'Not listening'}
            </span>
            <button
              onClick={isListening ? stopListening : startListening}
              disabled={isStarting}
              className={`px-6 py-3 rounded-xl font-semibold transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
                isListening
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : isStarting
                  ? 'bg-gray-400 text-white'
                  : 'bg-[#FFE600] hover:bg-[#E6CF00] text-[#1E3FB8] font-bold'
              }`}
            >
              {isListening ? 'Stop' : isStarting ? 'Starting…' : 'Start'}
            </button>
          </div>

          <div className="border-t pt-4">
            <button onClick={simulateCriticalScenario} disabled={!!emergencyScenario}
              className="w-full px-4 py-3 bg-[#FFE600] hover:bg-[#E6CF00] disabled:bg-white/20 disabled:text-white/40 text-[#1E3FB8] rounded-lg font-bold transition-all">
              🚨 Demo: Kitchen Fire Emergency
            </button>
            <p className="text-xs text-white/60 mt-2 text-center">Simulate how Hearo saves lives in critical situations</p>
          </div>

          {isListening && (
            <div className="mt-4">
              <div className="flex justify-between text-sm text-white/70 mb-2">
                <span>Audio Level</span><span>{audioLevel}%</span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-2">
                <div className={`h-2 rounded-full transition-all duration-150 ${
                  audioLevel > 60 ? 'bg-[#FFE600]' : audioLevel > 30 ? 'bg-[#00A8E1]' : 'bg-[#00A8E1]/60'
                }`} style={{ width: `${audioLevel}%` }} />
              </div>
            </div>
          )}

          {emergencyScenario && (
            <div className="mt-4 p-4 bg-red-500/10 border-2 border-red-400/30 rounded-lg">
              <div className="flex items-center space-x-3 mb-3">
                <AlertTriangle className="w-6 h-6 text-red-600 animate-pulse" />
                <h3 className="font-bold text-white">CRITICAL EMERGENCY DETECTED</h3>
              </div>
              <div className="space-y-2 text-sm">
                {[
                  { step: 1, label: '🔥 Fire alarm detected in kitchen (97% confidence)' },
                  { step: 2, label: '🤖 HF AST AI processing emergency sound' },
                  { step: 3, label: '🚨 Emergency alert generated automatically' },
                  { step: 4, label: '📞 Fire department (199) contacted with GPS location' },
                  { step: 5, label: '👨‍👩‍👧‍👦 Family members notified via SMS' },
                ].map(({ step, label }) => (
                  <div key={step} className={`flex items-center space-x-2 ${scenarioStep >= step ? 'text-green-400' : 'text-white/50'}`}>
                    <div className={`w-3 h-3 rounded-full flex-shrink-0 ${scenarioStep >= step ? 'bg-green-500/100' : 'bg-gray-300'}`} />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              {scenarioStep >= 5 && (
                <div className="mt-3 p-3 bg-green-100 border border-green-300 rounded-lg">
                  <p className="text-green-400 font-semibold text-sm">✅ Life-saving response completed in 15 seconds!</p>
                </div>
              )}
            </div>
          )}

          {(isProcessing || warmingUp) && (
            <div className="mt-4 p-3 bg-[#FFE600]/10 rounded-lg border border-[#FFE600]/30">
              <div className="flex items-center space-x-3">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#FFE600]" />
                <span className="text-white font-medium text-sm">
                  {warmingUp ? 'HF model warming up (~20s first time)...' :
                   modelServices.geminiApi ? 'Classifying with Gemini 2.5 Flash...' :
                   'Classifying sound with HF AST AI...'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Live Transcript Panel */}
        {isListening && transcriptEnabled && transcriberRef.current.supported && showTranscript && (
          <div className="bg-[#1E3FB8]/30 rounded-2xl p-5 border border-white/10">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-[#FFE600] rounded-full animate-pulse" />
                <h3 className="text-base font-bold text-white">Live Transcript</h3>
                <span className="text-xs text-white/50">
                  ({transcriptLang === 'th-TH' ? 'Thai' : transcriptLang === 'en-US' ? 'English' : transcriptLang})
                </span>
              </div>
              <button onClick={() => transcriberRef.current.clearTranscript()}
                className="text-xs text-white/50 hover:text-white/70">Clear</button>
            </div>

            {/* Transcript lines */}
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {transcriptLines.length === 0 && !interimText && (
                <p className="text-white/50 text-sm italic">Listening for speech...</p>
              )}
              {transcriptLines.slice(-8).map((line, i) => (
                <div key={i} className="flex items-start space-x-2">
                  <span className="text-xs text-white/50 font-mono flex-shrink-0 mt-0.5">{line.time}</span>
                  <p className="text-sm text-white flex-1">{line.text}</p>
                  <span className="text-xs text-white/50 flex-shrink-0">{line.confidence}%</span>
                </div>
              ))}
              {/* Interim (partial, still being recognised) */}
              {interimText && (
                <p className="text-sm text-white/50 italic">{interimText}...</p>
              )}
            </div>

            {!transcriberRef.current.supported && (
              <p className="text-xs text-[#FFE600] mt-2">⚠️ Speech recognition not supported in this browser. Use Chrome or Edge.</p>
            )}
          </div>
        )}

        {/* Recent Alerts */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-bold text-white mb-4">Recent Alerts</h3>
          {recentAlerts.length === 0
            ? <p className="text-white/50 text-sm text-center py-4">No alerts yet — press Start to begin listening.</p>
            : <div className="space-y-3">
                {recentAlerts.slice(0, 5).map(alert => (
                  <div key={alert.id} className="flex items-center justify-between p-4 bg-white/5 rounded-xl"
                    style={{ borderLeft: `4px solid ${UIUtils.getSeverityColor(alert.severity)}` }}>
                    <div className="flex items-center space-x-4">
                      <div className={`p-2 rounded-lg ${
                        alert.severity === 'critical' ? 'bg-red-500/20' : alert.severity === 'high' ? 'bg-[#FFE600]/20' : 'bg-[#00A8E1]/20'
                      }`}>{UIUtils.getAlertIcon(alert.type)}</div>
                      <div>
                        <p className="font-semibold text-white">{UIUtils.getAlertText(alert.type)}</p>
                        <p className="text-sm text-white/70">{alert.location}</p>
                        <p className="text-xs text-[#00A8E1]">{alert.confidence}% • {alert.source}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-white">{alert.time}</p>
                      <Vibrate className="w-4 h-4 text-white/50 ml-auto mt-1" />
                    </div>
                  </div>
                ))}
              </div>
          }
        </div>

        {/* Somchai */}
        <div className="bg-[#00A8E1]/10 border-2 border-[#00A8E1]/30 rounded-2xl p-6">
          <div className="flex items-start space-x-3 mb-4">
            <div className="w-10 h-10 bg-[#00A8E1]/20 rounded-full flex items-center justify-center flex-shrink-0">
              <Users className="w-5 h-5 text-[#00A8E1]" />
            </div>
            <div>
              <h4 className="font-semibold text-white">Real Impact: Somchai's Story</h4>
              <p className="text-sm text-[#00A8E1] mt-1">
                "Hearo saved my life when I couldn't hear the smoke alarm at 3 AM. The AI detected the fire and notified my neighbors — all within 15 seconds."
              </p>
              <p className="text-xs text-[#00A8E1] mt-2 italic">— Somchai P., Bangkok resident with hearing impairment</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-center text-sm">
            <div><div className="text-2xl font-bold text-red-400">3 AM</div><div className="text-xs text-white/60">Fire started</div></div>
            <div><div className="text-2xl font-bold text-[#FFE600]">15s</div><div className="text-xs text-white/60">Help contacted</div></div>
            <div><div className="text-2xl font-bold text-green-400">5 min</div><div className="text-xs text-white/60">Fire contained</div></div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <button onClick={() => setCurrentScreen('settings')}
            className="bg-[#00A8E1] hover:bg-[#0090C4] text-white p-6 rounded-2xl text-center transition-all border border-[#00A8E1]/50">
            <Settings className="w-8 h-8 mx-auto mb-2" /><span className="font-semibold">Settings</span>
          </button>
          <button onClick={() => setCurrentScreen('emergency')}
            className="bg-red-600 hover:bg-red-700 text-white p-6 rounded-2xl text-center transition-all border border-red-500/50">
            <Shield className="w-8 h-8 mx-auto mb-2" /><span className="font-semibold">Emergency</span>
          </button>
        </div>
      </div>
    </div>
  );

  // ==================== SETTINGS SCREEN ====================
  const SettingsScreen = () => (
    <div className="bg-[#0B1740] min-h-screen">
      <div className="bg-[#1E3FB8] px-6 py-8 text-white border-b border-white/10">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-[#00A8E1] text-sm">Configure your Hearo system</p>
      </div>

      <div className="p-6 space-y-6 -mt-6 pb-24">

        {/* AI Service Status */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10 relative z-10">
          <h3 className="text-lg font-semibold text-white mb-4 flex items-center">
            <Cpu className="w-5 h-5 mr-3 text-[#00A8E1]" />AI Service Status
          </h3>

          {/* Status rows */}
          <div className="space-y-2 mb-4">
            {[
              { label: 'Gemini 2.5 Flash', ok: modelServices.geminiApi,
                detail: modelServices.geminiApi ? 'primary classifier ✓' : 'not configured (add key below)' },
              { label: 'Hugging Face API', ok: modelServices.hfApi,
                detail: hfStatus === 'warming' ? 'warming up...' : hfStatus === 'rate_limited' ? 'rate limited' : hfStatus === 'ready' ? 'connected (fallback)' : hfStatus === 'checking' ? 'checking...' : 'unreachable' },
              { label: 'HF API Key', ok: modelServices.hfAuthenticated,
                detail: modelServices.hfAuthenticated ? 'configured ✓' : 'not set (free tier)' },
              { label: 'Local Storage', ok: modelServices.localStorage, detail: 'alert history' },
            ].map(({ label, ok, detail }) => (
              <div key={label} className={`flex items-center justify-between p-3 rounded-lg ${ok ? 'bg-green-500/10' : 'bg-white/5'}`}>
                <div>
                  <span className="font-medium text-sm">{label}</span>
                  <span className="text-xs text-white/60 ml-2">{detail}</span>
                </div>
                <div className={`w-2.5 h-2.5 rounded-full ${ok ? 'bg-green-500/100' : 'bg-gray-300'}`} />
              </div>
            ))}
          </div>

          {/* Model info */}
          <div className="p-4 bg-[#00A8E1]/10 rounded-xl border border-[#00A8E1]/20 mb-3">
            <div className="flex items-start space-x-3">
              <BarChart2 className="w-5 h-5 text-[#00A8E1] mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-white">Gemini 2.5 Flash (Recommended)</p>
                <p className="text-xs text-[#00A8E1] mt-1">
                  Google's multimodal AI — understands audio directly, identifies sounds <strong>and</strong> transcribes speech in a single call.
                  Free tier: 15 req/min. Significantly more accurate than frequency analysis.
                </p>
              </div>
            </div>
          </div>
          <div className="p-4 bg-[#00A8E1]/10 rounded-xl border border-purple-100">
            <div className="flex items-start space-x-3">
              <BarChart2 className="w-5 h-5 text-[#00A8E1] mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-white">HF AST — Fallback</p>
                <p className="text-xs text-[#00A8E1] mt-1">
                  Audio Spectrogram Transformer, 527 AudioSet classes, 0.459 mAP.
                  Used when Gemini is not configured or unavailable.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Gemini API Key — PRIMARY */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border-2 border-[#00A8E1]/50">
          <div className="flex items-center space-x-2 mb-1">
            <Key className="w-5 h-5 text-[#00A8E1]" />
            <h3 className="text-lg font-semibold text-white">Google Gemini API Key</h3>
            <span className="text-xs bg-[#00A8E1]/20 text-[#00A8E1] px-2 py-0.5 rounded-full font-medium">Recommended</span>
          </div>
          <p className="text-xs text-white/60 mb-4">
            Best accuracy + speech transcription. Free tier available at{' '}
            <span className="text-[#00A8E1] underline">aistudio.google.com/app/apikey</span>
          </p>
          <div className="flex space-x-2">
            <input
              type="password"
              value={geminiKeyInput}
              onChange={e => setGeminiKeyInput(e.target.value)}
              placeholder="AIza..."
              className="flex-1 p-3 bg-white/10 border border-[#00A8E1]/40 rounded-lg text-sm font-mono text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#00A8E1]/50"
            />
            <button onClick={saveGeminiKey}
              className="px-4 py-3 bg-[#00A8E1] hover:bg-[#0090C4] text-white rounded-lg font-semibold text-sm transition-colors">
              {geminiKeySaved ? '✓' : 'Save'}
            </button>
          </div>
          {modelServices.geminiApi && (
            <p className="mt-2 text-xs text-green-600">
              ✅ Gemini active — using as primary classifier with speech transcription.
            </p>
          )}
          {!modelServices.geminiApi && (
            <p className="mt-2 text-xs text-white/60">
              Without a key, falls back to Hugging Face AST (no transcription).
            </p>
          )}
        </div>

        {/* HF API Key Configuration */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-lg font-semibold text-white mb-2 flex items-center">
            <Key className="w-5 h-5 mr-3 text-[#FFE600]" />Hugging Face API Key
          </h3>
          <p className="text-xs text-white/60 mb-4">
            Fallback AI — removes rate limits. Free at{' '}
            <span className="text-[#00A8E1] underline">huggingface.co/settings/tokens</span>
          </p>
          <div className="flex space-x-2">
            <input
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder="hf_xxxxxxxxxxxxxxxxxxxx"
              className="flex-1 p-3 bg-white/10 border border-white/20 rounded-lg text-sm font-mono text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#00A8E1]/50"
            />
            <button onClick={saveApiKey}
              className="px-4 py-3 bg-[#1E3FB8] hover:bg-[#1835A0] text-white rounded-lg font-semibold text-sm transition-colors">
              {apiKeySaved ? '✓' : 'Save'}
            </button>
          </div>
          {hfStatus === 'rate_limited' && (
            <p className="mt-2 text-xs text-[#FFE600]">
              ⚠️ Rate limited — add an API key above or use Gemini as primary.
            </p>
          )}
        </div>

        {/* Live Predictions */}
        {isListening && liveTopPredictions.length > 0 && (
          <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
            <h3 className="text-lg font-semibold text-white mb-4 flex items-center">
              <Activity className="w-5 h-5 mr-3 text-green-600 animate-pulse" />
              Live Predictions
              <span className="ml-2 text-xs text-white/50 font-normal">updates every 8s</span>
            </h3>
            <div className="space-y-3">
              {liveTopPredictions.slice(0, 7).map((pred, i) => (
                <div key={i}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className={`font-medium truncate ${pred.category ? 'text-[#FFE600]' : 'text-white/60'}`}>
                      {pred.className}
                      {pred.category && <span className="ml-1.5 text-xs bg-[#FFE600]/20 text-[#FFE600] px-1.5 py-0.5 rounded-full font-semibold">match</span>}
                    </span>
                    <span className="text-white/60 font-mono ml-2 flex-shrink-0">
                      {Math.round(pred.confidence * 100)}%
                    </span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-2">
                    <div className={`h-2 rounded-full transition-all duration-500 ${pred.category ? 'bg-[#FFE600]' : 'bg-white/20'}`}
                      style={{ width: `${Math.round(pred.confidence * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-white/50 mt-3 text-center">
              Yellow = Hearo-relevant sound detected
            </p>
          </div>
        )}

        {/* Transcription Settings */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-lg font-semibold text-white mb-4 flex items-center">
            <span className="text-xl mr-3">💬</span>Speech Transcription
          </h3>

          <div className="space-y-4">
            {/* Enable toggle */}
            <label className="flex items-center justify-between p-4 bg-white/5 rounded-lg cursor-pointer">
              <div>
                <span className="font-medium">Live Captions</span>
                <p className="text-xs text-white/60 mt-0.5">Transcribe speech while listening (Web Speech API)</p>
              </div>
              <input type="checkbox" checked={transcriptEnabled}
                onChange={e => {
                  setTranscriptEnabled(e.target.checked);
                  if (!e.target.checked) transcriberRef.current.stop();
                }}
                className="w-5 h-5 text-[#00A8E1] rounded" />
            </label>

            {/* Show/hide on home */}
            <label className="flex items-center justify-between p-4 bg-white/5 rounded-lg cursor-pointer">
              <div>
                <span className="font-medium">Show on Home Screen</span>
                <p className="text-xs text-white/60 mt-0.5">Display transcript panel while listening</p>
              </div>
              <input type="checkbox" checked={showTranscript}
                onChange={e => setShowTranscript(e.target.checked)}
                className="w-5 h-5 text-[#00A8E1] rounded" />
            </label>

            {/* Language selector */}
            <div>
              <label className="block text-sm font-medium text-white/90 mb-2">Transcription Language</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { code: 'th-TH', label: '🇹🇭 Thai' },
                  { code: 'en-US', label: '🇺🇸 English' },
                ].map(({ code, label }) => (
                  <button key={code}
                    onClick={() => {
                      setTranscriptLang(code);
                      transcriberRef.current.setLanguage(code);
                    }}
                    className={`p-2 rounded-lg text-sm font-medium border transition-colors ${
                      transcriptLang === code
                        ? 'bg-[#1E3FB8] text-white border-purple-600'
                        : 'bg-white/5 text-white/70 border-white/10 hover:bg-white/10'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Browser support note */}
            <div className="p-3 bg-[#00A8E1]/10 rounded-lg">
              <p className="text-xs text-[#00A8E1]">
                <strong>Web Speech API</strong> — built into Chrome & Edge. Gemini transcribes Thai &amp; English only.
                {!transcriberRef.current.supported && (
                  <span className="text-[#FFE600] block mt-1">⚠️ Not supported in this browser.</span>
                )}
              </p>
            </div>

            {/* Live transcript preview in settings */}
            {isListening && transcriptLines.length > 0 && (
              <div className="p-3 bg-white/5 rounded-lg border border-white/10 max-h-32 overflow-y-auto">
                <p className="text-xs text-white/60 mb-2">Recent transcript:</p>
                {transcriptLines.slice(-5).map((line, i) => (
                  <p key={i} className="text-sm text-white/90">{line.text}</p>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Detection Config */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-semibold text-white mb-4 flex items-center">
            <Wifi className="w-6 h-6 mr-3 text-[#00A8E1]" />Detection Configuration
          </h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/90 mb-2">Detection Sensitivity</label>
              <input type="range" min="1" max="10" value={sensitivity}
                onChange={e => { const v = parseInt(e.target.value); setSensitivity(v); classRef.current.setSensitivity(v); }}
                className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer" />
              <div className="flex justify-between text-xs text-white/60 mt-1">
                <span>Conservative</span>
                <span className="font-mono text-[#00A8E1]">{sensitivity}/10</span>
                <span>Aggressive</span>
              </div>
              <p className="text-xs text-white/50 mt-1">
                HF confidence threshold: {Math.round(Math.max(0.12, 0.55 - (sensitivity / 10) * 0.43) * 100)}%
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-white/90 mb-2">Active AI Mode</label>
              <div className="p-3 bg-white/5 rounded-lg text-sm text-white/90 border border-white/10">
                {modelServices.geminiApi ? '✅ Gemini 2.5 Flash (primary) → HF AST (fallback) → Frequency analysis' :
                 hfStatus === 'ready' ? '✅ Hugging Face AST (cloud AI, 527 AudioSet classes)' :
                 hfStatus === 'warming' ? '⏳ HF AST warming up — using frequency analysis' :
                 hfStatus === 'rate_limited' ? '⚠️ HF rate limited — add API key or use Gemini' :
                 hfStatus === 'checking' ? '🔄 Connecting to Hugging Face...' :
                 '⚡ Frequency analysis (HF offline — check internet)'}
              </div>
            </div>
          </div>
        </div>

        {/* Alert Preferences */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-semibold text-white mb-4 flex items-center">
            <Vibrate className="w-6 h-6 mr-3 text-[#00A8E1]" />Alert Preferences
          </h3>
          {Object.entries(vibrationSettings).map(([type, intensity]) => (
            <div key={type} className="mb-6 last:mb-0">
              <div className="flex items-center space-x-3 mb-3">
                <div className="text-[#00A8E1]">{UIUtils.getAlertIcon(type)}</div>
                <span className="font-medium text-white">{UIUtils.getAlertText(type)}</span>
              </div>
              <div className="space-y-2">
                {['gentle', 'medium', 'strong'].map(level => (
                  <label key={level} className="flex items-center space-x-4 p-3 bg-white/5 rounded-lg cursor-pointer hover:bg-white/10">
                    <input type="radio" name={`v-${type}`} checked={intensity === level}
                      onChange={() => setVibrationSettings(prev => ({ ...prev, [type]: level }))}
                      className="w-5 h-5 text-[#00A8E1]" />
                    <div className="flex-1 flex items-center justify-between">
                      <span className="font-medium capitalize">{level}</span>
                      <span className="font-mono text-[#FFE600]">
                        {level === 'gentle' ? '•••' : level === 'medium' ? '•••••' : '•••••••'}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Output Methods */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-semibold text-white mb-4">Output Methods</h3>
          <div className="space-y-4">
            {[
              { Icon: Smartphone, color: 'text-[#00A8E1]', label: 'Screen Flash', on: true },
              { Icon: Watch, color: 'text-[#FFE600]', label: 'Smartwatch Integration', on: true },
              { Icon: Lightbulb, color: 'text-[#FFE600]', label: 'Smart Home Lights', on: false },
              { Icon: Users, color: 'text-[#00A8E1]', label: 'Family Network Alerts', on: true },
            ].map(({ Icon, color, label, on }) => (
              <label key={label} className="flex items-center justify-between p-4 bg-white/5 rounded-lg cursor-pointer">
                <div className="flex items-center space-x-3">
                  <Icon className={`w-6 h-6 ${color}`} />
                  <span className="font-medium">{label}</span>
                </div>
                <input type="checkbox" defaultChecked={on} className="w-5 h-5 text-[#00A8E1] rounded" />
              </label>
            ))}
          </div>
        </div>

        {/* Vibration Test */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-semibold text-white mb-4">Test Vibration Patterns</h3>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => navigator.vibrate && navigator.vibrate([0, 150])}
              className="p-4 bg-green-500/10 hover:bg-green-100 border border-green-200 rounded-lg text-center transition-colors">
              <div className="text-green-600 font-medium">Gentle</div>
              <div className="text-xs text-green-500 mt-1">[0, 150]</div>
            </button>
            <button onClick={() => navigator.vibrate && navigator.vibrate([0, 200, 100, 200])}
              className="p-4 bg-yellow-50 hover:bg-yellow-100 border border-yellow-200 rounded-lg text-center transition-colors">
              <div className="text-[#FFE600] font-medium">Medium</div>
              <div className="text-xs text-[#FFE600]/80 mt-1">[0, 200, 100, 200]</div>
            </button>
            <button onClick={() => navigator.vibrate && navigator.vibrate([0, 300, 150, 300, 150, 300])}
              className="p-4 bg-[#FFE600]/10 hover:bg-[#FFE600]/20 border border-[#FFE600]/30 rounded-lg text-center transition-colors">
              <div className="text-[#FFE600] font-medium">Strong</div>
              <div className="text-xs text-[#FFE600] mt-1">[0, 300, 150, 300]</div>
            </button>
            <button onClick={() => navigator.vibrate && navigator.vibrate([0, 500, 100, 500, 100, 500])}
              className="p-4 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg text-center transition-colors">
              <div className="text-red-600 font-medium">Emergency</div>
              <div className="text-xs text-red-500 mt-1">[0, 500, 100, 500…]</div>
            </button>
          </div>
          <button onClick={() => navigator.vibrate && navigator.vibrate(0)}
            className="w-full mt-3 p-3 bg-white/10 hover:bg-white/15 border border-white/15 rounded-lg text-white/70 font-medium transition-colors">
            Cancel Vibration
          </button>
        </div>

        {/* Performance */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-semibold text-white mb-4">System Performance</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="p-3 bg-[#00A8E1]/10 rounded-lg">
              <div className="font-medium text-white">Primary AI</div>
              <div className="text-lg font-bold text-[#00A8E1]">{modelServices.geminiApi ? 'Gemini' : 'HF AST'}</div>
              <div className="text-xs text-[#00A8E1]">{modelServices.geminiApi ? '+ transcription' : '0.459 mAP'}</div>
            </div>
            <div className="p-3 bg-green-500/10 rounded-lg">
              <div className="font-medium text-white/70">Sound Classes</div>
              <div className="text-2xl font-bold text-green-400">527</div>
              <div className="text-xs text-green-400/70">AudioSet categories</div>
            </div>
            <div className="p-3 bg-[#00A8E1]/10 rounded-lg">
              <div className="font-medium text-white/70">Inference</div>
              <div className="text-2xl font-bold text-[#00A8E1]">~2s</div>
              <div className="text-xs text-[#00A8E1]/70">per classification</div>
            </div>
            <div className="p-3 bg-[#FFE600]/10 rounded-lg">
              <div className="font-medium text-white/70">Alerts Stored</div>
              <div className="text-2xl font-bold text-[#FFE600]">
                {(() => { try { return JSON.parse(localStorage.getItem('hearo_alerts') || '[]').length; } catch (_) { return 0; } })()}
              </div>
              <div className="text-xs text-[#FFE600]/70">30-day history</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // ==================== EMERGENCY SCREEN ====================
  const EmergencyScreen = () => (
    <div className="bg-[#0B1740] min-h-screen">
      <div className="bg-red-700 px-6 py-8 text-white border-b border-white/10">
        <h1 className="text-2xl font-bold">Emergency</h1>
        <p className="text-red-100 text-sm">AI-powered emergency response</p>
      </div>
      <div className="p-6 space-y-6 -mt-1 pb-24">
        <div className="grid gap-4 relative z-10">
          {[
            { bg: 'bg-red-600 hover:bg-red-700',         Icon: AlertTriangle, t: 'Emergency 191',    s: 'Thai Emergency Services' },
            { bg: 'bg-red-800 hover:bg-red-900',         Icon: Shield,        t: 'Fire Department',  s: 'Call 199 • Auto-detection enabled' },
            { bg: 'bg-[#00A8E1] hover:bg-[#0090C4]',    Icon: Phone,         t: 'Medical Emergency', s: 'Call 1669 • Health monitoring' },
            { bg: 'bg-[#1E3FB8] hover:bg-[#1835A0]',    Icon: Users,         t: 'Family Network',   s: '3 contacts • GPS location sharing' },
          ].map(({ bg, Icon, t, s }) => (
            <button key={t} className={`${bg} text-white p-8 rounded-2xl text-center border border-white/10 transition-all`}>
              <Icon className="w-12 h-12 mx-auto mb-3" />
              <span className="text-xl font-bold">{t}</span>
              <p className="text-sm mt-2 opacity-90">{s}</p>
            </button>
          ))}
        </div>
        <div className="bg-[#1E3FB8]/30 border-2 border-[#00A8E1]/30 rounded-2xl p-6">
          <div className="flex items-start space-x-3 mb-4">
            <AlertTriangle className="w-6 h-6 text-[#00A8E1] mt-1 flex-shrink-0" />
            <div>
              <h4 className="font-semibold text-white">Intelligent Emergency Detection</h4>
              <p className="text-sm text-[#00A8E1] mt-1">
                Gemini 2.5 Flash AI (or HF AST fallback) automatically classifies 527 sound categories — including fire alarms, screaming, and glass breaking — and transcribes speech during emergencies.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            {['Fire alarm detection', 'Glass breaking alerts', 'Distress call recognition', 'Auto-location sharing'].map(f => (
              <div key={f} className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-green-500/100 rounded-full" /><span>{f}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-lg font-semibold text-white mb-4">Emergency Response Analytics</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div><div className="text-2xl font-bold text-red-600">15s</div><div className="text-sm text-white/70">Avg Response</div></div>
            <div><div className="text-2xl font-bold text-green-600">100%</div><div className="text-sm text-white/70">Alert Success</div></div>
            <div><div className="text-2xl font-bold text-[#00A8E1]">24/7</div><div className="text-sm text-white/70">Monitoring</div></div>
          </div>
        </div>
      </div>
    </div>
  );

  // ==================== RENDER ====================
  return (
    <div className="max-w-md mx-auto bg-[#0B1740] min-h-screen text-white">
      <div className="pb-20">
        {currentScreen === 'home'      && <HomeScreen />}
        {currentScreen === 'settings'  && <SettingsScreen />}
        {currentScreen === 'emergency' && <EmergencyScreen />}
      </div>

      <div className="fixed bottom-0 left-1/2 transform -translate-x-1/2 w-full max-w-md bg-[#0B1740] border-t border-white/10 z-50 shadow-lg">
        <div className="grid grid-cols-3 p-2">
          {[
            { s: 'home',      Icon: Home,    label: 'Home',      ac: 'text-[#FFE600] bg-[#FFE600]/10' },
            { s: 'settings',  Icon: Settings, label: 'Settings', ac: 'text-[#FFE600] bg-[#FFE600]/10' },
            { s: 'emergency', Icon: Shield,   label: 'Emergency', ac: 'text-red-400 bg-red-500/10' },
          ].map(({ s, Icon, label, ac }) => (
            <button key={s} onClick={() => setCurrentScreen(s)}
              className={`p-4 text-center transition-colors ${currentScreen === s ? ac : 'text-white/50'} rounded-lg`}
              aria-label={label}>
              <Icon className="w-6 h-6 mx-auto mb-1" />
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sr-only" aria-live="polite">
        {isListening && recentAlerts.length > 0 &&
          `Hearo detected ${UIUtils.getAlertText(recentAlerts[0].type)} at ${recentAlerts[0].location} with ${recentAlerts[0].confidence}% confidence`}
      </div>
    </div>
  );
};

export default HearoApp;
