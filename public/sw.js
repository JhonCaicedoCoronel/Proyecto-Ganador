const CACHE_NAME = 'costenita-app-v1';

// Se instala la App en el teléfono
self.addEventListener('install', (event) => {
    console.log('La Costeñita App: Instalada correctamente');
    self.skipWaiting();
});

// Se activa la App
self.addEventListener('activate', (event) => {
    console.log('La Costeñita App: Lista para funcionar');
    return self.clients.claim();
});

// Permite que la app siga conectada a internet en tiempo real
self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request).catch(() => {
        return new Response('Estás sin conexión a internet. Revisa tus datos.');
    }));
});