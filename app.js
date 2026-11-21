'use strict';
/* Grabar médico (web): versión para iPhone de MedicoMem.
   Graba con un toque, guarda en el propio móvil (IndexedDB) y envía el audio
   al Telegram de la familia mediante un bot propio. Sin servidor. */

const VERSION = '1.0.0';
const SEGMENT_MS = 30 * 60 * 1000;   // parte nueva cada 30 min (límite de 50 MB de los bots de Telegram)
const MAX_MS = 3 * 60 * 60 * 1000;   // corte automático a las 3 h
const MIN_MS = 10 * 1000;            // menos de 10 s = toque por error, no se envía
const KEEP_MS = 15 * 24 * 3600 * 1000; // lo enviado se borra a los 15 días
const TIMESLICE = 5000;              // guarda un trozo en disco cada 5 s
const RETRY_MS = 60 * 1000;
const HOLD_MS = 4000;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= Base de datos local (IndexedDB) ================= */
const DB = (() => {
  let opening;
  const open = () => opening || (opening = new Promise((res, rej) => {
    const r = indexedDB.open('grabar-medico', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('recs', { keyPath: 'id' });
      d.createObjectStore('chunks', { autoIncrement: true }).createIndex('rec', 'rec');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
  return {
    async get(store, key) { const d = await open(); return req(d.transaction(store).objectStore(store).get(key)); },
    async all(store) { const d = await open(); return req(d.transaction(store).objectStore(store).getAll()); },
    async put(store, val, key) {
      const d = await open(); const t = d.transaction(store, 'readwrite');
      key === undefined ? t.objectStore(store).put(val) : t.objectStore(store).put(val, key);
      return done(t);
    },
    async del(store, key) { const d = await open(); const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); return done(t); },
    async addChunk(rec, blob) {
      const d = await open(); const t = d.transaction(['chunks', 'recs'], 'readwrite');
      t.objectStore('chunks').add({ rec: rec.id, blob });
      t.objectStore('recs').put(rec);
      return done(t);
    },
    async chunksOf(id) { const d = await open(); return req(d.transaction('chunks').objectStore('chunks').index('rec').getAll(id)); },
    async delChunks(id) {
      const d = await open(); const t = d.transaction('chunks', 'readwrite');
      const cur = t.objectStore('chunks').index('rec').openKeyCursor(IDBKeyRange.only(id));
      cur.onsuccess = () => { const c = cur.result; if (c) { t.objectStore('chunks').delete(c.primaryKey); c.continue(); } };
      return done(t);
    },
  };
})();

/* ================= Configuración ================= */
let cfg = { name: '', token: '', chatId: '', chatTitle: '', enhance: true };
async function loadConfig() {
  try { Object.assign(cfg, (await DB.get('kv', 'config')) || {}); } catch (e) { console.warn(e); }
}
async function saveConfig() {
  try { await DB.put('kv', { ...cfg }, 'config'); } catch (e) { console.warn(e); }
}
const configured = () => Boolean(cfg.token && cfg.chatId);

/* ================= Formatos ================= */
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(ms) {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
function deviceInfo() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)[_.](\d+)/);
  const dev = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Ordenador';
  return ios && dev !== 'Ordenador' ? `${dev} · iOS ${ios[1]}.${ios[2]}` : dev;
}
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/* ================= Sonidos y vibración ================= */
let beepCtx;
function beep(times = 1) {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    beepCtx.resume();
    let t = beepCtx.currentTime + 0.03;
    for (let i = 0; i < times; i++) {
      const o = beepCtx.createOscillator(), g = beepCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(beepCtx.destination);
      o.start(t); o.stop(t + 0.2);
      t += 0.28;
    }
  } catch (e) { /* sin sonido */ }
  try { navigator.vibrate && navigator.vibrate(times === 1 ? 200 : [120, 80, 120]); } catch (e) { /* iPhone no vibra desde la web */ }
}

/* ================= Grabación ================= */
// En iPhone 'audio/mp4' es AAC (.m4a). No se fuerza el códec: algunos navegadores dicen admitirlo y luego fallan.
const MIME = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac']
  .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';

const S = {
  state: 'idle', ctx: null, stream: null, recStream: null, analyser: null,
  seg: null, sessionId: '', sessionStart: 0, part: 0, keptParts: 0,
  tick: null, raf: 0, wake: null, muteTimer: null,
};

function setState(st) {
  S.state = st;
  document.body.className = st;
}

async function startRecording() {
  if (S.state !== 'idle') return;
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showNotice('Este navegador no puede grabar. Abre la app desde Safari (iOS 14.5 o superior).');
    return;
  }
  setState('starting');
  hideNotice();
  // El AudioContext debe crearse dentro del toque (requisito de iOS)
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  beep(1);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: cfg.enhance
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (e) {
    ctx.close();
    setState('idle');
    showNotice('Sin permiso para el micrófono. En el iPhone: Ajustes › Apps › Safari › Micrófono › Permitir. Luego vuelve a tocar GRABAR.');
    return;
  }

  const src = ctx.createMediaStreamSource(stream);
  let out = src;
  if (cfg.enhance) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;   // golpes y zumbidos
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000;  // siseo
    const comp = ctx.createDynamicsCompressor();                                         // iguala voz lejana y cercana
    comp.threshold.value = -45; comp.knee.value = 15; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.3;
    const gain = ctx.createGain(); gain.gain.value = 4;                                  // sube el conjunto
    const lim = ctx.createDynamicsCompressor();                                          // que no sature
    lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
    src.connect(hp).connect(lp).connect(comp).connect(gain).connect(lim);
    out = lim;
  }
  const dest = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  out.connect(dest); out.connect(analyser);

  Object.assign(S, {
    ctx, stream, analyser, recStream: cfg.enhance ? dest.stream : stream,
    sessionId: Date.now().toString(36), sessionStart: Date.now(), part: 0, keptParts: 0,
  });

  // Llamada entrante, Siri o bloqueo: iOS silencia o corta el micrófono
  const track = stream.getAudioTracks()[0];
  track.addEventListener('ended', () => interrupted());
  track.addEventListener('mute', () => {
    clearTimeout(S.muteTimer);
    S.muteTimer = setTimeout(() => { if (track.muted) interrupted(); }, 1500);
  });
  track.addEventListener('unmute', () => clearTimeout(S.muteTimer));
  ctx.addEventListener('statechange', () => { if (ctx.state === 'interrupted') interrupted(); });

  try {
    await startSegment();
  } catch (e) {
    teardown();
    setState('idle');
    showNotice('No se pudo empezar a grabar: ' + e.message);
    return;
  }
  setState('recording');
  keepAwake(true);
  S.tick = setInterval(onTick, 1000);
  onTick();
  drawLevel();
}

async function startSegment() {
  S.part++;
  const rec = {
    id: `${S.sessionId}-${S.part}`, session: S.sessionId, part: S.part,
    createdAt: Date.now(), lastChunkAt: Date.now(), status: 'recording',
    mime: MIME || 'audio/mp4', name: cfg.name, flags: [],
  };
  await DB.put('recs', rec);
  const opts = { audioBitsPerSecond: 64000 };
  if (MIME) opts.mimeType = MIME;
  const mr = new MediaRecorder(S.recStream, opts);
  if (mr.mimeType) rec.mime = mr.mimeType;
  const pending = [];
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      rec.lastChunkAt = Date.now();
      pending.push(DB.addChunk(rec, e.data).catch((err) => console.warn('chunk', err)));
    }
  };
  const stopped = new Promise((r) => { mr.onstop = r; });
  mr.onerror = (e) => {
    console.warn('MediaRecorder', e.error || e);
    if (S.seg && S.seg.mr === mr) interrupted();
  };
  mr.start(TIMESLICE);
  S.seg = { rec, mr, pending, stopped };
}

async function endSegment(seg, flag) {
  if (!seg) return false;
  if (flag) seg.rec.flags.push(flag);
  if (seg.mr.state !== 'inactive') {
    try { seg.mr.stop(); } catch (e) { /* ya parado */ }
    await Promise.race([seg.stopped, sleep(4000)]);
  }
  await Promise.allSettled(seg.pending);
  seg.rec.durationMs = Date.now() - seg.rec.createdAt;
  return finalizeRec(seg.rec);
}

/** Une los trozos guardados en un solo audio y lo deja pendiente de envío. */
async function finalizeRec(rec) {
  const chunks = await DB.chunksOf(rec.id);
  const blob = new Blob(chunks.map((c) => c.blob), { type: rec.mime });
  if (!blob.size || rec.durationMs < MIN_MS) {
    await DB.delChunks(rec.id);
    await DB.del('recs', rec.id);
    return false;
  }
  Object.assign(rec, { blob, size: blob.size, status: 'pending', attempts: 0 });
  await DB.put('recs', rec);
  await DB.delChunks(rec.id);
  return true;
}

async function onTick() {
  if (S.state !== 'recording') return;
  const total = Date.now() - S.sessionStart;
  $('timer').textContent = fmtClock(total);
  if (total >= MAX_MS) return stopRecording('auto3h');
  if (S.seg && Date.now() - S.seg.rec.createdAt >= SEGMENT_MS) {
    const old = S.seg;
    await startSegment();                 // la nueva parte empieza antes de cerrar la anterior: no se pierde nada
    if (await endSegment(old)) S.keptParts++;
    uploadQueue();
  }
}

function drawLevel() {
  if (S.state !== 'recording' || !S.analyser) return;
  const buf = new Float32Array(S.analyser.fftSize);
  S.analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
  $('levelBar').style.width = `${Math.max(0, Math.min(100, (db + 60) * 1.8))}%`;
  S.raf = requestAnimationFrame(drawLevel);
}

async function stopRecording(flag, noticeText) {
  if (S.state !== 'recording') return;
  setState('stopping');
  clearInterval(S.tick);
  cancelAnimationFrame(S.raf);
  const seg = S.seg; S.seg = null;
  let kept = false;
  try { kept = await endSegment(seg, flag); } catch (e) { console.warn(e); }
  if (kept) S.keptParts++;
  teardown();
  keepAwake(false);
  beep(2);

  const anyKept = S.keptParts > 0;
  $('saved').classList.toggle('short', !anyKept);
  $('savedIcon').textContent = anyKept ? '✓' : '✕';
  $('savedText').textContent = anyKept ? 'GUARDADO' : 'MUY CORTA';
  $('savedSub').textContent = anyKept
    ? (configured() ? 'Se enviará a Telegram' : 'Falta configurar Telegram')
    : 'Menos de 10 segundos: no se envía';
  setState('saved');
  if (noticeText) showNotice(noticeText);
  setTimeout(() => { if (S.state === 'saved') { setState('idle'); refreshStatus(); } }, 3000);
  uploadQueue();
}

function interrupted() {
  if (S.state !== 'recording') return;
  stopRecording('interrupt', 'La grabación se cortó (llamada, Siri o bloqueo). Lo grabado está guardado. Para seguir, toca otra vez GRABAR.');
}

function teardown() {
  try { S.stream && S.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* nada */ }
  try { S.ctx && S.ctx.close(); } catch (e) { /* nada */ }
  clearTimeout(S.muteTimer);
  Object.assign(S, { stream: null, ctx: null, analyser: null, recStream: null });
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !S.wake) {
      S.wake = await navigator.wakeLock.request('screen');
      S.wake.addEventListener('release', () => { S.wake = null; });
    } else if (!on && S.wake) {
      await S.wake.release(); S.wake = null;
    }
  } catch (e) { /* no disponible en esta versión de iOS */ }
}

/** Si la app se cerró en mitad de una grabación, recupera lo que llegó a guardarse. */
async function recoverOrphans() {
  for (const r of await DB.all('recs')) {
    if (r.status !== 'recording') continue;
    r.durationMs = (r.lastChunkAt || r.createdAt) - r.createdAt;
    r.flags = (r.flags || []).concat('recovered');
    await finalizeRec(r);
  }
}

async function cleanupOld() {
  for (const r of await DB.all('recs')) {
    if (r.status === 'sent' && Date.now() - (r.sentAt || 0) > KEEP_MS) await DB.del('recs', r.id);
  }
}

/* ================= Envío a Telegram ================= */
function buildCaption(r) {
  const lines = [`🎙️ Cita médica${r.name ? ' — ' + r.name : ''}`];
  lines.push(`📅 ${fmtDate(r.createdAt)} · ⏱️ ${fmtDur(r.durationMs)}${r.part > 1 ? ` · Parte ${r.part}` : ''}`);
  const f = r.flags || [];
  if (f.includes('auto3h')) lines.push('⚠️ Corte automático (límite de 3 h)');
  if (f.includes('interrupt')) lines.push('⚠️ Se cortó (llamada, Siri o bloqueo de pantalla)');
  if (f.includes('recovered')) lines.push('♻️ Recuperada: la app se cerró mientras grababa');
  if (Date.now() - r.createdAt > 2 * 3600 * 1000) lines.push('📶 Enviada con retraso (no había conexión)');
  return lines.join('\n');
}

async function tg(method, fields) {
  // Solo FormData y sin cabeceras propias: así el navegador no hace "preflight" y Telegram lo acepta.
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) fd.append(k, v[0], v[1]); else if (v !== undefined && v !== null) fd.append(k, v);
  }
  const url = `https://api.telegram.org/bot${cfg.token}/${method}`;
  // Sin campos, GET (Telegram rechaza un formulario vacío)
  const resp = await fetch(url, Object.keys(fields).length ? { method: 'POST', body: fd } : {});
  let j;
  try { j = await resp.json(); } catch (e) { j = { ok: false, description: `HTTP ${resp.status}` }; }
  j.status = resp.status;
  return j;
}

async function sendRecording(r) {
  const ext = /webm/.test(r.mime) ? 'webm' : /aac/.test(r.mime) ? 'aac' : 'm4a';
  const d = new Date(r.createdAt);
  const fname = `Cita ${r.name || ''} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}${r.part > 1 ? ' parte ' + r.part : ''}.${ext}`.replace(/\s+/g, ' ');
  const caption = buildCaption(r);
  try {
    let j;
    if (ext !== 'webm') {
      j = await tg('sendAudio', {
        chat_id: cfg.chatId, caption, audio: [r.blob, fname],
        duration: Math.round(r.durationMs / 1000),
        title: `Cita médica${r.name ? ' — ' + r.name : ''}`, performer: fmtDate(r.createdAt),
      });
    }
    if (!j || (!j.ok && j.status === 400 && !/chat not found/i.test(j.description || ''))) {
      j = await tg('sendDocument', { chat_id: cfg.chatId, caption, document: [r.blob, fname] });
    }
    if (j.ok) return { ok: true };
    const fatal = [401, 403, 404].includes(j.status) || /chat not found/i.test(j.description || '');
    return { ok: false, error: j.description || `Error ${j.status}`, fatal };
  } catch (e) {
    return { ok: false, error: 'Sin conexión', network: true };
  }
}

let uploading = false;
async function uploadQueue() {
  if (uploading || !configured()) { refreshStatus(); return; }
  uploading = true;
  refreshStatus();
  try {
    const recs = (await DB.all('recs')).filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    for (const r of recs) {
      const res = await sendRecording(r);
      if (res.ok) Object.assign(r, { status: 'sent', sentAt: Date.now(), lastError: null });
      else Object.assign(r, { attempts: (r.attempts || 0) + 1, lastError: res.error });
      await DB.put('recs', r);
      if (!res.ok && (res.fatal || res.network)) break;
    }
  } catch (e) {
    console.warn(e);
  } finally {
    uploading = false;
    refreshStatus();
    if (!$('settings').hidden) renderRecList();
  }
}

/* ================= Pantalla principal ================= */
async function refreshStatus() {
  if (!['idle', 'starting'].includes(S.state)) return;
  const el = $('status');
  if (!configured()) { el.textContent = '⚠️ Falta configurar Telegram'; return; }
  let recs = [];
  try { recs = await DB.all('recs'); } catch (e) { /* nada */ }
  const pend = recs.filter((r) => r.status === 'pending');
  if (uploading && pend.length) el.textContent = `📤 Enviando ${pend.length === 1 ? 'la grabación' : pend.length + ' grabaciones'}…`;
  else if (pend.length) {
    const err = pend.find((r) => r.lastError)?.lastError;
    el.textContent = `⏳ ${pend.length} pendiente${pend.length > 1 ? 's' : ''} de enviar${err === 'Sin conexión' ? ' (sin conexión)' : ''}`;
  } else if (recs.length) el.textContent = '✓ Todo enviado';
  else el.textContent = '';
}

function showNotice(t) { const n = $('notice'); n.textContent = t; n.hidden = false; }
function hideNotice() { $('notice').hidden = true; }

/* ================= Configuración familiar ================= */
function openSettings() {
  $('fName').value = cfg.name;
  $('fToken').value = cfg.token;
  $('fChat').value = cfg.chatId;
  $('chatTitle').textContent = cfg.chatTitle ? `Se envía a: ${cfg.chatTitle}` : '';
  $('fEnhance').checked = cfg.enhance;
  $('chatList').innerHTML = '';
  $('testOut').textContent = '';
  $('version').textContent = `Grabar médico web ${VERSION} · formato ${MIME || 'por defecto'}`;
  $('settings').hidden = false;
  renderRecList();
}

function bindSettings() {
  $('fName').addEventListener('input', (e) => { cfg.name = e.target.value.trim(); saveConfig(); });
  $('fToken').addEventListener('input', (e) => { cfg.token = e.target.value.trim(); saveConfig(); });
  $('fChat').addEventListener('input', (e) => { cfg.chatId = e.target.value.trim(); cfg.chatTitle = ''; $('chatTitle').textContent = ''; saveConfig(); });
  $('fEnhance').addEventListener('change', (e) => { cfg.enhance = e.target.checked; saveConfig(); });
  $('toggleToken').addEventListener('click', () => {
    const i = $('fToken'); i.type = i.type === 'password' ? 'text' : 'password';
    $('toggleToken').textContent = i.type === 'password' ? 'Ver' : 'Ocultar';
  });
  $('closeSettings').addEventListener('click', () => { $('settings').hidden = true; refreshStatus(); uploadQueue(); });

  $('findChat').addEventListener('click', async () => {
    const list = $('chatList');
    if (!cfg.token) { list.innerHTML = '<p class="muted">Primero pega el Bot Token.</p>'; return; }
    list.innerHTML = '<p class="muted">Buscando…</p>';
    try {
      const j = await tg('getUpdates', {});
      if (!j.ok) { list.innerHTML = ''; list.append(msg(`❌ ${j.description || 'Error'}${j.status === 401 ? ' (el token no es correcto)' : ''}`)); return; }
      const chats = new Map();
      for (const u of j.result) {
        const m = u.message || u.edited_message || u.channel_post || u.my_chat_member;
        const c = m && m.chat;
        if (c) chats.set(String(c.id), c);
      }
      list.innerHTML = '';
      if (!chats.size) {
        list.append(msg('No aparece ningún chat. Abre el bot en Telegram y pulsa Iniciar (o escribe /start en el grupo) y vuelve a pulsar Buscar.'));
        return;
      }
      for (const [id, c] of chats) {
        const group = c.type !== 'private';
        const title = group ? c.title : [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || id;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${group ? '👥' : '👤'} ${title}`;
        if (id === cfg.chatId) b.classList.add('sel');
        b.addEventListener('click', () => {
          cfg.chatId = id; cfg.chatTitle = title; saveConfig();
          $('fChat').value = id;
          $('chatTitle').textContent = `Se envía a: ${title}`;
          list.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
        });
        list.append(b);
      }
    } catch (e) {
      list.innerHTML = ''; list.append(msg('❌ Sin conexión con Telegram.'));
    }
  });

  $('testBtn').addEventListener('click', async () => {
    const out = $('testOut');
    if (!configured()) { out.textContent = 'Falta el token o el chat.'; return; }
    out.textContent = 'Enviando…';
    try {
      const j = await tg('sendMessage', {
        chat_id: cfg.chatId,
        text: [
          '✅ Prueba de Grabar médico',
          `👤 ${cfg.name || '(sin nombre)'}`,
          `📱 ${deviceInfo()}`,
          `🏠 Instalada en pantalla de inicio: ${isStandalone() ? 'sí' : 'no (ábrela desde el icono)'}`,
          `🎙️ Formato: ${MIME || 'por defecto'} · Mejorar voces: ${cfg.enhance ? 'sí' : 'no'}`,
        ].join('\n'),
      });
      out.textContent = j.ok ? '✅ Enviado. Mira Telegram.' : `❌ ${j.description || 'Error ' + j.status}`;
    } catch (e) { out.textContent = '❌ Sin conexión con Telegram.'; }
  });

  $('sendNow').addEventListener('click', () => uploadQueue());
}

function msg(t) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = t; return p; }

async function renderRecList() {
  const ul = $('recList');
  const recs = (await DB.all('recs')).filter((r) => r.status !== 'recording').sort((a, b) => b.createdAt - a.createdAt);
  ul.innerHTML = '';
  if (!recs.length) { ul.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Todavía no hay grabaciones.' })); return; }
  for (const r of recs) {
    const li = document.createElement('li');
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${r.status === 'sent' ? '✅' : '⏳'} ${fmtDate(r.createdAt)} · ${fmtDur(r.durationMs)}${r.part > 1 ? ' · parte ' + r.part : ''} · ${fmtSize(r.size || 0)}`;
    li.append(meta);
    if (r.status === 'pending' && r.lastError) {
      const e = document.createElement('div'); e.className = 'err'; e.textContent = r.lastError; li.append(e);
    }
    const acts = document.createElement('div'); acts.className = 'acts';
    const play = document.createElement('button'); play.type = 'button'; play.textContent = '▶︎ Escuchar';
    play.addEventListener('click', () => {
      if (li.querySelector('audio')) return;
      const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(r.blob); li.append(a); a.play().catch(() => {});
    });
    const resend = document.createElement('button'); resend.type = 'button'; resend.textContent = r.status === 'sent' ? '↻ Reenviar' : '📤 Enviar';
    resend.addEventListener('click', async () => { r.status = 'pending'; await DB.put('recs', r); uploadQueue(); renderRecList(); });
    const del = document.createElement('button'); del.type = 'button'; del.textContent = '🗑 Borrar';
    del.addEventListener('click', async () => {
      if (!confirm(`¿Borrar la grabación del ${fmtDate(r.createdAt)}? No se puede recuperar.`)) return;
      await DB.del('recs', r.id); renderRecList(); refreshStatus();
    });
    acts.append(play, resend, del);
    li.append(acts);
    ul.append(li);
  }
}

/* Texto discreto: mantener pulsado 4 s para abrir */
function bindHiddenSettings() {
  const hint = $('cfgHint');
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; hint.classList.remove('holding'); };
  hint.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hint.classList.add('holding');
    timer = setTimeout(() => { cancel(); openSettings(); }, HOLD_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => hint.addEventListener(ev, cancel));
  hint.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ================= Arranque ================= */
async function init() {
  $('bigBtn').addEventListener('click', startRecording);
  $('stopBtn').addEventListener('click', () => stopRecording());
  bindHiddenSettings();
  bindSettings();

  if (!isStandalone()) {
    let dismissed = false;
    try { dismissed = localStorage.getItem('gm.installDismissed') === '1'; } catch (e) { /* nada */ }
    $('install').hidden = dismissed;
  }
  $('installClose').addEventListener('click', () => {
    $('install').hidden = true;
    try { localStorage.setItem('gm.installDismissed', '1'); } catch (e) { /* nada */ }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try { S.seg && S.seg.mr.state === 'recording' && S.seg.mr.requestData(); } catch (e) { /* nada */ }
    } else {
      if (S.state === 'recording') {
        keepAwake(true);
        const t = S.stream && S.stream.getAudioTracks()[0];
        if (!t || t.readyState === 'ended' || (S.seg && S.seg.mr.state === 'inactive')) interrupted();
      } else uploadQueue();
    }
  });
  window.addEventListener('pagehide', () => {
    try { S.seg && S.seg.mr.state === 'recording' && S.seg.mr.requestData(); } catch (e) { /* nada */ }
  });
  window.addEventListener('online', () => uploadQueue());
  setInterval(() => { if (S.state === 'idle') uploadQueue(); }, RETRY_MS);

  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* nada */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  try {
    await loadConfig();
    await recoverOrphans();
    await cleanupOld();
  } catch (e) {
    showNotice('No se puede guardar en este móvil (¿modo privado?). Las grabaciones podrían perderse.');
    console.warn(e);
  }
  refreshStatus();
  uploadQueue();
}

init();
