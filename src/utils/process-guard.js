/**
 * Process-level guards: uncaughtException, unhandledRejection, memory monitor, event loop monitor
 * Aninsohbeti - console.log/console.error adapte edilmis surum
 */

const MEMORY_WARNING_MB = 512;   // MB - uyari siniri
const MEMORY_CRITICAL_MB = 768;  // MB - kritik sinir (graceful restart oner)
const MEMORY_HARD_LIMIT_MB = 950; // MB - hard limit

let memoryWarningInterval = null;
let gracefulExitPending = false;

/**
 * Beklenmeyen istisnalari yakala ve logla.
 * Process'in crash olmasini engelle.
 */
function setupUncaughtExceptionHandler() {
  process.on('uncaughtException', (err, origin) => {
    console.error('[PROCESS-GUARD] YAKALANAMAYAN HATA (uncaughtException)', {
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 10).join('\n'),
      origin,
      pid: process.pid,
    });

    // Kritik hatalarda process'i oldur, supervisor yeniden baslatsin
    if (err.code === 'ERR_INVALID_ARG_TYPE' || err.code === 'ERR_ASSERTION') {
      console.error('[PROCESS-GUARD] Kritik hata - process sonlandiriliyor', { code: err.code });
      setTimeout(() => process.exit(1), 1000);
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROCESS-GUARD] YAKALANAMAYAN PROMISE HATASI (unhandledRejection)', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 10).join('\n') : null,
      pid: process.pid,
    });

    // Promise rejection'lari genelde logla, process'i oldurme
    // Cogu zaman kurtarilabilir hatalardir
  });

  process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning' || warning.name === 'ExperimentalWarning') {
      return; // Beklenen uyarilari gormezden gel
    }
    console.warn('[PROCESS-GUARD] Node.js uyarisi', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack?.split('\n').slice(0, 5).join('\n'),
    });
  });
}

/**
 * Bellek kullanimini periyodik olarak izle.
 * Kritik seviyede uyari verir.
 *
 * @param {number} intervalMs - Kontrol araligi (varsayilan: 60 sn)
 */
function startMemoryMonitor(intervalMs = 60000) {
  if (memoryWarningInterval) {
    clearInterval(memoryWarningInterval);
  }

  memoryWarningInterval = setInterval(() => {
    try {
      const usage = process.memoryUsage();
      const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
      const rssMB = Math.round(usage.rss / 1024 / 1024);
      const externalMB = Math.round(usage.external / 1024 / 1024);

      if (gracefulExitPending) return;

      if (heapUsedMB >= MEMORY_HARD_LIMIT_MB) {
        console.error('[PROCESS-GUARD] BELLEK SINIRI ASILDI - Graceful shutdown baslatiliyor', {
          heapUsedMB,
          heapTotalMB,
          rssMB,
          externalMB,
          limit: MEMORY_HARD_LIMIT_MB,
        });
        gracefulExitPending = true;
        // Beklenmeyen crash yerine kontrollu kapanis
        setTimeout(() => {
          console.error('[PROCESS-GUARD] Bellek limiti asimi nedeniyle process sonlandiriliyor');
          process.exit(1);
        }, 2000);
      } else if (heapUsedMB >= MEMORY_CRITICAL_MB) {
        console.warn('[PROCESS-GUARD] BELLEK KRITIK SEVIYE', {
          heapUsedMB,
          heapTotalMB,
          rssMB,
          externalMB,
          criticalAt: MEMORY_CRITICAL_MB,
          hardLimit: MEMORY_HARD_LIMIT_MB,
        });
      } else if (heapUsedMB >= MEMORY_WARNING_MB) {
        console.warn('[PROCESS-GUARD] Bellek kullanimi yuksek', {
          heapUsedMB,
          heapTotalMB,
          rssMB,
          externalMB,
        });
      }
    } catch (err) {
      console.error('[PROCESS-GUARD] Bellek monitor hatasi', { error: err.message });
    }
  }, intervalMs);

  memoryWarningInterval.unref();
}

/**
 * Periyodik event loop lag kontrolu.
 * Event loop'un ne kadar bloke oldugunu olcer.
 *
 * @param {number} intervalMs - Kontrol araligi (varsayilan: 5 sn)
 * @param {number} warnThresholdMs - Uyari esigi (varsayilan: 100 ms)
 */
function startEventLoopMonitor(intervalMs = 5000, warnThresholdMs = 100) {
  const check = () => {
    const start = Date.now();
    setImmediate(() => {
      const lag = Date.now() - start;
      if (lag > warnThresholdMs) {
        console.warn('[PROCESS-GUARD] Event loop lag detected', {
          lagMs: lag,
          thresholdMs: warnThresholdMs,
        });
      }
    });
  };

  const eventLoopInterval = setInterval(check, intervalMs);
  eventLoopInterval.unref();
}

function setupAllProcessGuards() {
  setupUncaughtExceptionHandler();
  startMemoryMonitor();
  startEventLoopMonitor();
}

module.exports = {
  setupUncaughtExceptionHandler,
  startMemoryMonitor,
  startEventLoopMonitor,
  setupAllProcessGuards,
  MEMORY_WARNING_MB,
  MEMORY_CRITICAL_MB,
  MEMORY_HARD_LIMIT_MB,
};
