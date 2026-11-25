/* Kenosis — service worker
   1) tiene l'app disponibile anche senza rete;
   2) mostra gli avvisi. Il testo lo prepara l'app (sul telefono) e lo lascia qui:
      dal servizio online arriva solo un "campanello" vuoto, all'ora giusta.
      Senza sincronizzazione, Chrome lo sveglia una o due volte al giorno. */

const CACHE = 'kenosis-v4';
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

/* ------------------------------------------------ avvisi */

const STORES = ['voci', 'eventi', 'ospiti', 'documenti', 'farmaci', 'servizi', 'somministrazioni', 'visite', 'parametri', 'lista', 'kv', 'coda'];
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const momentoDi = d => iso(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());

function apriDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kenosis', 3);
    r.onupgradeneeded = () => {
      STORES.forEach(s => { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); });
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); resolve(db); };
    r.onerror = () => reject(r.error);
  });
}
function leggi(db, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(id);
    req.onsuccess = () => resolve(req.result ? req.result.v : undefined);
    req.onerror = () => reject(req.error);
  });
}
function scrivi(db, id, v) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put({ id, v });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// I momenti già passati (fino a 40 minuti fa) e non ancora mostrati.
async function daMostrare(db, finestraMin) {
  const elenco = (await leggi(db, 'momenti')) || [];
  const mostrati = new Set((await leggi(db, 'mostrati')) || []);
  const ora = new Date();
  const da = momentoDi(new Date(ora.getTime() - finestraMin * 60000));
  const a = momentoDi(new Date(ora.getTime() + 2 * 60000));
  return { elenco: elenco.filter(m => m.t > da && m.t <= a && !mostrati.has(m.t + m.x)), mostrati };
}
async function mostra(db, lista, mostrati) {
  if (!lista.length) return false;
  // il più importante prima: terapia, poi solleciti, poi il resto
  const peso = { t: 0, s: 1, v: 2, m: 3, r: 4 };
  lista.sort((x, y) => (peso[x.x] ?? 9) - (peso[y.x] ?? 9));
  const titolo = lista[0].x === 't' || lista[0].x === 's' ? 'Kenosis · Terapia' : 'Kenosis';
  const corpo = lista.map(m => m.testo).join('\n');
  await self.registration.showNotification(titolo, {
    body: corpo, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'kenosis-' + lista[0].x, renotify: true,
    data: { url: lista[0].x === 't' || lista[0].x === 's' ? './#/oggi' : './' }
  });
  lista.forEach(m => mostrati.add(m.t + m.x));
  await scrivi(db, 'mostrati', [...mostrati].slice(-300));
  return true;
}

self.addEventListener('push', e => { e.waitUntil(suCampanello()); });
async function suCampanello() {
  let fatto = false;
  try {
    const db = await apriDB();
    const { elenco, mostrati } = await daMostrare(db, 45);
    fatto = await mostra(db, elenco, mostrati);
  } catch (err) { /* sotto, comunque una notifica */ }
  if (!fatto) {
    await self.registration.showNotification('Kenosis', {
      body: 'C\'è qualcosa da vedere: apri l\'app.', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'kenosis-novita', data: { url: './' }
    });
  }
}

// Senza sincronizzazione: quando Chrome lo permette, il riepilogo di oggi.
self.addEventListener('periodicsync', e => {
  if (e.tag === 'kenosis-avvisi') e.waitUntil(riepilogoDiOggi());
});
async function riepilogoDiOggi() {
  const db = await apriDB();
  const oggi = iso(new Date());
  const elenco = (await leggi(db, 'momenti')) || [];
  const mostrati = new Set((await leggi(db, 'mostrati')) || []);
  const m = elenco.find(x => x.x === 'm' && x.t.startsWith(oggi) && !mostrati.has(x.t + x.x));
  if (m) await mostra(db, [m], mostrati);
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(finestre => {
      for (const f of finestre) if ('focus' in f) { if ('navigate' in f && url !== './') f.navigate(url).catch(() => {}); return f.focus(); }
      return self.clients.openWindow(url);
    })
  );
});
