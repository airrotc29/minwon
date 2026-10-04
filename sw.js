/* 홈 화면 설치 요건용 최소 서비스 워커. 저장(캐시)은 하지 않고 항상 서버에서 받아 온다. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });

/* 새 민원 알림을 누르면 앱을 앞으로 가져온다 */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(l => l.length ? l[0].focus() : self.clients.openWindow('./')));
});
