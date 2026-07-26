const CACHE_NAME = 'bookandbite-v1';

// Archivos básicos a guardar en caché
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './img/app-icon.png'
];

// Instalación del Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Caché abierta');
        return cache.addAll(urlsToCache);
      })
  );
  self.skipWaiting(); // Obliga a activar el SW inmediatamente
});

// Interceptar peticiones (Necesario para instalar la app)
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response; // Devuelve desde caché
        }
        return fetch(event.request); // Pide a la red si no está en caché
      })
  );
});

// Limpieza de cachés antiguas
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});