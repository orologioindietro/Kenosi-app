/* Kenosis — service worker
   1) tiene l'app disponibile anche senza rete
   2) una o due volte al giorno (quando Chrome lo permette) controlla le scadenze
      salvate sul telefono e mostra un riepilogo. Nessun dato esce dal telefono. */

const CACHE = 'kenosis-v1';
const FILE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(chiavi => Promise.all(chiavi.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Prima la rete, così gli aggiornamenti arrivano; senza rete, la copia salvata.
    e.respondWith(
      fetch(req)
        .then(res => { const copia = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copia)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});

/* ------------------------------------------------ avvisi in background */

self.addEventListener('periodicsync', e => {
  if (e.tag === 'kenosis-avvisi') e.waitUntil(controllaScadenze());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(finestre => {
      for (const f of finestre) if ('focus' in f) return f.focus();
      return self.clients.openWindow('./');
    })
  );
});

const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const aData = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const giorniTra = (a, b) => Math.round((aData(b) - aData(a)) / 86400000);

function apriDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kenosis', 1);
    r.onupgradeneeded = () => {
      ['voci', 'eventi', 'ospiti', 'documenti', 'farmaci', 'kv'].forEach(s => {
        if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
      });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function tutti(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function scrivi(db, store, obj) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(obj);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function controllaScadenze() {
  const db = await apriDB();
  const oggi = iso(new Date());
  const kv = {};
  (await tutti(db, 'kv')).forEach(x => { kv[x.id] = x.v; });
  if (kv.ultimaNotifica === oggi) return;

  const voci = (await tutti(db, 'voci')).filter(v => v.attiva !== false && v.prossima);
  const ritardo = voci.filter(v => v.prossima < oggi).length;
  const diOggi = voci.filter(v => v.prossima === oggi).length;
  const inArrivo = voci.filter(v => { const n = giorniTra(oggi, v.prossima); return n > 0 && n <= Math.max(v.avviso || 0, 1); }).length;

  const farmaci = (await tutti(db, 'farmaci')).filter(f => {
    const passati = Math.max(0, giorniTra(f.contatoIl || oggi, oggi));
    const alGiorno = Number(f.alGiorno) || 0;
    const rimaste = Math.max(0, (Number(f.inCasa) || 0) - passati * alGiorno);
    const giorni = alGiorno > 0 ? Math.floor(rimaste / alGiorno) : null;
    const scade = f.scadenza && giorniTra(oggi, f.scadenza) <= 30;
    return (giorni !== null && giorni <= (f.soglia == null ? 10 : f.soglia)) || scade;
  }).length;

  const parti = [];
  if (ritardo) parti.push(ritardo + ' in ritardo');
  if (diOggi) parti.push(diOggi + ' per oggi');
  if (inArrivo) parti.push(inArrivo + ' in arrivo');
  if (farmaci) parti.push(farmaci + (farmaci === 1 ? ' farmaco' : ' farmaci') + ' da controllare');
  if (!parti.length) return;

  // Nessun nome di ospite o farmaco nella notifica: si vede anche a schermo bloccato.
  await self.registration.showNotification('Kenosis', {
    body: parti.join(' · '), icon: 'icon-192.png', badge: 'icon-192.png', tag: 'kenosis-oggi'
  });
  await scrivi(db, 'kv', { id: 'ultimaNotifica', v: oggi });
}
