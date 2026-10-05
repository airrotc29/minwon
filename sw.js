/* 홈 화면 설치 요건 + 앱이 꺼져 있어도 울리는 알림(웹 푸시)용 서비스 워커. 저장(캐시)은 하지 않고 항상 서버에서 받아 온다. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });

/* 서버(send-push)가 보낸 알림: 앱 화면이 지금 보이고 있으면 앱이 직접 알리므로 띄우지 않는다 */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(err) { d = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    if(list.some(c => c.visibilityState === 'visible' && c.focused !== false)) return;
    return self.registration.showNotification(d.title || '민원관리 알림', {
      body: d.body || '', tag: d.tag || 'minwon', renotify: true, requireInteraction: true,
      icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [500, 200, 500, 200, 500, 200, 900],
      data: {id: d.id || null}
    });
  }));
});

/* 알림을 누르면 앱을 앞으로 가져와 그 민원을 연다 */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = (e.notification.data || {}).id;
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    if(list.length){
      const c = list[0];
      if(id) c.postMessage({open:id});
      return c.focus();
    }
    return self.clients.openWindow(id ? './?open=' + encodeURIComponent(id) : './');
  }));
});
