/* ═══════════════════════════════════════════════════════════════
   TaxiGo Ibiza — Capa de persistencia compartida
   ────────────────────────────────────────────────────────────────
   API pública: window.tgStore
     init(config)            — arranca Firebase si hay config válido
     isReady()               — true si Firebase está conectado
     mode()                  — 'firebase' | 'local'
     createTrip(trip)        — Promise<void>
     updateTrip(id, patch)   — Promise<void>
     getTrip(id)             — Promise<trip|null>
     getAllTrips()           — Promise<trip[]>  (admin)
     watchTrip(id, cb)       — () => unsubscribe
     watchSearching(cb)      — () => unsubscribe  (conductor)
     watchAcceptedBy(driverName, cb) — () => unsubscribe (conductor)
     watchAll(cb)            — () => unsubscribe  (admin)

   Sin config Firebase → fallback transparente a localStorage para que
   la app siga funcionando en demo y offline.
   ─────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const COLLECTION = 'trips';
  const LS_PREFIX  = 'taxigo_trip_';
  const SETTINGS_KEY = 'taxigo_firebase_config';

  // Config Firebase del proyecto — la apiKey de Firebase es pública por diseño.
  // La seguridad real está en las reglas de Firestore y los authorized domains.
  // Para cambiar de proyecto: edita aquí o usa Ajustes → Firebase en admin.html
  const DEFAULT_CONFIG = {
    apiKey:            "AIzaSyBp2mHnVRqs0YDlZ4OGf0-T0L7LwrgfV7g",
    authDomain:        "taxigo-ibiza.firebaseapp.com",
    projectId:         "taxigo-ibiza",
    storageBucket:     "taxigo-ibiza.firebasestorage.app",
    messagingSenderId: "1060879157492",
    appId:             "1:1060879157492:web:0919885920009147b336a1"
  };

  let db = null;
  let ready = false;

  // ── Helpers localStorage ─────────────────────────────────
  function lsAllTrips() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX)) continue;
      try { out.push(JSON.parse(localStorage.getItem(k))); } catch (e) {}
    }
    return out.filter(Boolean);
  }
  function lsGet(id) {
    try { return JSON.parse(localStorage.getItem(LS_PREFIX + id)); } catch (e) { return null; }
  }
  function lsSet(id, trip) {
    localStorage.setItem(LS_PREFIX + id, JSON.stringify(trip));
  }

  // Avisa a watchers locales cuando cambia el storage en otra pestaña
  const localWatchers = { trip: new Map(), searching: new Set(), accepted: new Map(), all: new Set() };

  function fireLocalWatchers() {
    const all = lsAllTrips();
    localWatchers.all.forEach(cb => safeCall(cb, all));
    localWatchers.searching.forEach(cb => safeCall(cb, all.filter(t => t.status === 'searching')));
    localWatchers.accepted.forEach((cbs, driver) => {
      const list = all.filter(t => t.driverName === driver);
      cbs.forEach(cb => safeCall(cb, list));
    });
    localWatchers.trip.forEach((cbs, id) => {
      const trip = all.find(t => t.id === id) || null;
      cbs.forEach(cb => safeCall(cb, trip));
    });
  }
  function safeCall(fn, arg) { try { fn(arg); } catch (e) { console.error(e); } }

  // Polling local cada 1.5s para imitar realtime sin Firebase
  let localPollTimer = null;
  function startLocalPolling() {
    if (localPollTimer) return;
    localPollTimer = setInterval(fireLocalWatchers, 1500);
  }
  function stopLocalPolling() {
    if (localPollTimer) { clearInterval(localPollTimer); localPollTimer = null; }
  }

  // También escuchamos eventos de storage entre pestañas (mismo dispositivo)
  window.addEventListener('storage', e => {
    if (e.key && e.key.startsWith(LS_PREFIX)) fireLocalWatchers();
  });

  // ── Init ─────────────────────────────────────────────────
  function init(config) {
    if (ready) return true;

    // Guarda config para futuras sesiones
    if (config && typeof config === 'object' && config.apiKey) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(config)); } catch (e) {}
    } else {
      // Intenta cargar config guardado
      try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        if (saved && saved.apiKey) config = saved;
      } catch (e) {}
    }

    // Fallback final: si seguimos sin config, usa la hardcodeada
    if (!config || !config.apiKey) config = DEFAULT_CONFIG;

    if (!config || !config.apiKey || !global.firebase) {
      // Sin Firebase SDK cargado → modo local
      startLocalPolling();
      console.info('[tgStore] Modo local (localStorage). El SDK de Firebase no está cargado o falta config.');
      return false;
    }

    try {
      if (!global.firebase.apps.length) global.firebase.initializeApp(config);
      db = global.firebase.firestore();
      // Login anónimo para que las reglas de Firestore puedan exigir auth
      if (global.firebase.auth) {
        global.firebase.auth().signInAnonymously().catch(err => {
          console.warn('[tgStore] Anonymous auth falló:', err.message);
        });
      }
      ready = true;
      stopLocalPolling();
      console.info('[tgStore] Firebase conectado. Proyecto:', config.projectId);
      return true;
    } catch (err) {
      console.error('[tgStore] Error inicializando Firebase:', err);
      startLocalPolling();
      return false;
    }
  }

  function isReady() { return ready && !!db; }
  function mode() { return isReady() ? 'firebase' : 'local'; }

  // ── Escrituras ───────────────────────────────────────────
  async function createTrip(trip) {
    if (!trip || !trip.id) throw new Error('trip.id required');
    const payload = { ...trip, updatedAt: Date.now() };
    lsSet(trip.id, payload);
    if (isReady()) {
      await db.collection(COLLECTION).doc(trip.id).set(payload);
      // Asegurar que el token FCM del cliente queda accesible por teléfono
      // (fallback que usa la Cloud Function si el doc no tiene clientFCMToken)
      try {
        const token = (typeof localStorage !== 'undefined') ? localStorage.getItem('tg_client_fcm_token') : null;
        if (token && trip.clientPhone) {
          await saveClientFcmToken({ phone: trip.clientPhone, token });
        }
      } catch (e) { /* no bloquear createTrip si falla el FCM-save */ }
    } else {
      fireLocalWatchers();
    }
  }

  async function updateTrip(id, patch) {
    if (!id) throw new Error('id required');
    const current = lsGet(id) || {};
    const merged = { ...current, ...patch, id, updatedAt: Date.now() };
    lsSet(id, merged);
    if (isReady()) {
      await db.collection(COLLECTION).doc(id).set(merged, { merge: true });
    } else {
      fireLocalWatchers();
    }
  }

  // ── Lecturas ─────────────────────────────────────────────
  async function getTrip(id) {
    if (isReady()) {
      try {
        const snap = await db.collection(COLLECTION).doc(id).get();
        if (snap.exists) {
          const data = snap.data();
          lsSet(id, data); // caché local
          return data;
        }
      } catch (e) { console.warn('[tgStore] getTrip fallback local:', e.message); }
    }
    return lsGet(id);
  }

  async function getAllTrips() {
    if (isReady()) {
      try {
        const q = await db.collection(COLLECTION).orderBy('updatedAt', 'desc').limit(500).get();
        const out = [];
        q.forEach(d => { const data = d.data(); out.push(data); lsSet(data.id, data); });
        return out;
      } catch (e) { console.warn('[tgStore] getAllTrips fallback local:', e.message); }
    }
    return lsAllTrips().sort((a, b) => (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0));
  }

  // ── Watchers ─────────────────────────────────────────────
  function watchTrip(id, cb) {
    if (isReady()) {
      return db.collection(COLLECTION).doc(id).onSnapshot(
        snap => {
          const data = snap.exists ? snap.data() : null;
          if (data) lsSet(id, data);
          safeCall(cb, data);
        },
        err => { console.warn('[tgStore] watchTrip error:', err.message); safeCall(cb, lsGet(id)); }
      );
    }
    if (!localWatchers.trip.has(id)) localWatchers.trip.set(id, new Set());
    localWatchers.trip.get(id).add(cb);
    safeCall(cb, lsGet(id));
    return () => { const s = localWatchers.trip.get(id); if (s) { s.delete(cb); if (!s.size) localWatchers.trip.delete(id); } };
  }

  function watchSearching(cb) {
    if (isReady()) {
      return db.collection(COLLECTION).where('status', '==', 'searching')
        .onSnapshot(
          snap => {
            const list = [];
            snap.forEach(d => { const data = d.data(); list.push(data); lsSet(data.id, data); });
            safeCall(cb, list);
          },
          err => { console.warn('[tgStore] watchSearching error:', err.message); safeCall(cb, lsAllTrips().filter(t => t.status === 'searching')); }
        );
    }
    localWatchers.searching.add(cb);
    safeCall(cb, lsAllTrips().filter(t => t.status === 'searching'));
    return () => localWatchers.searching.delete(cb);
  }

  // Devuelve TODOS los viajes asociados al conductor (any status). El caller filtra por status.
  function watchByDriver(driverName, cb) {
    if (isReady()) {
      return db.collection(COLLECTION).where('driverName', '==', driverName)
        .onSnapshot(
          snap => {
            const list = [];
            snap.forEach(d => { const data = d.data(); list.push(data); lsSet(data.id, data); });
            safeCall(cb, list);
          },
          err => { console.warn('[tgStore] watchByDriver error:', err.message); safeCall(cb, lsAllTrips().filter(t => t.driverName === driverName)); }
        );
    }
    if (!localWatchers.accepted.has(driverName)) localWatchers.accepted.set(driverName, new Set());
    localWatchers.accepted.get(driverName).add(cb);
    safeCall(cb, lsAllTrips().filter(t => t.driverName === driverName));
    return () => { const s = localWatchers.accepted.get(driverName); if (s) { s.delete(cb); if (!s.size) localWatchers.accepted.delete(driverName); } };
  }

  function watchAll(cb) {
    if (isReady()) {
      return db.collection(COLLECTION).orderBy('updatedAt', 'desc').limit(500)
        .onSnapshot(
          snap => {
            const list = [];
            snap.forEach(d => { const data = d.data(); list.push(data); lsSet(data.id, data); });
            safeCall(cb, list);
          },
          err => { console.warn('[tgStore] watchAll error:', err.message); safeCall(cb, lsAllTrips()); }
        );
    }
    localWatchers.all.add(cb);
    safeCall(cb, lsAllTrips());
    return () => localWatchers.all.delete(cb);
  }

  // ── FCM tokens del cliente (para push notifications) ─────────
  async function saveClientFcmToken({ phone, token }) {
    if (!phone || !token) return;
    if (isReady()) {
      // Doc por teléfono (un cliente puede tener varios dispositivos pero típicamente 1)
      const docId = btoa(unescape(encodeURIComponent(phone))).replace(/[^A-Za-z0-9]/g, '').slice(0, 80);
      await db.collection('clientFcmTokens').doc(docId).set({
        phone, token,
        platform: 'android', // iOS lo cambiará al detectar
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    try { localStorage.setItem('tg_client_fcm_token', token); } catch(e){}
  }

  // Actualizar viaje con el FCM token actual (útil para que la Cloud Function lo encuentre)
  async function attachClientTokenToTrip(tripId) {
    const token = localStorage.getItem('tg_client_fcm_token');
    if (!token || !tripId) return;
    try { await updateTrip(tripId, { clientFCMToken: token }); }
    catch (e) { console.warn('[tgStore] attachClientTokenToTrip:', e.message); }
  }

  // ── Chat in-app (subcolección trips/{tripId}/messages) ──────
  async function sendChatMessage(tripId, { from, fromName, text }) {
    if (!tripId || !text || !text.trim()) return;
    const msg = {
      from: from || 'client',       // 'client' | 'driver'
      fromName: fromName || '',
      text: String(text).slice(0, 500),
      ts: Date.now()
    };
    if (isReady()) {
      // Mensaje en la subcolección
      await db.collection(COLLECTION).doc(tripId).collection('messages').add({
        ...msg,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      // Marca en el doc del viaje para badges de no leídos del OTRO
      const flagField = from === 'driver' ? 'unreadByClient' : 'unreadByDriver';
      const incField  = from === 'driver' ? 'unreadByClientCount' : 'unreadByDriverCount';
      await db.collection(COLLECTION).doc(tripId).update({
        lastMessageAt: Date.now(),
        lastMessageFrom: msg.from,
        lastMessagePreview: msg.text.slice(0, 60),
        [flagField]: true,
        [incField]: firebase.firestore.FieldValue.increment(1)
      });
    }
  }

  function watchChat(tripId, cb) {
    if (!tripId || !isReady()) return () => {};
    return db.collection(COLLECTION).doc(tripId).collection('messages')
      .orderBy('ts', 'asc')
      .onSnapshot(snap => {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        cb(list);
      }, err => console.warn('[tgStore] watchChat error:', err.message));
  }

  async function markChatRead(tripId, who) {
    if (!tripId || !isReady()) return;
    const field = who === 'driver' ? 'unreadByDriver' : 'unreadByClient';
    const cnt   = who === 'driver' ? 'unreadByDriverCount' : 'unreadByClientCount';
    try { await db.collection(COLLECTION).doc(tripId).update({ [field]: false, [cnt]: 0 }); }
    catch (e) { /* el doc puede no existir o no haber mensajes aún */ }
  }

  // ── Export ───────────────────────────────────────────────
  global.tgStore = {
    init, isReady, mode,
    createTrip, updateTrip, getTrip, getAllTrips,
    watchTrip, watchSearching, watchByDriver, watchAll,
    saveClientFcmToken, attachClientTokenToTrip,
    sendChatMessage, watchChat, markChatRead
  };

  // Auto-init en próxima tick: si ya hay config guardado, conecta solo
  setTimeout(() => { if (!ready) init(); }, 0);
})(window);
