'use strict';

// Ghi màn hình khung trình duyệt và ghi âm micro cho một phiên.
// - Mỗi đoạn MediaRecorder (CHUNK_MS) được gửi ngay lên server và nối vào file → không mất dữ liệu
//   nếu app bị tắt giữa chừng.
// - Video: chụp cửa sổ app (desktop) hoặc tab hiện tại (web), rồi cắt đúng vùng khung trình duyệt
//   qua canvas, nên không có cột camera hay thanh công cụ trong video.
(function () {
  const CHUNK_MS = 4000;
  const FPS = 30;

  // MP4/H.264 trước (mở được bằng QuickTime trên Mac), WebM nếu trình duyệt không hỗ trợ.
  const VIDEO_TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const AUDIO_TYPES = ['audio/mp4;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

  const pickType = (list) => list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

  /** Hàng đợi gửi đoạn dữ liệu theo đúng thứ tự. */
  function makeUploader(sessionId, mediaId, kind, mime, startT) {
    let chain = Promise.resolve();
    let first = true;
    let failed = null;
    return {
      push(blob) {
        if (!blob || !blob.size) return chain;
        const qs = first ? `?kind=${kind}&mime=${encodeURIComponent(mime)}&t=${Math.round(startT)}` : '';
        first = false;
        chain = chain.then(async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const res = await fetch(`/__et/api/sessions/${sessionId}/media/${mediaId}${qs}`, { method: 'POST', body: blob });
              if (res.ok) return;
              throw new Error('HTTP ' + res.status);
            } catch (err) {
              failed = err;
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            }
          }
        });
        return chain;
      },
      async finish(extra) {
        await chain;
        if (first) return null; // không có dữ liệu nào
        const res = await fetch(`/__et/api/sessions/${sessionId}/media/${mediaId}/finish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(extra),
        });
        return res.ok ? res.json() : null;
      },
      get error() { return failed; },
    };
  }

  /**
   * Bộ ghi dùng chung: start / pause / resume / stop, tính thời lượng thực (bỏ thời gian tạm dừng).
   * opts: { sessionId, kind, mediaId, stream, mimeType, now(): ms phiên, onState(state) }
   */
  function makeRecorder(opts) {
    const rec = new MediaRecorder(opts.stream, opts.recorderOptions || {});
    const mime = rec.mimeType || opts.mimeType;
    const startT = opts.now();
    const uploader = makeUploader(opts.sessionId, opts.mediaId, opts.kind, mime, startT);
    let activeSince = performance.now();
    let activeMs = 0;
    let state = 'recording';
    rec.ondataavailable = (e) => uploader.push(e.data);
    const done = new Promise((resolve) => { rec.onstop = resolve; });
    rec.start(CHUNK_MS);
    // báo trạng thái sau khi hàm trả về, để nơi gọi đã kịp giữ tham chiếu tới bộ ghi
    const set = (s) => { state = s; if (opts.onState) queueMicrotask(() => opts.onState(s)); };
    set('recording');
    return {
      get state() { return state; },
      get mime() { return mime; },
      elapsed() { return activeMs + (state === 'recording' ? performance.now() - activeSince : 0); },
      pause() {
        if (state !== 'recording') return;
        rec.pause();
        activeMs += performance.now() - activeSince;
        set('paused');
      },
      resume() {
        if (state !== 'paused') return;
        rec.resume();
        activeSince = performance.now();
        set('recording');
      },
      async stop() {
        if (state === 'stopped') return null;
        if (state === 'recording') activeMs += performance.now() - activeSince;
        set('stopping');
        rec.stop();
        await done;
        if (opts.onStop) opts.onStop();
        const item = await uploader.finish({ endT: opts.now(), durationMs: Math.round(activeMs) });
        set('stopped');
        return item;
      },
    };
  }

  /** Lấy luồng hình: desktop → cửa sổ app (main process tự chọn), web → tab hiện tại. */
  async function captureDisplay() {
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: FPS },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    });
  }

  /**
   * Ghi màn hình, chỉ lấy vùng `cropEl` (khung trình duyệt).
   * opts: { sessionId, mediaId, cropEl, now, onState }
   */
  async function startScreen(opts) {
    const display = await captureDisplay();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = display;
    await video.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const surface = display.getVideoTracks()[0].getSettings().displaySurface || 'window';

    /** Toạ độ góc trên-trái vùng nội dung trang + tỉ lệ điểm ảnh, theo loại nguồn đang chụp. */
    const geometry = () => {
      if (surface === 'monitor') {
        // chụp cả màn hình → cắt theo vị trí cửa sổ trên màn hình
        const scale = video.videoWidth / window.screen.width;
        const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
        const x = window.screenX - (window.screen.availLeft || 0) + border;
        const y = window.screenY - (window.screen.availTop || 0) + Math.max(0, window.outerHeight - window.innerHeight - border);
        return { scale, x: x * scale, y: y * scale };
      }
      const scale = video.videoWidth / window.innerWidth; // ảnh chụp có thể ở độ phân giải Retina
      // chụp cửa sổ: thanh tiêu đề macOS nằm phía trên vùng nội dung; chụp tab: không có phần thừa
      const y = surface === 'window' ? Math.max(0, video.videoHeight - window.innerHeight * scale) : 0;
      return { scale, x: 0, y };
    };

    const size = () => {
      const r = opts.cropEl.getBoundingClientRect();
      const { scale } = geometry();
      const k = Math.min(1, 1920 / (r.width * scale));
      // số chẵn: bộ mã hoá H.264 yêu cầu kích thước chẵn
      canvas.width = Math.max(2, Math.round((r.width * scale * k) / 2) * 2);
      canvas.height = Math.max(2, Math.round((r.height * scale * k) / 2) * 2);
    };
    size();
    // captureStream(0) + requestFrame(): chủ động phát đúng FPS khung hình, kể cả khi màn hình đứng yên
    // (luồng tự động chỉ phát khi canvas "thay đổi" nên video bị thiếu khung hình, sai thời lượng).
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const draw = () => {
      if (!video.videoWidth) return;
      const r = opts.cropEl.getBoundingClientRect();
      const g = geometry();
      ctx.drawImage(video, g.x + r.left * g.scale, g.y + r.top * g.scale, r.width * g.scale, r.height * g.scale, 0, 0, canvas.width, canvas.height);
      if (track.requestFrame) track.requestFrame();
    };
    const timer = setInterval(draw, 1000 / FPS);
    draw();

    const mimeType = pickType(VIDEO_TYPES);
    const recorder = makeRecorder({
      ...opts,
      kind: 'screen',
      stream,
      mimeType,
      recorderOptions: { mimeType, videoBitsPerSecond: 4_000_000 },
      onStop: () => {
        clearInterval(timer);
        display.getTracks().forEach((tr) => tr.stop());
        stream.getTracks().forEach((tr) => tr.stop());
      },
    });
    // Người dùng bấm "Stop sharing" của trình duyệt → dừng ghi.
    display.getVideoTracks()[0].addEventListener('ended', () => recorder.stop());
    return recorder;
  }

  /** Ghi âm micro. opts: { sessionId, mediaId, now, onState } */
  async function startAudio(opts) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = pickType(AUDIO_TYPES);
    return makeRecorder({
      ...opts,
      kind: 'audio',
      stream: mic,
      mimeType,
      recorderOptions: { mimeType, audioBitsPerSecond: 64_000 },
      onStop: () => mic.getTracks().forEach((tr) => tr.stop()),
    });
  }

  /**
   * Giải mã một file âm thanh → Float32 mono 16 kHz (định dạng Whisper cần) và xuất WAV.
   */
  async function decodeAudio(url, sampleRate = 16000) {
    const buf = await (await fetch(url)).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, sampleRate);
    const decoded = await ctx.decodeAudioData(buf);
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * sampleRate), sampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  function wavBlob(samples, sampleRate = 16000) {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  window.EtMedia = { startScreen, startAudio, decodeAudio, wavBlob, pickType, VIDEO_TYPES, AUDIO_TYPES };
})();
