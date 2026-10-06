'use strict';

// Màn hình transcript riêng của một phiên: nhận dạng giọng nói (Whisper, chạy trên máy),
// chỉnh sửa từng đoạn, lưu và xuất Word / .txt.
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sessionId = params.get('id');
const api = `/__et/api/sessions/${sessionId}`;

const state = {
  meta: null,
  audios: [],
  audioId: null,
  transcript: null,  // dữ liệu đã lưu trên server
  segments: [],      // bản đang chỉnh sửa
  dirty: false,
  busy: false,
  worker: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtMb(n) {
  return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1);
}

// ---------- hiển thị ----------

function renderHeader() {
  const m = state.meta;
  $('#sessionUrl').textContent = `${m.url} — ${m.participant || t('common.anonymous')} — ${new Date(m.createdAt).toLocaleString(I18N.locale())}`;
  $('#backReport').href = `/__et/report.html?id=${sessionId}`;
  document.querySelectorAll('.lang-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === I18N.lang)));
}

function renderAudioSelect() {
  const sel = $('#audioSelect');
  sel.hidden = state.audios.length < 2;
  sel.innerHTML = state.audios.map((a, i) =>
    `<option value="${esc(a.id)}">${esc(t('tr.audio_item', { n: i + 1, duration: fmtTime((a.durationMs || 0) / 1000) }))}</option>`).join('');
  sel.value = state.audioId || '';
}

function renderTranscribeButton() {
  const btn = $('#transcribe');
  btn.textContent = state.busy ? t('tr.working') : state.segments.length ? t('tr.retranscribe') : t('tr.transcribe');
  btn.disabled = state.busy || !state.audioId;
}

function renderMeta() {
  const tr = state.transcript;
  if (!tr || !tr.segments || !tr.segments.length) {
    $('#trMeta').textContent = '';
    return;
  }
  const model = (tr.model || '').split('/').pop();
  $('#trMeta').textContent = t('tr.meta', {
    n: state.segments.length,
    lang: t(`tr.lang_${{ vietnamese: 'vi', english: 'en' }[tr.language] || 'auto'}`),
    model,
    time: new Date(tr.updatedAt).toLocaleString(I18N.locale()),
  });
}

function renderSegments() {
  const box = $('#segments');
  const has = state.segments.length > 0;
  $('#exportDocx').toggleAttribute('hidden', !state.transcript || !(state.transcript.segments || []).length);
  $('#exportTxt').toggleAttribute('hidden', !state.transcript || !(state.transcript.segments || []).length);
  if (!state.audios.length) {
    box.innerHTML = `<div class="empty-state muted">${esc(t('tr.no_audio'))}</div>`;
    return;
  }
  if (!has) {
    box.innerHTML = `<div class="empty-state muted">${esc(t('tr.empty'))}</div>`;
    return;
  }
  box.innerHTML = state.segments.map((s, i) => `<div class="segment" data-i="${i}">
      <button type="button" class="ts" data-seek="${s.start}" title="${esc(t('tr.seek'))}">${fmtTime(s.start)}</button>
      <div class="text" contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(s.text.trim())}</div>
    </div>`).join('');
}

function renderSaveState() {
  $('#save').disabled = !state.dirty || state.busy;
  $('#saveState').textContent = state.dirty ? t('tr.unsaved') : '';
}

function renderAll() {
  renderHeader();
  renderAudioSelect();
  renderTranscribeButton();
  renderMeta();
  renderSegments();
  renderSaveState();
}

function setProgress(fraction, text) {
  const box = $('#progressBox');
  box.hidden = fraction === null;
  if (fraction === null) return;
  const bar = box.querySelector('.progress-bar');
  bar.classList.toggle('indeterminate', fraction < 0);
  $('#progressFill').style.width = fraction < 0 ? '' : `${Math.round(fraction * 100)}%`;
  $('#progressText').textContent = text || '';
}

// ---------- âm thanh ----------

function selectAudio(id) {
  state.audioId = id;
  $('#player').src = id ? `${api}/media/${encodeURIComponent(id)}` : '';
  renderTranscribeButton();
}

$('#audioSelect').addEventListener('change', (e) => selectAudio(e.target.value));

// Bấm mốc thời gian → nghe lại đoạn đó.
$('#segments').addEventListener('click', (e) => {
  const ts = e.target.closest('[data-seek]');
  if (!ts) return;
  const player = $('#player');
  player.currentTime = Number(ts.dataset.seek) || 0;
  player.play().catch(() => {});
});

// Tô sáng đoạn đang phát.
$('#player').addEventListener('timeupdate', () => {
  const now = $('#player').currentTime;
  let active = -1;
  state.segments.forEach((s, i) => { if (s.start <= now) active = i; });
  document.querySelectorAll('.segment').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === active));
});

// ---------- chỉnh sửa & lưu ----------

$('#segments').addEventListener('input', (e) => {
  const el = e.target.closest('.text');
  if (!el) return;
  state.segments[Number(el.dataset.i)].text = el.innerText;
  state.dirty = true;
  renderSaveState();
});

async function save() {
  const body = {
    audioId: state.audioId,
    language: $('#trLanguage').value,
    model: state.transcript?.model || $('#trModel').value,
    segments: state.segments,
  };
  const res = await fetch(`${api}/transcript`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  state.transcript = await res.json();
  state.dirty = false;
  renderMeta();
  renderSegments();
  renderSaveState();
}

$('#save').addEventListener('click', async () => {
  try {
    await save();
    toast(t('tr.saved'));
  } catch (err) {
    toast(t('tr.save_failed', { msg: err.message }));
  }
});

// Lưu trước khi xuất để file luôn khớp với những gì đang thấy.
for (const sel of ['#exportDocx', '#exportTxt']) {
  $(sel).addEventListener('click', async (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    try {
      await save();
      location.href = e.currentTarget.href;
    } catch (err) {
      toast(t('tr.save_failed', { msg: err.message }));
    }
  });
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty || state.busy) e.preventDefault();
});

// ---------- nhận dạng giọng nói ----------

function getWorker() {
  if (!state.worker) state.worker = new Worker('/__et/asr-worker.js', { type: 'module' });
  return state.worker;
}

function runWorker(audio, model, language) {
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'download') {
        setProgress(m.total ? m.loaded / m.total : -1, t('tr.downloading', { loaded: fmtMb(m.loaded), total: fmtMb(m.total) }));
      } else if (m.type === 'status') {
        const device = m.device === 'webgpu' ? 'GPU' : 'CPU';
        setProgress(-1, m.status === 'loading' ? t('tr.loading_model', { device }) : t('tr.transcribing', { device }));
      } else if (m.type === 'result') {
        resolve(m.segments);
      } else if (m.type === 'error') {
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      state.worker = null;
      reject(new Error(e.message || 'worker error'));
    };
    worker.postMessage({ type: 'transcribe', audio, model, language }, [audio.buffer]);
  });
}

$('#transcribe').addEventListener('click', async () => {
  if (state.busy || !state.audioId) return;
  if (state.segments.length && !confirm(t('tr.replace_confirm'))) return;
  state.busy = true;
  renderTranscribeButton();
  renderSaveState();
  const model = $('#trModel').value;
  const language = $('#trLanguage').value;
  const started = performance.now();
  try {
    setProgress(-1, t('tr.decoding'));
    const audio = await EtMedia.decodeAudio(`${api}/media/${encodeURIComponent(state.audioId)}`);
    const segments = await runWorker(audio, model, language);
    state.segments = segments;
    state.transcript = { ...(state.transcript || {}), model, language };
    await save();
    toast(t('tr.done', { n: segments.length, s: Math.round((performance.now() - started) / 1000) }));
  } catch (err) {
    toast(t('tr.failed', { msg: err.message }), 8000);
  } finally {
    state.busy = false;
    setProgress(null);
    renderAll();
  }
});

$('#trModel').addEventListener('change', (e) => I18N.save({ asrModel: e.target.value }).catch(() => {}));

// ---------- khởi động ----------

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.save({ language: b.dataset.lang })));
document.addEventListener('i18n:change', () => { if (state.meta) renderAll(); });

async function init() {
  const settings = await I18N.load();
  if (!/^[a-f0-9]{16}$/.test(sessionId || '')) {
    document.querySelector('main').innerHTML = `<div class="card">${esc(t('report.missing_id'))} <a href="/__et/">${esc(t('common.back_home'))}</a></div>`;
    return;
  }
  try {
    const [meta, tr] = await Promise.all([
      fetch(api).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch(`${api}/transcript`).then((r) => (r.ok ? r.json() : null)),
    ]);
    state.meta = meta;
    state.transcript = tr;
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card">${esc(t('report.load_failed', { msg: err.message }))}</div>`;
    return;
  }
  state.audios = (state.meta.media || []).filter((m) => m.kind === 'audio' && m.size > 0);
  state.segments = (state.transcript?.segments || []).map((s) => ({ ...s }));
  const wanted = params.get('media') || state.transcript?.audioId;
  selectAudio((state.audios.find((a) => a.id === wanted) || state.audios[0] || {}).id || null);
  $('#trLanguage').value = state.transcript?.language || (settings.language === 'vi' ? 'vietnamese' : 'english');
  $('#trModel').value = settings.asrModel || 'onnx-community/whisper-small';
  $('#exportDocx').href = `${api}/transcript?format=docx`;
  $('#exportTxt').href = `${api}/transcript?format=txt`;
  renderAll();
}

init();
