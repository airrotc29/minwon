/* 홈 화면 설치 요건용 최소 서비스 워커. 저장(캐시)은 하지 않고 항상 서버에서 받아 온다. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });
