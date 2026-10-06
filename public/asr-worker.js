// Nhận dạng giọng nói (Whisper) chạy ngay trong máy, trong một Web Worker.
// Mô hình được tải qua server của app (/__et/models/…) và lưu trên đĩa → lần sau dùng offline.
import { pipeline, env } from '/__et/vendor/transformers/transformers.min.js';

const origin = self.location.origin;
env.allowLocalModels = false;
env.useBrowserCache = false;
env.remoteHost = origin + '/__et/models/';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.backends.onnx.wasm.wasmPaths = {
  mjs: origin + '/__et/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: origin + '/__et/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
};

let current = null; // { model, device, asr }

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(model) {
  if (current && current.model === model) return current;
  if (current) await current.asr.dispose?.();
  const device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  // tiến độ tải: gộp theo từng file để hiện một thanh % chung
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      postMessage({ type: 'download', loaded, total });
    }
  };
  postMessage({ type: 'status', status: 'loading', device });
  const asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback,
  });
  current = { model, device, asr };
  return current;
}

self.onmessage = async (e) => {
  const { type, audio, model, language } = e.data || {};
  if (type !== 'transcribe') return;
  try {
    const { asr, device } = await load(model);
    postMessage({ type: 'status', status: 'transcribing', device });
    const out = await asr(audio, {
      language: language === 'auto' ? null : language,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });
    const segments = (out.chunks || []).map((c) => ({
      start: c.timestamp[0] ?? 0,
      end: c.timestamp[1] ?? null,
      text: c.text,
    })).filter((s) => s.text.trim());
    if (!segments.length && out.text && out.text.trim()) segments.push({ start: 0, end: null, text: out.text });
    postMessage({ type: 'result', segments, device });
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
