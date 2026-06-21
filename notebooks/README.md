# Hearo model training

## `yamnet_esc50_finetune.ipynb`

Fine-tunes Google's **YAMNet** on the **ESC-50** dataset to produce a custom,
on-device sound classifier for Hearo, exported to TensorFlow.js.

### Run it

1. Open the notebook in [Google Colab](https://colab.research.google.com/):
   `File -> Upload notebook`, or open it directly from GitHub via
   `https://colab.research.google.com/github/KrittinK/Hearo-mobile-app/blob/main/notebooks/yamnet_esc50_finetune.ipynb`
2. **Runtime -> Run all.** No restart needed — it uses Colab's built-in TensorFlow.
3. It downloads ESC-50, extracts YAMNet embeddings, trains a classifier head,
   **benchmarks it against stock YAMNet**, and downloads `hearo_sound_model.zip`.

### Does it actually improve accuracy?

Step 7 of the notebook answers this directly. It runs both models — **stock YAMNet**
(what the app uses today) and your **fine-tuned model** — on the same held-out test
clips (ESC-50 fold 5, never seen during training) and prints a side-by-side table of
accuracy per Hearo alert category. If the fine-tuned column isn't higher, the training
didn't help and you'll know immediately.

### Will it work offline?

**Yes — sound detection runs 100% on-device with no internet.** Both YAMNet and your
fine-tuned head are bundled in `public/models/` and run in the browser via TensorFlow.js.
Training (this notebook) needs internet, but that runs once on Google's servers, not in
the app.

One caveat: for the *web page itself* to load with no internet at all (cold start in
airplane mode), the app needs to be installed as a PWA with a service worker caching the
assets — that isn't enabled yet. Once the page is loaded, detection works offline
regardless. Ask me to enable the service worker if you want true airplane-mode cold start.

### After training

Unzip the bundle into `public/models/hearo/` and the app can load it as a custom
on-device model (see Step 10 in the notebook). Everything stays on-device, free,
and works offline — no API cost.

### Why this approach

A paid cloud sound API would be worse for Hearo's always-on use case (latency,
no offline support, privacy, and ~$250+/month per user at 24/7 streaming).
Fine-tuning YAMNet keeps detection on-device and free while improving accuracy
on the specific alert sounds that matter.
