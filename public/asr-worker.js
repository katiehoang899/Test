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
let attempted = null; // thiết bị của lần nạp gần nhất (kể cả khi nạp lỗi)

// Lỗi xảy ra ngoài try/catch (bên trong ONNX Runtime / WebGPU) vẫn báo về trang kèm nội dung,
// thay vì worker chết im lặng ("worker error").
self.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  postMessage({ type: 'error', message: String((e.reason && e.reason.message) || e.reason || 'unknown error') });
});

/** GPU nếu có (kèm việc card có hỗ trợ số thực 16-bit không), không thì CPU (WASM). */
async function pickDevice(force) {
  if (force === 'wasm') return { device: 'wasm' };
  try {
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
    if (!adapter) return { device: 'wasm' };
    return { device: 'webgpu', fp16: adapter.features.has('shader-f16') };
  } catch {
    return { device: 'wasm' };
  }
}

async function load(model, force) {
  if (current && current.model === model && (!force || current.device === force)) return current;
  if (current) {
    await current.asr.dispose?.();
    current = null;
  }
  const { device, fp16 } = await pickDevice(force);
  attempted = device;
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
  // GPU: encoder fp16 khi card hỗ trợ (bằng nửa bộ nhớ của fp32 — mô hình Large fp32 ~2,5 GB dễ làm
  // tràn bộ nhớ GPU và worker bị dừng đột ngột); CPU: lượng tử hoá 8-bit cho cả mô hình.
  const dtype = device === 'webgpu' ? { encoder_model: fp16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' } : 'q8';
  const asr = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  current = { model, device, asr };
  return current;
}

async function transcribe(audio, model, language, force) {
  const { asr, device } = await load(model, force);
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
  return { segments, device };
}

self.onmessage = async (e) => {
  const { type, audio, model, language, device: force } = e.data || {};
  if (type !== 'transcribe') return;
  try {
    let result;
    try {
      result = await transcribe(audio, model, language, force);
    } catch (err) {
      // GPU lỗi (thiếu bộ nhớ, driver, thiếu file fp16…) → chạy lại bằng CPU
      if (attempted !== 'webgpu') throw err;
      postMessage({ type: 'status', status: 'retry_cpu', device: 'wasm', reason: String((err && err.message) || err) });
      result = await transcribe(audio, model, language, 'wasm');
    }
    postMessage({ type: 'result', ...result });
  } catch (err) {
    postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
