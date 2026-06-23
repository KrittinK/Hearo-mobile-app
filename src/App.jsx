import React, { useState, useEffect, useRef } from 'react';
import { Bell, Home, Settings, Shield, Phone, Baby, Car, AlertTriangle, Volume2, VolumeX, Smartphone, Watch, Lightbulb, Vibrate, Users, Wifi, Cpu, BarChart2, Activity, Key } from 'lucide-react';
import * as tf from '@tensorflow/tfjs';
import hearoLogo from './images/Hearo.png';

// ==================== CONFIGURATION ====================
const DetectionConfig = {
  sampleRate: 16000,
  bufferDuration: 4,
  detectionInterval: 2000, // 2s — YAMNet is on-device, no rate limit
  defaultSensitivity: 7,
  // YAMNet — Google's on-device audio classifier, 521 AudioSet classes
  yamnetModelUrl: '/models/yamnet/model.json', // hosted locally — avoids TFHub/Kaggle CORS
  yamnetClassesUrl: 'https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv',
  // Custom fine-tuned head — trained on ESC-50, runs on top of YAMNet embeddings
  hearoModelUrl:   '/models/hearo/model.json',
  hearoLabelsUrl:  '/models/hearo/labels.json',
  hearoMappingUrl: '/models/hearo/esc50_to_hearo.json',
  // Gemini — kept for transcription only in this build
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

// ==================== YAMNET CLASSIFIER ====================
// On-device audio classifier using Google's YAMNet model via TensorFlow.js
// 521 AudioSet classes, runs at ~0.1s per call, no internet required after load
class YamNetClassifier {
  constructor() {
    this.model      = null;
    this.classNames = [];       // 521 class name strings
    this.status     = 'idle';   // idle | loading | ready | error
    this.onStatusChange = null; // (status) => void
    this.sensitivityThreshold = 0.42;

    // Custom fine-tuned ESC-50 head (optional, runs on YAMNet embeddings)
    this.customModel   = null;
    this.customLabels  = [];     // 50 ESC-50 class names
    this.customMapping = {};     // esc50_label → Hearo category
    this.customStatus  = 'idle'; // idle | loading | ready | error
    this.onCustomStatusChange = null;
    this.useCustom     = false;  // A/B switch: true = custom model, false = stock YAMNet
  }

  setSensitivity(v) {
    this.sensitivityThreshold = Math.max(0.30, 0.70 - (v / 10) * 0.40);
  }

  // Load model + class names (call once on app start)
  async load() {
    if (this.status === 'ready' || this.status === 'loading') return this.status === 'ready';
    this.status = 'loading';
    if (this.onStatusChange) this.onStatusChange('loading');
    try {
      // Load class names (try cache → network → built-in fallback)
      this.classNames = await this._loadClassNames();
      console.log(`✅ YAMNet class names loaded: ${this.classNames.length}`);

      // Load TF.js model from local public/ folder (avoids TFHub/Kaggle CORS)
      console.log('⏳ Loading YAMNet model (~15MB)...');
      this.model = await tf.loadGraphModel(
        DetectionConfig.yamnetModelUrl
      );
      console.log('✅ YAMNet model ready');

      // Warm up with a tiny silent inference
      const warmup = tf.zeros([16000]);
      try { const o = this.model.execute(warmup); if (Array.isArray(o)) o.forEach(t => t.dispose()); else o.dispose(); } catch (_) {}
      warmup.dispose();

      this.status = 'ready';
      if (this.onStatusChange) this.onStatusChange('ready');
      return true;
    } catch (e) {
      console.error('❌ YAMNet load failed:', e.message);
      this.status = 'error';
      if (this.onStatusChange) this.onStatusChange('error');
      return false;
    }
  }

  // Load the custom fine-tuned ESC-50 head (call once, after load()).
  // It takes YAMNet's 1024-dim embeddings and outputs 50 ESC-50 probabilities.
  async loadCustom() {
    if (this.customStatus === 'ready' || this.customStatus === 'loading') {
      return this.customStatus === 'ready';
    }
    this.customStatus = 'loading';
    if (this.onCustomStatusChange) this.onCustomStatusChange('loading');
    try {
      const [model, labels, mapping] = await Promise.all([
        tf.loadGraphModel(DetectionConfig.hearoModelUrl),
        fetch(DetectionConfig.hearoLabelsUrl).then(r => r.json()),
        fetch(DetectionConfig.hearoMappingUrl).then(r => r.json()),
      ]);
      this.customModel   = model;
      this.customLabels  = labels;
      this.customMapping = mapping;

      // Warm up with a dummy embedding batch
      const warm = tf.zeros([3, 1024]);
      try { const o = warm; const r = this.customModel.execute(warm); r.dispose(); o.dispose(); }
      catch (_) { warm.dispose(); }

      this.customStatus = 'ready';
      if (this.onCustomStatusChange) this.onCustomStatusChange('ready');
      console.log(`✅ Custom ESC-50 model ready (${labels.length} classes)`);
      return true;
    } catch (e) {
      console.warn('⚠️ Custom model load failed:', e.message);
      this.customStatus = 'error';
      if (this.onCustomStatusChange) this.onCustomStatusChange('error');
      return false;
    }
  }

  async _loadClassNames() {
    // 1. Try localStorage cache
    try {
      const cached = localStorage.getItem('hearo_yamnet_classes');
      if (cached) {
        const arr = JSON.parse(cached);
        if (Array.isArray(arr) && arr.length >= 500) return arr;
      }
    } catch (_) {}

    // 2. Fetch CSV from GitHub
    try {
      const res = await fetch(DetectionConfig.yamnetClassesUrl, { signal: AbortSignal.timeout(10000) });
      const csv = await res.text();
      // CSV format: index,mid,display_name  (display_name may be quoted)
      const names = csv.trim().split('\n').slice(1).map(line => {
        const parts = line.split(',');
        const name = parts.slice(2).join(',').replace(/^"|"$/g, '').trim();
        return name;
      });
      try { localStorage.setItem('hearo_yamnet_classes', JSON.stringify(names)); } catch (_) {}
      return names;
    } catch (e) {
      console.warn('Using built-in YAMNet class fallback');
    }

    // 3. Built-in fallback — key classes at their correct indices
    const fallback = Array.from({ length: 521 }, (_, i) => `class_${i}`);
    const known = {
      0:'Speech', 1:'Male speech, man speaking', 2:'Female speech, woman speaking',
      3:'Child speech, kid speaking', 6:'Whispering', 14:'Crying, sobbing',
      17:'Baby cry, infant cry', 18:'Screaming', 19:'Shout',
      74:'Dog', 75:'Bark', 76:'Bow-wow', 77:'Growling',
      300:'Car alarm', 301:'Honking', 302:'Car horn, automobile horn',
      363:'Telephone bell ringing', 372:'Doorbell, cowbell', 374:'Ding-dong',
      388:'Fire alarm', 389:'Smoke detector, smoke alarm',
      390:'Alarm clock', 391:'Alarm',
      393:'Siren', 394:'Civil defense siren', 395:'Ambulance (siren)',
      396:'Fire engine, fire truck (siren)', 397:'Police car (siren)',
      427:'Breaking', 428:'Glass',
      429:'Knock', 430:'Tap', 431:'Rapping',
    };
    Object.entries(known).forEach(([i, n]) => { fallback[parseInt(i)] = n; });
    return fallback;
  }

  // Classify a Float32Array of 16kHz mono audio samples
  // Returns [{className, confidence, category}] sorted by confidence
  async classify(audioSamples) {
    if (!this.model || this.status !== 'ready') return null;

    const startTime = performance.now();
    const waveform = tf.tensor1d(audioSamples);
    let outputs;
    try {
      outputs = this.model.execute(waveform);
    } catch (e) {
      waveform.dispose();
      console.warn('YAMNet execute error:', e.message);
      return null;
    }

    try {
      // YAMNet outputs: [scores[frames, 521], embeddings[frames,1024], spectrogram[frames,64]]
      const arr = Array.isArray(outputs) ? outputs : [outputs];

      // ---- Custom fine-tuned ESC-50 head (preferred when enabled) ----
      // Pick the YAMNet output that is the 1024-dim embedding (don't assume index)
      const embeddings = arr.find(t => t.shape[t.shape.length - 1] === 1024);
      if (this.useCustom && this.customModel && embeddings) {
        const logits     = this.customModel.execute(embeddings); // [frames, 50]
        const meanProbs  = logits.mean(0);                  // [50]
        const probsData  = await meanProbs.data();
        const processingTime = `${((performance.now() - startTime) / 1000).toFixed(2)}s`;

        let predictions = Array.from(probsData)
          .map((score, i) => {
            const label = this.customLabels[i] || `class_${i}`;
            return { className: label, confidence: score, category: this.customMapping[label] || null };
          });

        logits.dispose();
        meanProbs.dispose();

        // Safety net: ESC-50 has no fire/smoke-alarm class, but YAMNet's 521
        // scores were computed in the SAME execute() call above. Read the
        // strongest fire-alarm score from those scores (free — no extra pass)
        // and merge it so the most safety-critical sound is never missed.
        // Wrapped so a failure here can never take down the primary result.
        try {
          const fire = await this._yamnetFireAlarmPrediction(arr, embeddings);
          if (fire) predictions.push(fire);
        } catch (_) { /* fire-alarm safety net is best-effort */ }

        predictions = predictions
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 15);

        return { predictions, processingTime };
      }

      // ---- Stock YAMNet (521 AudioSet classes) ----
      const scoresTensor = arr[0];
      const meanScores   = scoresTensor.mean(0);          // [521]
      const scoresData   = await meanScores.data();        // Float32Array(521)

      const processingTime = `${((performance.now() - startTime) / 1000).toFixed(2)}s`;

      const predictions = Array.from(scoresData)
        .map((score, i) => ({
          className:  this.classNames[i] || `class_${i}`,
          confidence: score,
          category:   matchAudioSetLabel(this.classNames[i] || ''),
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 15);

      meanScores.dispose();
      return { predictions, processingTime };
    } finally {
      waveform.dispose();
      if (Array.isArray(outputs)) outputs.forEach(t => t.dispose());
      else outputs.dispose();
    }
  }

  // From YAMNet's 521-class scores (already computed in the same execute call),
  // return the strongest fire/smoke-alarm prediction, or null. Lets the custom
  // ESC-50 model still catch the most safety-critical sound it wasn't trained on.
  async _yamnetFireAlarmPrediction(outputArr, embeddings) {
    const n = this.classNames.length;
    const scoresT = outputArr.find(t => t !== embeddings && t.shape[t.shape.length - 1] === n);
    if (!scoresT) return null;

    const ms = scoresT.mean(0);
    const sd = await ms.data();
    ms.dispose();

    let best = { conf: 0, name: '' };
    for (let i = 0; i < sd.length; i++) {
      if (matchAudioSetLabel(this.classNames[i] || '') === 'fire_alarm' && sd[i] > best.conf) {
        best = { conf: sd[i], name: this.classNames[i] };
      }
    }
    if (best.conf <= 0) return null;
    return { className: best.name, confidence: best.conf, category: 'fire_alarm' };
  }
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

    // This build classifies sounds on-device with YAMNet — no Hugging Face ping.
    // Gemini (if configured) is used only for optional transcription.
    this.hfStatus = 'offline';
    if (onStatusChange) onStatusChange({ ...this.services }, this.hfStatus);
    return true;
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
      // Mobile (Android/iOS) starts the AudioContext SUSPENDED — it must be
      // resumed from a user gesture or onaudioprocess never fires and detection
      // silently does nothing. This runs inside the Start-button click chain.
      if (this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume(); } catch (_) {}
      }
      console.log(`🎤 AudioContext state: ${this.audioContext.state}, sampleRate: ${this.audioContext.sampleRate}`);
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
    let lastEmit = 0;
    const tick = () => {
      if (!this.analyser || !this.isActive) return;
      this.analyser.getByteFrequencyData(arr);
      let sum = 0;
      for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
      this.audioLevel = Math.round((Math.sqrt(sum / arr.length) / 128) * 100);
      // Throttle React updates to ~10/sec so the UI isn't re-rendering 60fps
      const now = performance.now();
      if (this.onAudioLevelChange && now - lastEmit >= 100) {
        lastEmit = now;
        this.onAudioLevelChange(this.audioLevel);
      }
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
  constructor(serviceManager, yamnet) {
    this.svc = serviceManager;
    this.yamnet = yamnet;           // YamNetClassifier instance
    this.isProcessing = false;
    this.onProcessingChange = null;
    this.onTopPredictionsUpdate = null;
    this.sensitivityThreshold = 0.42;
    this.warmingUp = false;
    this.currentAbort = null;
    this.onTranscriptUpdate = null;
  }

  setSensitivity(v) {
    // v=1 (conservative) → 66%, v=5 → 50%, v=7 (default) → 42%, v=10 (aggressive) → 30%
    this.sensitivityThreshold = Math.max(0.30, 0.70 - (v / 10) * 0.40);
    if (this.yamnet) this.yamnet.setSensitivity(v);
  }

  abort() {
    if (this.currentAbort) { this.currentAbort.abort(); this.currentAbort = null; }
    this.isProcessing = false;
    if (this.onProcessingChange) this.onProcessingChange(false);
  }

  async classifySound(audioBuffer, freqData, fastMode = false) {
    if (this.isProcessing) return null;
    this.isProcessing = true;
    if (this.onProcessingChange) this.onProcessingChange(true);
    try {
      // On-device model (YAMNet / custom ESC-50) is the ONLY alert classifier.
      // Its answer is authoritative — null means "no alert-worthy sound".
      // The old frequency-analysis heuristic is intentionally NOT used for alerts:
      // it invented false "Screaming/Emergency" hits from ordinary room noise.
      if (this.yamnet?.status === 'ready' && audioBuffer) {
        return await this.classifyWithYamNet(audioBuffer);
      }
      // Model not ready (loading/idle/error) — stay silent, never guess.
      return null;
    } catch (e) {
      console.warn('Classification error:', e.message);
      this.lastError = e.message;   // surface swallowed errors in debug
      return null;
    } finally {
      this.isProcessing = false;
      if (this.onProcessingChange) this.onProcessingChange(false);
    }
  }

  // Returns { predictions, processingTime } — the alert decision is made by the
  // caller (runDetection) so it renders live and can't be lost mid-classify.
  async classifyWithYamNet(audioBuffer) {
    const result = await this.yamnet.classify(audioBuffer);
    if (!result) return null;
    const { predictions, processingTime } = result;
    if (this.onTopPredictionsUpdate) this.onTopPredictionsUpdate(predictions);
    return { predictions, processingTime };
  }

  async classifyWithGemini(audioBuffer, fastMode = false) {
    const startTime = performance.now();
    this.currentAbort = new AbortController();
    const { signal } = this.currentAbort;
    try {
      console.log(`🎙️ Gemini [${fastMode ? 'fast/sounds' : 'full/sounds+transcript'}]...`);
      const wavBlob = encodeWAV(audioBuffer, DetectionConfig.sampleRate);
      const base64Audio = await blobToBase64(wavBlob);
      if (signal.aborted) return null;

      // Fast mode: sounds-only prompt — leaner response, ~0.5s faster
      // Used when detection interval ≤ 4s (paid tier) since Web Speech handles transcription
      const fastPrompt = `Detect sounds in this 2-second audio. Return ONLY JSON:
{"sounds":[{"label":"<name>","confidence":<0.0-1.0>}]}

Label these EXACTLY if heard (confidence ≥ 0.2):
fire alarm, smoke detector, siren, baby cry, dog bark, doorbell, phone ringing, car horn, glass breaking, screaming, knocking, alarm, speech

Return {"sounds":[]} if none detected. No other text.`;

      const fullPrompt = `You are an environmental sound classifier for a hearing-impaired alert system. Your PRIMARY job is to detect important non-speech sounds.

Listen carefully to this 2-second audio clip and return ONLY a JSON object:
{
  "sounds": [{"label": "<sound name>", "confidence": <0.0 to 1.0>}],
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

      const prompt = fastMode ? fastPrompt : fullPrompt;

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
      // Fast mode has no transcript field — Web Speech API handles transcription instead
      const transcript = fastMode ? '' : (typeof parsed?.transcript === 'string' ? parsed.transcript.trim() : '');
      const processingTime = `${((performance.now() - startTime) / 1000).toFixed(1)}s`;

      // Build topPredictions for display (filter out "speech" — not an alert category)
      const topPredictions = sounds
        .filter(s => s.label && s.label.toLowerCase() !== 'speech')
        .sort((a, b) => b.confidence - a.confidence)
        .map(s => ({
          className: s.label,
          confidence: s.confidence,
          category: matchAudioSetLabel(s.label),
        }));

      if (this.onTopPredictionsUpdate) this.onTopPredictionsUpdate(topPredictions);

      // Best Hearo-relevant sound above threshold
      const best = topPredictions.find(p => p.category && p.confidence >= this.sensitivityThreshold);

      // Surface transcript to panel even when no alert triggered
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

    this.recognition.onstart = () => console.log(`🎙️ Speech recognition started (${lang})`);

    this.recognition.onerror = (e) => {
      // Log so mobile failures are diagnosable (was silently swallowed before)
      console.warn(`🎙️ Speech recognition error: ${e.error}`);
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
    // Register service worker so Android can show real system notifications
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/sw.js');
      } catch (_) {}
    }
  }

  async requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }

  async _showNotification(title, options) {
    // Use SW registration on Android (shows in notification bar);
    // fall back to new Notification() on desktop browsers.
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, options);
        return;
      }
    } catch (_) {}
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, options); // eslint-disable-line no-new
    }
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
      rawLabel: c.rawLabel || null,   // specific YAMNet class name e.g. "Police car (siren)"
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
    this.stopAlertHaptics(); // cancel any previous loop (phone + watch)

    document.body.style.backgroundColor = this.severityColor(alert.severity);
    setTimeout(() => { document.body.style.backgroundColor = ''; }, 300);
    this.playTone(alert.severity);

    // Phone haptic pattern (the watch ignores the pattern, see below)
    const p = this.vibrationPattern(alert.severity);
    if ('vibrate' in navigator) navigator.vibrate(p);

    const notify = (n) => {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      this._showNotification(`Hearo: ${alert.soundType.replace(/_/g, ' ')}`, {
        body: `${alert.location} — ${alert.confidence}% confidence`,
        icon: '/logo192.png', badge: '/favicon.ico',
        tag: 'hearo-alert',
        renotify: true,          // re-alert (re-buzz the watch) on each re-fire
        requireInteraction: alert.severity === 'critical',
        vibrate: p,
      });
    };

    // Wear OS can't receive a custom haptic waveform from a web app — it plays
    // one default buzz per notification. So we encode each severity as a *buzz
    // cadence* by re-firing the notification: the phone re-vibrates and the
    // watch re-buzzes once per fire.
    //  critical → non-stop until dismissed   high → 3   medium → 2   low → 1
    notify();
    const patMs = p.reduce((a, b) => a + b, 0);
    if (alert.severity === 'critical') {
      // Near-continuous: re-fire with only a tiny gap so the phone feels like
      // a non-stop ring, and the watch re-buzzes as often as it'll allow.
      this._alertInterval = setInterval(() => {
        if ('vibrate' in navigator) navigator.vibrate(p);
        notify();
      }, patMs + 150);
    } else {
      const buzzes = { high: 3, medium: 2, low: 1 }[alert.severity] || 1;
      let count = 1;
      if (buzzes > 1) {
        this._alertInterval = setInterval(() => {
          if (count >= buzzes) { this.stopAlertHaptics(); return; }
          count++;
          if ('vibrate' in navigator) navigator.vibrate(p);
          notify();
        }, patMs + 400); // distinct, countable buzzes
      }
    }
  }

  severityColor(s) {
    return { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' }[s] || '#eab308';
  }

  vibrationPattern(s) {
    return {
      critical: [500, 100, 500, 100, 500, 100, 500],
      high:     [300, 150, 300, 150, 300],
      medium:   [200, 100, 200],
      low:      [400],
    }[s] || [200, 100, 200];
  }

  stopAlertHaptics() {
    if (this._alertInterval) {
      clearInterval(this._alertInterval);
      this._alertInterval = null;
    }
    if ('vibrate' in navigator) navigator.vibrate(0);
    // Clear the watch/system notification so it stops re-alerting
    try {
      navigator.serviceWorker?.ready.then(reg =>
        reg.getNotifications({ tag: 'hearo-alert' }).then(ns => ns.forEach(n => n.close()))
      );
    } catch (_) {}
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
      // generic types (alert.type)
      emergency: 'Emergency', warning: 'Warning', baby: 'Baby Alert',
      // specific sound categories (alert.soundType)
      fire_alarm: 'Fire Alarm', smoke_detector: 'Smoke Detector',
      doorbell: 'Doorbell', phone_ring: 'Phone Ringing',
      baby_cry: 'Baby Crying', car_horn: 'Car Horn',
      glass_break: 'Glass Breaking', scream: 'Screaming',
      dog_bark: 'Dog Barking', knock: 'Knocking',
      siren: 'Siren', alarm: 'Alarm',
      // legacy / fallback
      phone: 'Phone Call', car: 'Car Horn', dog: 'Dog Barking',
    }[type] || null;
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
  // eslint-disable-next-line no-unused-vars
  const [hfStatus, setHfStatus]             = useState('idle');
  const [modelServices, setModelServices]   = useState({ hfApi: false, hfAuthenticated: false, localStorage: false });
  // eslint-disable-next-line no-unused-vars
  const [apiKeyInput, setApiKeyInput]       = useState('');
  // apiKeySaved removed — HF key UI not used in YAMNet build
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
  const [debugInfo, setDebugInfo]           = useState(null); // on-device diagnostics

  const [transcriptLines, setTranscriptLines]   = useState([]);
  const [interimText, setInterimText]           = useState('');
  const [transcriptLang, setTranscriptLang]     = useState('th-TH');
  const [transcriptEnabled, setTranscriptEnabled] = useState(true);
  const [showTranscript, setShowTranscript]     = useState(true);

  // Detection speed — YAMNet is on-device so 2s is default (no rate limit)
  const [detectionInterval, setDetectionIntervalState] = useState(
    () => parseInt(localStorage.getItem('hearo_detection_interval') || '2000')
  );
  const detectionIntervalRef = useRef(
    parseInt(localStorage.getItem('hearo_detection_interval') || '2000')
  );

  // YAMNet status
  const [yamnetStatus, setYamnetStatus] = useState('idle'); // idle|loading|ready|error
  // Custom fine-tuned model status + A/B mode ('stock' | 'custom')
  const [customStatus, setCustomStatus] = useState('idle'); // idle|loading|ready|error
  const [modelMode, setModelMode] = useState(
    () => localStorage.getItem('hearo_model_mode') || 'custom'
  );

  const yamnetRef      = useRef(new YamNetClassifier());
  const svcRef         = useRef(new ServiceManager());
  const audioRef       = useRef(new AudioProcessor());
  const classRef       = useRef(new SoundClassifier(svcRef.current, yamnetRef.current));
  const alertRef       = useRef(new AlertProcessor());
  const transcriberRef = useRef(new SpeechTranscriber());
  const intervalRef    = useRef(null);
  const listeningRef   = useRef(false);
  const isStartingRef  = useRef(false);
  const cycleCountRef  = useRef(0); // detection cycles (debug)
  const firedCountRef  = useRef(0); // alerts fired (debug)

  useEffect(() => {
    init();
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // recentAlerts is now updated directly in runDetection (live re-render);
    // onAlertGenerated left unset to avoid double-counting.

    // Wire up transcriber callbacks
    transcriberRef.current.onUpdate = (lines, interim) => {
      setTranscriptLines([...lines]);
      setInterimText(interim);
    };

    // Wire YAMNet status callback and kick off background model load (~15 MB)
    yamnetRef.current.onStatusChange = setYamnetStatus;
    yamnetRef.current.onCustomStatusChange = setCustomStatus;
    yamnetRef.current.useCustom = (modelMode === 'custom');
    // Load YAMNet, then the custom head (both non-blocking background loads)
    yamnetRef.current.load().then(() => yamnetRef.current.loadCustom());

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

  // Extracted so it can be scheduled by both startListening and changeDetectionInterval
  const runDetection = async () => {
    if (!listeningRef.current) return;
    cycleCountRef.current++;
    const level = audioRef.current.getAudioLevel();
    // lastError NOT reset — keep last error visible so it can't be hidden
    const dbg = { level, model: yamnetRef.current.status, filled: !!audioRef.current.bufferFilled,
                  proc: classRef.current.isProcessing, cycle: cycleCountRef.current };
    if (level > 10) {
      const audioBuffer = await audioRef.current.captureAudioBuffer();
      dbg.bufLen = audioBuffer ? audioBuffer.length : 0;
      if (!listeningRef.current) return;
      const freqData = audioRef.current.getFrequencyData();
      setWarmingUp(classRef.current.warmingUp);
      // Fast mode (≤4s): sounds only — Web Speech handles transcription in parallel
      const fastMode = detectionIntervalRef.current <= 4000;
      const out = await classRef.current.classifySound(audioBuffer, freqData, fastMode);
      dbg.err = classRef.current.lastError;
      dbg.outNull = !out;                       // did classifier return nothing?
      if (!listeningRef.current) return;
      setWarmingUp(false);
      setHfStatus(svcRef.current.hfStatus);

      // Decide the alert HERE from the returned predictions — same logic the
      // debug "would-fire" line uses, and it renders live in this same scope.
      const preds = out?.predictions || [];
      const thr = classRef.current.sensitivityThreshold;
      const best = preds.find(p => p.category && p.confidence >= thr);
      const p0 = preds[0];
      dbg.decision = p0 ? `top=${p0.className} cat=${p0.category || 'none'} conf=${(p0.confidence || 0).toFixed(2)} best=${best ? best.className : 'NULL'}` : '—';
      dbg.result = best ? `${best.className} ${Math.round(best.confidence * 100)}%` : 'no-alert';

      if (best) {
        const alertResult = {
          soundType:      best.category,
          rawLabel:       best.className,
          confidence:     Math.round(best.confidence * 100),
          source:         yamnetRef.current.useCustom ? 'Custom ESC-50 (on-device)' : 'YAMNet (on-device)',
          processingTime: out.processingTime,
          topPredictions: preds,
        };
        console.log(`✅ ALERT → ${best.className} ${Math.round(best.confidence * 100)}% → ${best.category}`);
        firedCountRef.current++;
        const alertData = await alertRef.current.processAlert(alertResult);
        if (alertData) setRecentAlerts(prev => [alertData, ...prev.slice(0, 9)]);
      }
      dbg.fires = firedCountRef.current;
    } else {
      dbg.bufLen = 0;
      dbg.result = 'quiet (level≤10)';
    }
    setDebugInfo(dbg);
  };

  const changeModelMode = (mode) => {
    // mode: 'stock' (YAMNet 521) | 'custom' (fine-tuned ESC-50)
    yamnetRef.current.useCustom = (mode === 'custom');
    setModelMode(mode);
    localStorage.setItem('hearo_model_mode', mode);
    setLivePreds([]); // clear stale predictions from the other model
    // Lazy-load the custom head if switching to it for the first time
    if (mode === 'custom' && yamnetRef.current.customStatus === 'idle') {
      yamnetRef.current.loadCustom();
    }
    console.log(`🔀 Detection model → ${mode === 'custom' ? 'Custom ESC-50' : 'Stock YAMNet'}`);
  };

  const changeDetectionInterval = (ms) => {
    detectionIntervalRef.current = ms;
    setDetectionIntervalState(ms);
    localStorage.setItem('hearo_detection_interval', ms.toString());
    // Live-restart the interval if currently listening
    if (listeningRef.current && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = setInterval(runDetection, ms);
      console.log(`⚡ Detection interval changed to ${ms}ms`);
    }
  };

  const startListening = async () => {
    if (listeningRef.current || isStartingRef.current) return;

    // Set guards FIRST so a second click during any await can't double-start
    // (which would leak duplicate audio streams / intervals and break Stop).
    isStartingRef.current = true;
    setIsStarting(true);
    listeningRef.current = true;

    // Request notification permission (must be inside a user gesture)
    try { await alertRef.current.requestNotificationPermission(); } catch (_) {}

    // Bail if the user already pressed Stop while the prompt was open
    if (!listeningRef.current) { setIsStarting(false); isStartingRef.current = false; return; }

    const ok = await audioRef.current.initialize();

    isStartingRef.current = false;
    setIsStarting(false);

    if (!ok) {
      listeningRef.current = false;
      alert('Microphone access denied. Please check permissions.');
      return;
    }

    if (!listeningRef.current) { audioRef.current.stop(); return; }

    setIsListening(true);
    classRef.current.setSensitivity(sensitivity);

    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }

    // Start Web Speech API in parallel — real-time continuous transcription
    if (transcriptEnabled && transcriberRef.current.supported) {
      transcriberRef.current.clearTranscript();
      transcriberRef.current.start(transcriptLang);
    }

    // Start Gemini sound detection loop at configured speed
    intervalRef.current = setInterval(runDetection, detectionIntervalRef.current);
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
    try { transcriberRef.current.clearTranscript(); } catch (_) {}  // clean slate on stop
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    try { alertRef.current.stopAlertHaptics(); } catch (_) {}
    setLivePreds([]);
    setTranscriptLines([]);
    setInterimText('');
    setWarmingUp(false);
  };

  // saveApiKey removed — HF key UI not used in YAMNet build

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
        source: 'YAMNet (on-device)', timestamp: new Date().toISOString() };
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
    // YAMNet (on-device) is the primary sound classifier in this build
    const yamnetBadges = {
      idle:    { color: 'bg-white/10 text-white/60',          text: 'YAMNet: loading model…',      spin: false },
      loading: { color: 'bg-[#FFE600]/10 text-[#FFE600]',     text: 'YAMNet: downloading (~10MB)…', spin: true  },
      ready:   { color: 'bg-green-500/10 text-green-400',      text: 'YAMNet (on-device) ready ✓',  spin: false },
      error:   { color: 'bg-red-500/10 text-red-400',          text: 'YAMNet load error — freq fallback', spin: false },
    };
    const yb = yamnetBadges[yamnetStatus] || yamnetBadges.idle;

    // Gemini badge (shows when key is configured — used for transcription)
    const geminiActive = modelServices.geminiApi;

    return (
      <div className="flex flex-wrap gap-1.5">
        <div className={`flex items-center space-x-1.5 text-xs px-2 py-1 rounded-full ${yb.color}`}>
          {yb.spin
            ? <div className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
            : <Cpu className="w-3 h-3" />}
          <span>{yb.text}</span>
        </div>
        {geminiActive && (
          <div className="flex items-center space-x-1.5 text-xs px-2 py-1 rounded-full bg-[#00A8E1]/10 text-[#00A8E1]">
            <Cpu className="w-3 h-3" />
            <span>Gemini (transcription) ✓</span>
          </div>
        )}
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

          {/* On-device diagnostics — helps debug mobile capture/detection */}
          {isListening && debugInfo && (
            <div className="mb-3 p-3 rounded-lg bg-black/30 border border-white/10 font-mono text-[11px] text-white/80 leading-relaxed">
              <div className="text-[#00A8E1] font-semibold mb-1">🔧 Debug</div>
              <div>mic level: <span className={debugInfo.level > 10 ? 'text-green-400' : 'text-[#FFE600]'}>{debugInfo.level}</span> (need &gt;10)</div>
              <div>buffer filled: <span className={debugInfo.filled ? 'text-green-400' : 'text-red-400'}>{String(debugInfo.filled)}</span> · samples: <span className={debugInfo.bufLen > 0 ? 'text-green-400' : 'text-red-400'}>{debugInfo.bufLen}</span></div>
              <div>model: <span className={debugInfo.model === 'ready' ? 'text-green-400' : 'text-red-400'}>{debugInfo.model}</span> · thr: {Math.round(classRef.current.sensitivityThreshold * 100)}%</div>
              <div>cycle: {debugInfo.cycle} · busy: <span className={debugInfo.proc ? 'text-red-400' : 'text-green-400'}>{String(debugInfo.proc)}</span> · fires: <span className="text-[#FFE600]">{debugInfo.fires ?? 0}</span></div>
              <div>out: <span className={debugInfo.outNull ? 'text-red-400' : 'text-green-400'}>{debugInfo.outNull ? 'NULL (classifier returned nothing)' : 'ok'}</span></div>
              <div>result: <span className="text-white">{debugInfo.result || '—'}</span></div>
              <div>decision: <span className="text-white/80">{debugInfo.decision || '—'}</span></div>
              {debugInfo.err && <div>err: <span className="text-red-400">{debugInfo.err}</span></div>}
              {(() => {
                const wf = liveTopPredictions.find(p => p.category && p.confidence >= classRef.current.sensitivityThreshold);
                return <div>would-fire: <span className={wf ? 'text-green-400' : 'text-white/50'}>{wf ? `${wf.className} ${Math.round(wf.confidence * 100)}%` : 'none'}</span></div>;
              })()}
              <div>last alert: <span className={recentAlerts.length ? 'text-green-400' : 'text-white/50'}>
                {recentAlerts.length ? `${recentAlerts[0].rawLabel || recentAlerts[0].soundType} @ ${recentAlerts[0].time}` : 'none yet'}
              </span> · total: {recentAlerts.length}</div>
              <div className="mt-1 text-white/60">top guesses:</div>
              {liveTopPredictions.slice(0, 4).map((p, i) => (
                <div key={i} className="pl-2">
                  {p.className} <span className={p.confidence >= classRef.current.sensitivityThreshold ? 'text-green-400' : 'text-white/50'}>{Math.round(p.confidence * 100)}%</span>
                  {p.category && <span className="text-[#FFE600]"> →{p.category}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Recent Alerts — shown here at the top so they're immediately visible */}
          {recentAlerts.length > 0 && (
            <div className="mb-3 p-3 rounded-lg bg-[#FFE600]/5 border border-[#FFE600]/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-[#FFE600]">🔔 Recent Alerts ({recentAlerts.length})</span>
                <button onClick={() => { localStorage.removeItem('hearo_alerts'); setRecentAlerts([]); alertRef.current.stopAlertHaptics(); }}
                  className="text-xs px-2 py-1 rounded bg-white/5 text-white/60">Clear</button>
              </div>
              <div className="space-y-1.5">
                {recentAlerts.slice(0, 5).map(alert => (
                  <div key={alert.id} className="flex items-center justify-between text-sm"
                    style={{ borderLeft: `3px solid ${UIUtils.getSeverityColor(alert.severity)}`, paddingLeft: 8 }}>
                    <span className="text-white font-medium">{alert.rawLabel || alert.soundType}</span>
                    <span className="text-white/50 text-xs">{alert.confidence}% · {alert.time}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

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
                  { step: 2, label: '🤖 YAMNet on-device processing emergency sound' },
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
                <div className="mt-3 p-3 bg-green-500/10 border border-green-400/30 rounded-lg">
                  <p className="text-green-400 font-semibold text-sm">✅ Life-saving response completed in 15 seconds!</p>
                </div>
              )}
            </div>
          )}

          {/* Dual-system status when listening */}
          {isListening && (
            <div className="mt-4 space-y-2">
              {/* Sound Detection */}
              <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
                isProcessing ? 'bg-[#FFE600]/10 border-[#FFE600]/30' : 'bg-white/5 border-white/10'
              }`}>
                <div className="flex items-center space-x-2">
                  {isProcessing
                    ? <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-[#FFE600] flex-shrink-0" />
                    : <div className="w-3.5 h-3.5 rounded-full bg-[#00A8E1]/60 flex-shrink-0" />}
                  <span className="text-sm text-white/80">
                    🔊 Sound detection
                  </span>
                </div>
                <span className="text-xs text-white/50 font-mono">
                  every {detectionInterval / 1000}s
                </span>
              </div>
              {/* Transcription */}
              <div className="p-2.5 rounded-lg border bg-white/5 border-white/10 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <div className="w-2 h-2 bg-[#FFE600] rounded-full animate-pulse flex-shrink-0" />
                  <span className="text-sm text-white/80">
                    💬 Transcription
                  </span>
                </div>
                <span className="text-xs text-[#00A8E1]">
                  {transcriberRef.current.supported ? 'live' : 'Gemini only'}
                </span>
              </div>
            </div>
          )}

          {warmingUp && (
            <div className="mt-2 p-3 bg-[#FFE600]/10 rounded-lg border border-[#FFE600]/30">
              <div className="flex items-center space-x-3">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#FFE600]" />
                <span className="text-white font-medium text-sm">HF model warming up (~20s first time)...</span>
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
              { label: 'YAMNet (on-device)', ok: yamnetStatus === 'ready',
                detail: yamnetStatus === 'loading' ? 'downloading model (~15MB)…' : yamnetStatus === 'ready' ? '521 AudioSet classes ✓' : yamnetStatus === 'error' ? 'load failed — using freq fallback' : 'pending…' },
              { label: 'Custom ESC-50 model', ok: customStatus === 'ready',
                detail: customStatus === 'loading' ? 'loading fine-tuned head…' : customStatus === 'ready' ? '50 classes • 98% on alerts ✓' : customStatus === 'error' ? 'not found in /models/hearo' : 'pending…' },
              { label: 'Gemini 2.5 Flash', ok: modelServices.geminiApi,
                detail: modelServices.geminiApi ? 'transcription + sound context ✓' : 'not configured (add key below)' },
              { label: 'Local Storage', ok: modelServices.localStorage, detail: 'alert history' },
            ].map(({ label, ok, detail }) => (
              <div key={label} className={`flex items-center justify-between p-3 rounded-lg ${ok ? 'bg-green-500/10' : 'bg-white/5'}`}>
                <div>
                  <span className="font-medium text-sm">{label}</span>
                  <span className="text-xs text-white/60 ml-2">{detail}</span>
                </div>
                <div className={`w-2.5 h-2.5 rounded-full ${ok ? 'bg-green-500' : yamnetStatus === 'loading' && label === 'YAMNet (on-device)' ? 'bg-[#FFE600] animate-pulse' : 'bg-white/20'}`} />
              </div>
            ))}
          </div>

          {/* Detection model A/B toggle */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-white/90 mb-1">Detection Model</label>
            <p className="text-xs text-white/50 mb-3">Switch live to compare. Both run on-device, free.</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { mode: 'custom', title: 'Custom ESC-50', sub: 'Your trained model', stat: '98% on alerts' },
                { mode: 'stock',  title: 'Stock YAMNet',  sub: '521 AudioSet classes', stat: '50% on alerts' },
              ].map(({ mode, title, sub, stat }) => (
                <button key={mode}
                  onClick={() => changeModelMode(mode)}
                  disabled={mode === 'custom' && customStatus !== 'ready'}
                  className={`p-3 rounded-xl border text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    modelMode === mode
                      ? 'bg-[#FFE600]/10 border-[#FFE600]/40'
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}>
                  <div className={`text-sm font-semibold ${modelMode === mode ? 'text-[#FFE600]' : 'text-white/90'}`}>
                    {title}{modelMode === mode && ' ✓'}
                  </div>
                  <div className="text-xs text-white/50 mt-0.5">{sub}</div>
                  <div className={`text-xs mt-1 font-mono ${modelMode === mode ? 'text-[#FFE600]/80' : 'text-[#00A8E1]'}`}>{stat}</div>
                </button>
              ))}
            </div>
            {modelMode === 'custom' && customStatus === 'error' && (
              <p className="text-xs text-red-400 mt-2">⚠️ Custom model not found — train it with the Colab notebook and drop it in public/models/hearo/.</p>
            )}
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
          <div className="p-4 bg-green-500/10 rounded-xl border border-green-500/20">
            <div className="flex items-start space-x-3">
              <BarChart2 className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-white">YAMNet — On-Device (Primary Sound Classifier)</p>
                <p className="text-xs text-green-400 mt-1">
                  Google's audio classification model. 521 AudioSet classes, runs entirely
                  in your browser — no API key, no cost, no rate limits, no internet needed.
                  Loads once (~10 MB) and is cached locally.
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
              Without a key, YAMNet handles sound detection and Web Speech handles transcription (English only).
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
                YAMNet confidence threshold: {Math.round(Math.max(0.30, 0.70 - (sensitivity / 10) * 0.40) * 100)}%
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-white/90 mb-2">Active AI Mode</label>
              <div className="p-3 bg-white/5 rounded-lg text-sm text-white/90 border border-white/10">
                {(() => {
                  const engine = modelMode === 'custom' && customStatus === 'ready'
                    ? 'Custom ESC-50 (your trained model)'
                    : 'Stock YAMNet (521 AudioSet classes)';
                  const transcription = modelServices.geminiApi ? 'Gemini (transcription)' : 'Web Speech (transcription)';
                  if (yamnetStatus === 'ready') return `✅ ${engine} + ${transcription}`;
                  if (yamnetStatus === 'loading') return '⏳ Model downloading… frequency analysis meanwhile';
                  if (yamnetStatus === 'error') return '⚠️ Model failed — frequency analysis active';
                  return '⏳ Model pending — frequency analysis active';
                })()}
              </div>
            </div>

            {/* Detection Speed */}
            <div>
              <label className="block text-sm font-medium text-white mb-1">Detection Speed</label>
              <p className="text-xs text-white/50 mb-3">
                How often YAMNet scans for sounds. Faster = more responsive. On-device, so no API quota cost.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { ms: 2000, label: '2s',  tier: 'Fast',     desc: 'on-device'    },
                  { ms: 4000, label: '4s',  tier: 'Balanced', desc: 'on-device'    },
                  { ms: 8000, label: '8s',  tier: 'Eco',      desc: 'on-device'    },
                ].map(({ ms, label, tier, desc }) => (
                  <button key={ms}
                    onClick={() => changeDetectionInterval(ms)}
                    className={`p-3 rounded-xl border text-center transition-all ${
                      detectionInterval === ms
                        ? 'bg-[#FFE600] border-[#FFE600] text-[#1E3FB8]'
                        : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10'
                    }`}>
                    <div className="text-xl font-bold">{label}</div>
                    <div className={`text-xs font-semibold ${detectionInterval === ms ? 'text-[#1E3FB8]/70' : 'text-[#00A8E1]'}`}>{tier}</div>
                    <div className={`text-xs mt-0.5 ${detectionInterval === ms ? 'text-[#1E3FB8]/60' : 'text-white/40'}`}>{desc}</div>
                  </button>
                ))}
              </div>
              {detectionInterval <= 4000 && (
                <p className="text-xs text-[#00A8E1] mt-2">
                  ⚡ Fast mode — YAMNet runs on-device every {detectionInterval / 1000}s. No API quota consumed.
                </p>
              )}
              {detectionInterval === 8000 && (
                <p className="text-xs text-white/50 mt-2">
                  Eco mode — conserves battery. YAMNet still runs fully on-device at no cost.
                </p>
              )}
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
                <span className="font-medium text-white">{UIUtils.getAlertText(type) || type}</span>
              </div>
              <div className="space-y-2">
                {['gentle', 'medium', 'strong'].map(level => (
                  <label key={level} className={`flex items-center space-x-4 p-3 rounded-lg cursor-pointer transition-all ${intensity === level ? 'bg-[#FFE600]/10 border border-[#FFE600]/30' : 'bg-white/5 border border-transparent hover:bg-white/10'}`}>
                    <input type="radio" name={`v-${type}`} checked={intensity === level}
                      onChange={() => setVibrationSettings(prev => ({ ...prev, [type]: level }))}
                      className="w-5 h-5 accent-[#FFE600]" />
                    <div className="flex-1 flex items-center justify-between">
                      <span className={`font-medium capitalize ${intensity === level ? 'text-[#FFE600]' : 'text-white/80'}`}>{level}</span>
                      <span className={`font-mono text-sm ${intensity === level ? 'text-[#FFE600]' : 'text-white/40'}`}>
                        {level === 'gentle' ? '▪▫▫' : level === 'medium' ? '▪▪▫' : '▪▪▪'}
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
          <h3 className="text-xl font-semibold text-white mb-1">Test Vibration Patterns</h3>
          <p className="text-xs text-white/50 mb-4">Tap a button to feel each pattern on your device</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Gentle',    emoji: '〰️', pattern: [0, 150],                    bg: 'bg-green-500/10 hover:bg-green-500/20 border-green-500/30',   text: 'text-green-400',  sub: 'text-green-400/70',  desc: '1 soft pulse'      },
              { label: 'Medium',    emoji: '〰️〰️', pattern: [0, 200, 100, 200],          bg: 'bg-[#00A8E1]/10 hover:bg-[#00A8E1]/20 border-[#00A8E1]/30', text: 'text-[#00A8E1]',  sub: 'text-[#00A8E1]/70', desc: '2 short pulses'    },
              { label: 'Strong',    emoji: '⚡', pattern: [0, 300, 150, 300, 150, 300],  bg: 'bg-[#FFE600]/10 hover:bg-[#FFE600]/20 border-[#FFE600]/30', text: 'text-[#FFE600]',  sub: 'text-[#FFE600]/70', desc: '3 firm pulses'     },
              { label: 'Emergency', emoji: '🚨', pattern: [0, 500, 100, 500, 100, 500], bg: 'bg-red-500/10   hover:bg-red-500/20   border-red-500/30',    text: 'text-red-400',    sub: 'text-red-400/70',   desc: '3 long rapid bursts'},
            ].map(({ label, emoji, pattern, bg, text, sub, desc }) => (
              <button key={label} onClick={() => navigator.vibrate && navigator.vibrate(pattern)}
                className={`p-4 rounded-xl border text-center transition-all active:scale-95 ${bg}`}>
                <div className="text-2xl mb-1">{emoji}</div>
                <div className={`font-semibold text-sm ${text}`}>{label}</div>
                <div className={`text-xs mt-0.5 ${sub}`}>{desc}</div>
              </button>
            ))}
          </div>
          <button onClick={() => navigator.vibrate && navigator.vibrate(0)}
            className="w-full mt-3 p-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-white/60 hover:text-white/80 text-sm font-medium transition-all">
            ✕ Cancel Vibration
          </button>
        </div>

        {/* Performance */}
        <div className="bg-[#1E3FB8]/30 rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-semibold text-white mb-4">System Performance</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="p-3 bg-[#00A8E1]/10 rounded-lg">
              <div className="font-medium text-white">Primary AI</div>
              <div className="text-lg font-bold text-[#00A8E1]">{modelServices.geminiApi ? 'Gemini' : 'YAMNet'}</div>
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
                YAMNet (on-device, 521 AudioSet classes) classifies sounds — fire alarms, screaming, glass breaking, and more — entirely in your browser. Gemini 2.5 Flash adds transcription when a key is configured.
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
        {/* Called as functions (not <Component/>) so they render as part of this
            component's tree — prevents a full unmount/remount on every re-render,
            which was making buttons need many clicks while audio level updates. */}
        {currentScreen === 'home'      && HomeScreen()}
        {currentScreen === 'settings'  && SettingsScreen()}
        {currentScreen === 'emergency' && EmergencyScreen()}
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
          `Hearo detected ${recentAlerts[0].rawLabel || UIUtils.getAlertText(recentAlerts[0].soundType) || UIUtils.getAlertText(recentAlerts[0].type) || 'a sound'} at ${recentAlerts[0].location} with ${recentAlerts[0].confidence}% confidence`}
      </div>
    </div>
  );
};

export default HearoApp;
