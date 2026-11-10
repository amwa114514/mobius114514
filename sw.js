// 小手机 · 装到桌面上要的那个 service worker
// 只做两件事：①让浏览器认它是可安装的应用 ②断网时还能打开（壳走缓存）
// 数据（档案、头像、聊天）本来就在本机 localStorage / IndexedDB 里，不经过这儿。
//
// 2026-09-08 修：原来这个文件从 09-04 起一个字节没变过，浏览器认字节不认内容——
// 文件没变它就不重装 worker，'mini-shell-v1' 这个缓存也就永远不清。上线一百次，
// 桌面上那台可以一直守着九月四号的壳。现在版本号由 上线.sh 每次上线现盖时间戳，
// 字节必变 → 必重装 → activate 里把旧缓存全删掉。
const BUILD = '20261111-032443';
const CACHE = 'mini-shell-' + BUILD;
// 2026-09-24：带哈希名的静态件另放一个桶，上线不清。
// 原来整桶跟着 BUILD 换，每次上线手机里所有软件都得重新下载，点开就白屏等。
// 哈希名的文件内容变了名字就变，没改的软件哈希不变，留着就是对的。
const ASSETS = 'mini-assets';
const ASSETS_MAX = 400;
// 2026-10-10 她转来公测 iPhone「黑屏卡死，大退再进才行」：开屏要等标志图，标志图原来在跟着 BUILD 换的桶里，
// 每次上线都得重新去 pages.dev 下，国内直连常挂在半路。开屏要用的图单独放一个上线不清、也不按上限删的桶。
// 这几张图要换内容就换文件名（或带 ?v=），别原名覆盖，不然手机里一直是旧的。
const BRAND = 'mini-brand';
const BRAND_FILES = ['/mobius-icon-512.png', '/mobius-icon-192.png'];

// 2026-10-10 23:38 她转来公测 iPhone：「这次竟然是大白屏，等了九秒，大退后重新打开才好」。
// 白屏＝首页那张小网页拿到了，开机要的那包程序（入口 + boot 一串，九百来 K）还卡在路上，#root 没样式撑不开，
// 只露出 body 的浅底。每上一次线这包的名字就全换，所有人下次打开都得现场重下；那天晚上连上了六回线。
// 改成：新版的开机包先在后台整包下进手机，下齐了才让首页换成新版；没下齐就先用手机里那份旧首页开机
// （它要的包都在手机里），新版接着在后台下，下次打开就是新的。

// 2026-10-24 22:35 她转 iOS 买家：下午修过还是卡在「网络有点慢」。从我们服务器连 pages.dev 下开机包每个文件 0.1 秒，
// 可他换了几个网络都进不来，后面三次上线新 worker 也都没装上（装的时候要整包下开机文件）——他那条线路从 pages.dev 拉不下大文件。
// 程序文件在我们国内服务器上也放一份（nginx 直接发 xiaoshouji/.assets-history，上线时每次都存进去），pages.dev 拿不到就去那儿拿。
const MIRROR = 'https://api.shenyuluyu.duckdns.org/attachments/mobius-bundle/web';
const isFile = r => r && r.ok && !(r.headers.get('content-type') || '').includes('text/html');
// 2026-11-05 23:28 她转 iPhone 12 Pro 买家：「打开每个软件都要等十几秒」。原来是 pages.dev 等满 10 秒才去镜像，
// 那天镜像被 99 台拿了 1889 个文件，每个背后都白等了 10 秒。改成：先手那条 2 秒没下完就两条一起拿，谁先下完用谁；
// 镜像赢过一次，这台接下来半小时镜像先手。她 23:34 点头「放成可以从咱们这里走」。
const HEAD_START = 2000;
const PREFER_MIRROR_MS = 30 * 60 * 1000;
let preferMirrorUntil = 0;
/** 拿 /assets/ 下一个文件：pages.dev 和国内镜像赛跑（先手 2 秒），拿错了（网页、404）不算数；别的路径只走 pages.dev */
async function fetchAsset(u) {
  const p = new URL(u, self.location.origin).pathname;
  const whole = async r => {
    if (!isFile(r)) throw new Error('bad ' + p);
    return new Response(await r.blob(), { headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' } });
  };
  // 超时要真掐断：挂着的请求不掐，浏览器同时放出去的请求有数，去镜像的那条会排在它们后面一起等
  const acMain = new AbortController();
  const tMain = setTimeout(() => acMain.abort(), 10000);
  const main = () => fetch(u, { signal: acMain.signal }).then(whole);
  if (!p.startsWith('/assets/')) {
    try { return await main(); } finally { clearTimeout(tMain); }
  }
  const acMirror = new AbortController();
  const mirror = () => fetch(MIRROR + p, { mode: 'cors', signal: acMirror.signal }).then(whole);
  const mirrorFirst = Date.now() < preferMirrorUntil;
  const legs = mirrorFirst ? [mirror, main] : [main, mirror];
  return new Promise((resolve, reject) => {
    let started = 0, failed = 0, done = false, timer = 0;
    const startNext = () => {
      if (done || started >= 2) return;
      const i = started++;
      legs[i]().then(r => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(tMain);
        const byMirror = legs[i] === mirror;
        (byMirror ? acMain : acMirror).abort();
        if (byMirror && !mirrorFirst) preferMirrorUntil = Date.now() + PREFER_MIRROR_MS;
        if (!byMirror && mirrorFirst) preferMirrorUntil = 0;   // 镜像先手反倒输了（拿不到或更慢），回到 pages.dev 先手
        resolve(r);
      }, err => {
        failed++;
        if (done) return;
        if (failed >= 2) { done = true; clearTimeout(timer); clearTimeout(tMain); reject(err); return; }
        clearTimeout(timer);
        startNext();
      });
    };
    startNext();
    timer = setTimeout(startNext, HEAD_START);
  });
}

/** 首页 → 开机那一下必须有的文件：入口脚本、首页直接挂的样式，加上入口里 __vite__mapDeps 列的那一串 */
async function bootFiles(html, entryText) {
  const m = html.match(/<script[^>]*type="module"[^>]*src="\.?\/?(assets\/[^"]+\.js)"/);
  if (!m) return null;
  const entry = '/' + m[1];
  const files = [entry];
  for (const x of html.matchAll(/<link[^>]*href="\.?\/?(assets\/[^"]+\.css)"/g)) files.push('/' + x[1]);
  const js = await entryText(entry);
  if (js == null) return null;
  const dm = js.match(/m\.f=\[([^\]]*)\]/);
  if (dm) for (const x of dm[1].matchAll(/"\.\/([^"]+)"/g)) files.push('/assets/' + x[1]);
  return [...new Set(files)];
}

/** 这张首页开机要的文件是不是全在手机里 */
async function bootReady(html) {
  const files = await bootFiles(html, async u => { const r = await caches.match(u, { ignoreVary: true }); return r ? r.text() : null; });
  if (!files) return false;
  for (const u of files) if (!(await caches.match(u, { ignoreVary: true }))) return false;
  return true;
}

/** 把这张首页开机要的文件下进 ASSETS 桶；缺一个就整个算失败（宁可接着用旧的） */
async function fetchBoot(html) {
  const c = await caches.open(ASSETS);
  const get = async u => {
    const hit = await caches.match(u, { ignoreVary: true });
    // 手机里本来就有的（没改过的老文件）也重新放一遍，排到桶的最后——
    // activate 按「最早放进去的先删」清桶，不挪的话正好删掉开机要的老文件（见 activate 里 10-24 那段）
    if (hit) { await c.delete(u, { ignoreVary: true }); await c.put(u, hit.clone()); return hit; }
    const r = await fetchAsset(u);
    await c.put(u, r.clone());
    return r;
  };
  const files = await bootFiles(html, async u => (await get(u)).text());
  if (!files) throw new Error('no boot files');
  await Promise.all(files.map(get));
}

/** 新首页：开机包下齐了才存成「手机里那份首页」 */
async function adoptHome(html, headers, cacheName = CACHE) {
  await fetchBoot(html);
  const c = await caches.open(cacheName);
  await c.put('/index.html', new Response(html, { headers }));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const r = await fetch('/', { cache: 'no-store' });
    if (!r.ok) throw new Error('home ' + r.status);
    await adoptHome(await r.text(), r.headers);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== ASSETS && k !== BRAND).map(k => caches.delete(k))))
      .then(() => caches.open(ASSETS)).then(async c => {
        // 桶只进不出会越长越大：超过上限就从最早放进去的开始删
        // 2026-10-24 19:43 她转 iOS 买家：点了「换上」一直卡在开屏「网络有点慢」，换几个网络都进不来。
        // 新版没改过的老文件（react、db 这些）手机里早有，装的时候直接复用、排位还在最前面，接管一清桶正好被删——
        // 开机要的文件没了，只能现去 pages.dev 下，国内连不上就永远开不了机。手机里那份首页开机要的文件一个都不许删
        const home = await caches.match('/index.html');
        const keep = new Set();
        if (home) {
          const files = await bootFiles(await home.text(), async u => { const r = await c.match(u, { ignoreVary: true }); return r ? r.text() : null; }).catch(() => null);
          for (const f of files || []) keep.add(new URL(f, self.location.origin).href);
        }
        const keys = (await c.keys()).filter(k => !keep.has(new URL(k.url).origin + new URL(k.url).pathname));
        await Promise.all(keys.slice(0, Math.max(0, keys.length + keep.size - ASSETS_MAX)).map(k => c.delete(k)));
      })
      .then(() => self.clients.claim())
  );
});

// 2026-09-09 通知：通知的弹出走的是 worker 的 showNotification（安卓不让页面直接
// new Notification），点一下通知回到小手机——开着就提到前面，没开就开一个。
self.addEventListener('push', e => {
  const m=e.data?.json();
  if(!m || typeof m.role!=='string')return;
  e.waitUntil(self.registration.showNotification(m.name||'小手机',{body:m.text,tag:m.id,icon:'/icon-192.png',data:{target:{app:'chat',roleId:m.role}}}));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = e.notification.data?.target;
    const drawer = target?.app === 'drawer' && typeof target.roleId === 'string' && target.roleId;
    for (const c of all) {
      if (new URL(c.url).origin !== self.location.origin || !('focus' in c)) continue;
      if (drawer || target?.app === 'chat') c.postMessage({ type: 'mini-notification-open', target });
      return c.focus();
    }
    const url = drawer ? '/?mini-notify=drawer&role=' + encodeURIComponent(target.roleId) + '&section=' + (target.tab === 'secret' ? 'secret' : 'mail') : target?.app==='chat' ? '/?mini-notify=chat&role='+encodeURIComponent(target.roleId) : '/';
    return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 别插手模型接口那些外部请求
  // Private, time-dependent subtitle sessions must never enter the PWA asset cache.
  if (url.pathname.startsWith('/offline-message/')) { e.respondWith(fetch(req, {cache:'no-store'})); return; }
  if (url.pathname.startsWith('/bili-watch2/')) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }
  // 仓库接口：列表、详情、封面都是活的，进了下面那个「先吃缓存」就永远是第一次看到的样子——
  // 新上架的看不见、删了的还在（2026-11-01 11:40 验收抓到：上架后「发现」一直空着）
  if (url.pathname.startsWith('/warehouse-api/')) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }


  // 公告必须每次拿线上最新版本，不能进壳缓存；否则发了新公告，装到桌面的旧 PWA 可能一直看不到。
  if (url.pathname === '/announcement.json') {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // manifest 决定安卓安装弹窗里的应用名。以前被旧 worker 的静态缓存咬住后，
  // 明明已经改成 Möbius，Chrome 仍可能显示旧的“小手机”。这里强制每次从网络取。
  if (url.pathname === '/manifest.webmanifest') {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // 页面本身：先走网络，拿不到再吃缓存（这样每次上线你都能刷到新的）
  // 网络给了个 5xx 也算没拿到——宁可给旧的能用的，也别给一张报错页
  // 2026-10-08 19:35 她：「我主站打不开了呀，老打不开，老卡」。国内连 pages.dev 时好时坏，
  // 首页超过 4 秒没回来，先拿缓存里那张壳开机；网络那份照样等着，回来了接着在后台收。没缓存（第一次打开）还是只能等网络。
  // 2026-10-10 白屏那次加的：网络那份首页回来了，但它要的开机包手机里没有（刚上过线），
  // 就先拿手机里那份旧首页开机，新版的包在后台下齐了再换上——见文件开头 bootFiles 那段。
  if (req.mode === 'navigate') {
    const isHome = new URL(req.url).pathname === '/';
    const isRedirect = r => r && (r.type === 'opaqueredirect' || r.redirected || (r.status >= 300 && r.status < 400));
    const net = fetch(req).then(r => {
        // Cloudflare Pages 会把 /fix.html 这类地址 308 到 /fix。
        // 跳转要原样交回给浏览器，当成「拿失败了」的话整页会直接 ERR_FAILED。
        if (isRedirect(r)) return r;
        if (!r || !r.ok) throw new Error('bad response');
        return r;
      });
    const cached = () => caches.match('/index.html');
    if (!isHome) {
      e.respondWith(net.catch(() => cached().then(hit => hit || fetch(req))));
      return;
    }
    // 后台活（收新首页、下开机包）要在 respondWith 之后接着干，先占住 worker 的命
    let bgDone;
    e.waitUntil(new Promise(res => { bgDone = res; }));
    const background = job => { job.catch(() => {}).then(bgDone); };
    // 只有首页那一张值得当断网兜底；别的页面（体检页之类）不许顶掉它
    const adoptAny = r => isRedirect(r) ? null : r.text().then(html => adoptHome(html, r.headers));
    const adoptLater = r => background(r.clone().text().then(html => adoptHome(html, r.headers)));
    e.respondWith((async () => {
      const old = await cached();
      const r = await Promise.race([net.catch(() => null), new Promise(res => setTimeout(() => res('slow'), 4000))]);
      if (r && r !== 'slow') {
        if (isRedirect(r)) { bgDone(); return r; }
        if (!old) { adoptLater(r); return r; }            // 手机里没有旧首页，只能用这张
        const html = await r.clone().text();
        if (await bootReady(html)) {
          background(caches.open(CACHE).then(c => c.put('/index.html', new Response(html, { headers: r.headers }))));
          return r;
        }
        adoptLater(r);
        return old;
      }
      if (old) { background(net.then(adoptAny)); return old; }
      bgDone();
      return net.catch(() => fetch(req));
    })());
    return;
  }

  // 静态件（带哈希名，改了名字就是新文件）：先吃缓存，快
  // 缓存整桶跟着 BUILD 走，上线就换新桶，不会拿旧壳配新页
  const bucket = BRAND_FILES.includes(url.pathname) ? BRAND : url.pathname.includes('/assets/') ? ASSETS : CACHE;
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetchAsset(req.url).then(r => {
      const copy = r.clone(); caches.open(ASSETS).then(c => c.put(req, copy));
      return r;
    })));
    return;
  }
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      // 找不到的文件 Pages 会拿首页顶上来还是 200；把一张网页存成脚本，这个软件就永远打不开
      const html = (r.headers.get('content-type') || '').includes('text/html');
      if (r.ok && !html) { const copy = r.clone(); caches.open(bucket).then(c => c.put(req, copy)); }
      return r;
    }))
  );
});
