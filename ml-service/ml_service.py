

import os
import sys
import json
import base64
import logging
import io
import types

import numpy as np
import cv2
from PIL import Image

# ── Protobuf / MediaPipe compatibility shim ──────────────────────────────────
# (Same shim used in air_writing_inference.py — keeps import order safe.)
try:
    from google.protobuf import message_factory, symbol_database
    _symbol_db = symbol_database.Default()
    if not hasattr(_symbol_db, "GetPrototype") and hasattr(message_factory, "GetMessageClass"):
        def _get_prototype(descriptor):
            return message_factory.GetMessageClass(descriptor)
        setattr(_symbol_db, "GetPrototype", _get_prototype)
    if not hasattr(message_factory.MessageFactory, "GetPrototype") and \
            hasattr(message_factory, "GetMessageClass"):
        def _mf_get_prototype(self, descriptor):
            return message_factory.GetMessageClass(descriptor)
        setattr(message_factory.MessageFactory, "GetPrototype", _mf_get_prototype)
except ImportError:
    pass  # protobuf not installed; skip shim

import tensorflow as tf
from flask import Flask, request, jsonify
from flask_cors import CORS

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────
MODEL_KERAS_PATH   = os.environ.get("AIR_WRITE_MODEL_PATH", "air_write_cnn.keras")
MODEL_H5_PATH      = "air_write_cnn.h5"
CLASS_MAP_PATH     = "class_indices.json"
IMG_SIZE           = (64, 64)           # Must match training resolution
MIN_ACCEPT_CONF    = 0.65               # Below this → low_confidence flag is set
PORT               = int(os.environ.get("ML_SERVICE_PORT", 6000))

# Fallback labels if class_indices.json is missing
FALLBACK_CLASS_NAMES = [str(d) for d in range(10)] + [chr(c) for c in range(65, 91)]

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ml_service")

# ─────────────────────────────────────────────────────────────────────────────
# MODEL LOADING
# ─────────────────────────────────────────────────────────────────────────────
def load_class_names() -> list[str]:
    if os.path.exists(CLASS_MAP_PATH):
        try:
            with open(CLASS_MAP_PATH, "r", encoding="utf-8") as f:
                payload = json.load(f)
            names = payload.get("index_to_class", [])
            if isinstance(names, list) and names:
                log.info("Loaded %d class names from %s", len(names), CLASS_MAP_PATH)
                return names
        except Exception as exc:
            log.warning("Could not read class map (%s). Using fallback labels.", exc)
    log.warning("class_indices.json not found — using fallback labels (0-9, A-Z).")
    return FALLBACK_CLASS_NAMES


def load_model():
    """Try .keras first, then .h5. Raises RuntimeError if neither is found."""
    candidates = [MODEL_KERAS_PATH, MODEL_H5_PATH]
    for path in candidates:
        if os.path.exists(path):
            try:
                model = tf.keras.models.load_model(path)
                log.info("Model loaded from '%s'  input=%s  output=%s",
                         path, model.input_shape, model.output_shape)
                return model
            except Exception as exc:
                log.warning("Failed to load '%s': %s", path, exc)
    raise RuntimeError(
        f"No model found. Looked for: {candidates}. "
        "Place air_write_cnn.keras (or .h5) in the same folder as ml_service.py."
    )


# ─────────────────────────────────────────────────────────────────────────────
# IMAGE PREPROCESSING
# ─────────────────────────────────────────────────────────────────────────────
def decode_base64_image(data_url: str) -> np.ndarray | None:
    """
    Decode a data:image/png;base64,... string into an OpenCV BGR image.
    Returns None if the string is empty or decoding fails.
    """
    if not data_url:
        return None
    try:
        # Strip the data-URL header if present
        if "," in data_url:
            data_url = data_url.split(",", 1)[1]
        img_bytes = base64.b64decode(data_url)
        pil_img   = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
        bgr       = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGBA2BGR)
        return bgr
    except Exception as exc:
        log.warning("Image decode failed: %s", exc)
        return None


def preprocess_for_model(bgr_img: np.ndarray) -> np.ndarray | None:
    """
    Full preprocessing pipeline that mirrors how the training data was generated
    (cyan strokes on black background → clean 64×64 grayscale, [0,1] float32).

    Steps:
      1. Convert to grayscale by taking the max across BGR channels.
         This works for cyan (high G+B), white, and any other bright stroke colour.
      2. Threshold: suppress near-zero noise (< 10% brightness → 0).
      3. Find the bounding box of the non-zero (ink) region.
      4. Add 10% padding around the bounding box so strokes aren't clipped.
      5. Resize the cropped region to IMG_SIZE (64×64) using area interpolation.
      6. Normalize to [0, 1] float32.
      7. Add batch + channel dims → shape (1, 64, 64, 1).

    Returns None if the canvas appears blank (no ink pixels found).
    """
    # Step 1 — Luminance via max-channel (matches training preprocess_cyan_stroke)
    gray = np.max(bgr_img.astype(np.float32) / 255.0, axis=-1)   # (H, W) in [0,1]

    # Step 2 — Noise threshold
    gray = np.where(gray > 0.10, gray, 0.0)

    # Step 3 — Find ink bounding box
    uint8 = (gray * 255).astype(np.uint8)
    coords = cv2.findNonZero(uint8)
    if coords is None:
        return None   # blank canvas signal

    x, y, w, h = cv2.boundingRect(coords)

    # Step 4 — Padding (10% of each side)
    pad_x = max(int(w * 0.10), 4)
    pad_y = max(int(h * 0.10), 4)
    ih, iw = gray.shape
    x0 = max(x - pad_x, 0)
    y0 = max(y - pad_y, 0)
    x1 = min(x + w + pad_x, iw)
    y1 = min(y + h + pad_y, ih)
    crop = gray[y0:y1, x0:x1]

    if crop.size == 0:
        return None

    # Step 5 — Resize to 64×64
    resized = cv2.resize(crop, IMG_SIZE, interpolation=cv2.INTER_AREA)

    # Step 6 & 7 — Float32, batch + channel dims → (1, 64, 64, 1)
    tensor = resized.astype(np.float32)[np.newaxis, :, :, np.newaxis]
    return tensor


# ─────────────────────────────────────────────────────────────────────────────
# INFERENCE HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def run_prediction(model, tensor: np.ndarray, class_names: list[str]) -> dict:
    """
    Run the CNN on a preprocessed (1, 64, 64, 1) tensor and return a result dict:
        char          — top predicted character
        confidence    — softmax probability of top prediction (0–1 float)
        low_confidence— True when confidence < MIN_ACCEPT_CONF
        top3          — list of [char, prob] for top-3 candidates
    """
    # Adapt channels if model was trained on 3-channel input
    input_shape = model.input_shape   # e.g. (None, 64, 64, 1) or (None, 64, 64, 3)
    expected_channels = input_shape[-1] if input_shape[-1] is not None else 1

    if expected_channels == 3 and tensor.shape[-1] == 1:
        tensor = np.repeat(tensor, 3, axis=-1)
    elif expected_channels == 1 and tensor.shape[-1] == 3:
        tensor = np.max(tensor, axis=-1, keepdims=True)

    probs = model.predict(tensor, verbose=0)[0]          # shape (num_classes,)
    probs = np.asarray(probs, dtype=np.float32).reshape(-1)

    # Apply softmax if raw logits slipped through
    if probs.min() < -1e-5 or probs.max() > 1.0 + 1e-5:
        probs = tf.nn.softmax(probs).numpy()

    top_idx    = int(np.argmax(probs))
    confidence = float(probs[top_idx])
    char       = class_names[top_idx] if top_idx < len(class_names) else "?"

    # Top-3 alternatives
    top3_idx  = np.argsort(probs)[::-1][:3]
    top3      = [
        [class_names[i] if i < len(class_names) else "?", float(probs[i])]
        for i in top3_idx
    ]

    return {
        "char":           char,
        "confidence":     round(confidence, 4),
        "low_confidence": confidence < MIN_ACCEPT_CONF,
        "top3":           top3,
    }


# ─────────────────────────────────────────────────────────────────────────────
# FLASK APP
# ─────────────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)   # allow requests from the React dev server (localhost:5173)

# Load model and class names once at startup — kept in module scope
log.info("Loading CNN model…")
try:
    _model       = load_model()
    _class_names = load_class_names()
    _ready       = True
    log.info("ML service ready. %d classes. Min confidence threshold: %.0f%%",
             len(_class_names), MIN_ACCEPT_CONF * 100)
except Exception as exc:
    log.error("STARTUP FAILED: %s", exc)
    _model       = None
    _class_names = FALLBACK_CLASS_NAMES
    _ready       = False


@app.route("/health", methods=["GET"])
def health():
    """
    GET /health
    Returns 200 when the model is loaded, 503 if startup failed.
    The predictController.mlHealthCheck calls this to populate the UI status badge.
    """
    if _ready:
        return jsonify({
            "status":      "ok",
            "model":       MODEL_KERAS_PATH if os.path.exists(MODEL_KERAS_PATH) else MODEL_H5_PATH,
            "num_classes": len(_class_names),
            "img_size":    list(IMG_SIZE),
        }), 200
    return jsonify({"status": "error", "message": "Model not loaded"}), 503


@app.route("/predict", methods=["POST"])
def predict():
    """
    POST /predict
    Body (JSON): { "image": "data:image/png;base64,..." }

    The base64 string comes from liveWriting.jsx → sendCanvasRef.toDataURL().
    The canvas renders cyan strokes on a transparent/black background.

    Response (200 JSON):
        { "char": "A", "confidence": 0.92, "low_confidence": false, "top3": [...] }

    Special case — blank canvas:
        { "error": "blank_canvas" }

    Errors that mirror predictController expectations:
        400 — missing image field
        503 — model not loaded
        500 — unexpected server error
    """
    if not _ready:
        return jsonify({"error": "model_not_loaded",
                        "message": "CNN model failed to load at startup"}), 503

    body = request.get_json(silent=True) or {}
    image_data = body.get("image", "")

    if not image_data:
        return jsonify({"error": "missing_image",
                        "message": "Request body must contain an 'image' field"}), 400

    # ── Decode ──────────────────────────────────────────────────────────────
    bgr = decode_base64_image(image_data)
    if bgr is None:
        log.warning("/predict: image decode returned None")
        return jsonify({"error": "decode_failed",
                        "message": "Could not decode image data"}), 400

    # ── Preprocess ──────────────────────────────────────────────────────────
    tensor = preprocess_for_model(bgr)
    if tensor is None:
        log.info("/predict: blank canvas (no ink pixels)")
        return jsonify({"error": "blank_canvas"}), 200

    # ── Infer ───────────────────────────────────────────────────────────────
    try:
        result = run_prediction(_model, tensor, _class_names)
        log.info("/predict → '%s'  conf=%.2f  low_conf=%s",
                 result["char"], result["confidence"], result["low_confidence"])
        return jsonify(result), 200
    except Exception as exc:
        log.exception("/predict: inference error: %s", exc)
        return jsonify({"error": "inference_error", "message": str(exc)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  Air-Writing ML Service")
    print(f"  Listening on http://0.0.0.0:{PORT}")
    print("  Endpoints:  POST /predict   GET /health")
    print("=" * 60)
    app.run(host="0.0.0.0", port=PORT, debug=False)
