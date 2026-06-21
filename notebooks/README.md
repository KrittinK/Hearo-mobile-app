# Hearo model training

## `yamnet_esc50_finetune.ipynb`

Fine-tunes Google's **YAMNet** on the **ESC-50** dataset to produce a custom,
on-device sound classifier for Hearo, exported to TensorFlow.js.

### Run it

1. Open the notebook in [Google Colab](https://colab.research.google.com/):
   `File -> Upload notebook`, or open it directly from GitHub via
   `https://colab.research.google.com/github/KrittinK/Hearo-mobile-app/blob/main/notebooks/yamnet_esc50_finetune.ipynb`
2. Run the **Setup** cell, then **Runtime -> Restart session**, then **Run all**.
3. It downloads ESC-50, extracts YAMNet embeddings, trains a classifier head,
   and downloads `hearo_sound_model.zip`.

### After training

Unzip the bundle into `public/models/hearo/` and the app can load it as a custom
on-device model (see Step 10 in the notebook). Everything stays on-device, free,
and works offline — no API cost.

### Why this approach

A paid cloud sound API would be worse for Hearo's always-on use case (latency,
no offline support, privacy, and ~$250+/month per user at 24/7 streaming).
Fine-tuning YAMNet keeps detection on-device and free while improving accuracy
on the specific alert sounds that matter.
