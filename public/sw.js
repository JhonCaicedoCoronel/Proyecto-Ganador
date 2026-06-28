const CACHE_NAME = 'costenita-app-v1';

self.addEventListener('install', (event) => {
    console.log('La Costeñita App: Instalada correctamente');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('La Costeñita App: Lista para funcionar');
    return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request).catch(() => {
        return new Response('Estás sin conexión a internet. Revisa tus datos.');
    }));
});