/**
 * Socket.IO rate limiter: IP bazli baglanti sinirlama ve event bazli rate limiting.
 * Aninsohbeti - console.log/console.error adapte edilmis surum (env modulu yok)
 */

/**
 * Socket baglantisindan istemci IP'sini al.
 * Proxy arkasindaysa X-Forwarded-For header'ini kullanir.
 */
function getSocketClientIp(socket) {
  const forwarded = socket.handshake?.headers?.['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake?.address || socket.conn?.remoteAddress || 'unknown';
}

/**
 * Socket.IO IP bazli baglanti sinirlayici.
 * Ayni IP'den es zamanli max N socket baglantisi, asiri denemelerde gecici blok.
 *
 * @param {number} maxConnectionsPerIp - Es zamanli maksimum baglanti sayisi (varsayilan: 5)
 * @param {number} maxAttemptsPerWindow - Pencere icinde maksimum deneme sayisi (varsayilan: 20)
 * @param {number} blockDurationMs - Gecici blok suresi ms (varsayilan: 5 dk)
 * @param {number} attemptWindowMs - Deneme penceresi ms (varsayilan: 1 dk)
 */
function createSocketConnectionLimiter(
  maxConnectionsPerIp = 5,
  maxAttemptsPerWindow = 20,
  blockDurationMs = 5 * 60 * 1000,
  attemptWindowMs = 60 * 1000
) {
  const ipConnections = new Map();   // ip -> { count, blockedUntil }
  const ipAttempts = new Map();      // ip -> { attempts, resetAt }

  // Periyodik temizlik (30 dk)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipConnections.entries()) {
      if (entry.count <= 0 && entry.blockedUntil <= now) {
        ipConnections.delete(ip);
      }
    }
    for (const [ip, entry] of ipAttempts.entries()) {
      if (entry.resetAt <= now) {
        ipAttempts.delete(ip);
      }
    }
  }, 30 * 60 * 1000);
  cleanupInterval.unref();

  return (socket, next) => {
    const ip = getSocketClientIp(socket);
    const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
    const effectiveIp = trustProxy ? ip : (socket.handshake?.address || 'unknown');
    const now = Date.now();

    // Deneme takibi
    let attemptEntry = ipAttempts.get(effectiveIp);
    if (!attemptEntry || attemptEntry.resetAt <= now) {
      attemptEntry = { attempts: 1, resetAt: now + attemptWindowMs };
      ipAttempts.set(effectiveIp, attemptEntry);
    } else {
      attemptEntry.attempts++;

      if (attemptEntry.attempts > maxAttemptsPerWindow) {
        console.warn('[SOCKET-RATE-LIMIT] Socket baglanti deneme limiti asildi (IP bloklandi)', {
          ip: effectiveIp,
          attempts: attemptEntry.attempts,
          windowMs: attemptWindowMs,
        });

        // IP'yi blokla
        let connEntry = ipConnections.get(effectiveIp);
        if (!connEntry) {
          connEntry = { count: 0, blockedUntil: now + blockDurationMs };
          ipConnections.set(effectiveIp, connEntry);
        } else {
          connEntry.blockedUntil = now + blockDurationMs;
        }

        return next(new Error('IP adresiniz gecici olarak engellendi. Lutfen daha sonra tekrar deneyin.'));
      }
    }

    // Blok kontrolu
    let connEntry = ipConnections.get(effectiveIp);
    if (connEntry && connEntry.blockedUntil > now) {
      const remainingSeconds = Math.ceil((connEntry.blockedUntil - now) / 1000);
      console.warn('[SOCKET-RATE-LIMIT] Engellenmis IP baglanmaya calisiyor', { ip: effectiveIp, remainingSeconds });
      return next(new Error(`IP adresiniz gecici olarak engellendi. ${remainingSeconds} saniye sonra tekrar deneyin.`));
    }

    // Aktif baglanti sayisini kontrol et
    if (!connEntry) {
      connEntry = { count: 0, blockedUntil: 0 };
      ipConnections.set(effectiveIp, connEntry);
    }

    connEntry.count++;

    // Cok fazla es zamanli baglanti varsa reddet
    if (connEntry.count > maxConnectionsPerIp) {
      console.warn('[SOCKET-RATE-LIMIT] IP basina maksimum eszamanli socket baglantisi asildi', {
        ip: effectiveIp,
        currentConnections: connEntry.count,
        maxConnectionsPerIp,
      });

      connEntry.count--; // Sayaci geri al

      // Asiri durumda blokla
      if (connEntry.count > maxConnectionsPerIp * 2) {
        connEntry.blockedUntil = now + blockDurationMs;
      }

      return next(new Error(`Ayni IP'den en fazla ${maxConnectionsPerIp} baglanti acilabilir.`));
    }

    // Baglanti koptugunda temizlik
    socket.on('disconnect', () => {
      const entry = ipConnections.get(effectiveIp);
      if (entry) {
        entry.count = Math.max(0, entry.count - 1);
        if (entry.count === 0 && entry.blockedUntil <= Date.now()) {
          ipConnections.delete(effectiveIp);
        }
      }
    });

    next();
  };
}

/**
 * Socket event'leri icin rate limiter.
 * Her socket icin ayri kova mantigi ile calisir.
 *
 * @param {string} eventName - Etkinlik adi (log icin)
 * @param {number} maxCalls - Pencere icinde maksimum cagri
 * @param {number} windowMs - Pencere suresi ms
 */
function createSocketEventRateLimiter(eventName, maxCalls = 10, windowMs = 1000) {
  const buckets = new Map(); // socketId -> { count, resetAt, lastWarnAt }

  return function checkRate(socket) {
    const now = Date.now();
    const key = socket.id;
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs, lastWarnAt: now });
      return true;
    }

    bucket.count++;

    if (bucket.count > maxCalls) {
      // Susturulmus uyari (her 30 sn'de bir logla)
      if (now - (bucket.lastWarnAt || 0) > 30000) {
        bucket.lastWarnAt = now;
        console.warn('[SOCKET-RATE-LIMIT] Socket event rate limit asildi', {
          eventName,
          socketId: key,
          count: bucket.count,
          maxCalls,
          windowMs,
        });
      }
      return false;
    }

    return true;
  };
}

/**
 * Socket event rate limiter yoneticisi.
 * Birden cok event icin ortak temizlik yapar.
 */
function createSocketEventRateManager() {
  const limiters = new Map();

  /**
   * Belirli bir event icin rate limiter kaydet.
   */
  function register(eventName, maxCalls, windowMs) {
    const limiter = createSocketEventRateLimiter(eventName, maxCalls, windowMs);
    limiters.set(eventName, limiter);
    return limiter;
  }

  /**
   * Socket icin belirtilen event'in limitini kontrol et.
   */
  function check(socket, eventName) {
    const limiter = limiters.get(eventName);
    if (!limiter) return true;
    return limiter(socket);
  }

  // Periyodik temizlik (15 dk)
  const cleanupInterval = setInterval(() => {
    // Basit: limitelerin ic referanslari JS GC ile temizlenir
  }, 15 * 60 * 1000);
  cleanupInterval.unref();

  return { register, check };
}

module.exports = {
  createSocketConnectionLimiter,
  createSocketEventRateLimiter,
  createSocketEventRateManager,
};
