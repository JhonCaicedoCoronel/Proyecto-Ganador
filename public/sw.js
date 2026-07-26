// Nombre de la memoria caché
const CACHE_NAME = 'book-and-bite-v1';

// Archivos que queremos guardar para que cargue más rápido
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/img/app-icon.png'
];

// Instalación del Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// Requisito indispensable para que el celular permita instalar la app
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Devuelve el archivo guardado si existe, si no, lo pide a internet
        return response || fetch(event.request);
      })
  );
});