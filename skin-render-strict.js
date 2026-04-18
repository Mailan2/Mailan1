(function() {
  const viewers = new Map();
  const textureCache = new Map();
  const loadingQueue = [];
  const inflight = new Set();
  let isLoading = false;

  // Пользовательский режим: загрузили один раз -> держим в памяти до перезагрузки страницы.
  const MAX_ACTIVE = Number.POSITIVE_INFINITY;
  const BATCH_SIZE = 2;
  const RETRY_LIMIT = 3;

  function resetCanvasState(canvas) {
    canvas._3dReady = false;
    canvas._queued = false;
    canvas._retryCount = canvas._retryCount || 0;
    canvas._everLoaded = canvas._everLoaded || false;
  }

  function disposeCanvasViewer(canvas) {
    const viewer = viewers.get(canvas);
    if (viewer) {
      try {
        viewer.dispose();
      } catch (e) {
        console.error('dispose error:', e);
      }
    }

    viewers.delete(canvas);
    resetCanvasState(canvas);
    canvas.style.opacity = '0';
  }

  function preloadTexture(url) {
    return new Promise((resolve, reject) => {
      if (textureCache.has(url)) {
        resolve(textureCache.get(url));
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        textureCache.set(url, img);
        resolve(img);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function create3D(canvas) {
    const skinUrl = canvas.dataset.skinUrl;
    if (!skinUrl) return;
    if (inflight.has(canvas)) return;

    const existing = viewers.get(canvas);
    if (existing && canvas._3dReady) {
      return;
    }

    inflight.add(canvas);

    try {
      await preloadTexture(skinUrl);

      if (viewers.size >= MAX_ACTIVE) {
        canvas._queued = false;
        return;
      }

      const viewer = new skinview3d.SkinViewer({
        canvas,
        width: 200,
        height: 280,
        skin: skinUrl
      });

      viewer.camera.position.set(0, 16, 35);
      viewer.camera.lookAt(0, 12, 0);
      viewer.autoRotate = false;

      if (viewer.controls) {
        viewer.controls.enableRotate = false;
        viewer.controls.enableZoom = false;
        viewer.controls.enablePan = false;
      }

      viewers.set(canvas, viewer);
      canvas._3dReady = true;
      canvas._queued = false;
      canvas._retryCount = 0;
      canvas._everLoaded = true;
      canvas.style.transition = 'opacity .25s ease';
      canvas.style.opacity = '1';

      viewer.render();
      requestAnimationFrame(() => viewer.render());

      console.log(`✅ 3D cache: ${viewers.size} - ${skinUrl.split('/').pop()}`);
    } catch (e) {
      canvas._retryCount = (canvas._retryCount || 0) + 1;
      canvas._queued = false;
      canvas._3dReady = false;

      if (canvas._retryCount <= RETRY_LIMIT) {
        const delay = 300 * canvas._retryCount;
        setTimeout(() => queueCanvas(canvas), delay);
      } else {
        console.error('❌ 3D failed after retries:', skinUrl, e);
      }
    } finally {
      inflight.delete(canvas);
    }
  }

  async function processQueue() {
    if (isLoading || loadingQueue.length === 0) return;
    isLoading = true;

    while (loadingQueue.length > 0) {
      const batch = loadingQueue.splice(0, BATCH_SIZE);
      await Promise.all(batch.map(create3D));
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    isLoading = false;
  }

  function queueCanvas(canvas) {
    if (canvas._queued || inflight.has(canvas)) return;

    if (viewers.has(canvas) && canvas._3dReady) return;

    canvas._queued = true;
    loadingQueue.push(canvas);
    processQueue();
  }

  function unqueueCanvas(canvas) {
    const index = loadingQueue.indexOf(canvas);
    if (index > -1) loadingQueue.splice(index, 1);
    canvas._queued = false;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const canvas = entry.target;
      if (entry.isIntersecting) {
        // Грузим один раз. После загрузки canvas остаётся в 3D-кэше (viewers).
        queueCanvas(canvas);
      } else {
        // Важный момент: больше НЕ dispose при скролле, чтобы не пропадал 3D.
        unqueueCanvas(canvas);
      }
    });
  }, {
    rootMargin: '500px',
    threshold: 0.01
  });

  function bindContextLoss(canvas) {
    if (canvas._contextLossBound) return;
    canvas._contextLossBound = true;

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      disposeCanvasViewer(canvas);
      queueCanvas(canvas);
    });
  }

  function setupCanvas(canvas) {
    if (canvas._observed) return;
    canvas._observed = true;
    canvas.style.opacity = canvas.style.opacity || '0';
    resetCanvasState(canvas);
    bindContextLoss(canvas);
    observer.observe(canvas);
  }

  function init() {
    const canvases = Array.from(document.querySelectorAll('.skin-canvas'));
    console.log(`🎮 Найдено ${canvases.length} скинов`);
    canvases.forEach(setupCanvas);

    const mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;

          const newCanvases = node.classList?.contains('skin-canvas')
            ? [node]
            : Array.from(node.querySelectorAll?.('.skin-canvas') || []);

          newCanvases.forEach(setupCanvas);
        });
      });
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeunload', () => {
    viewers.forEach((_, canvas) => disposeCanvasViewer(canvas));
    viewers.clear();

    textureCache.clear();
    loadingQueue.length = 0;
    inflight.clear();
  });

  window.addEventListener('resize', () => {
    viewers.forEach(viewer => {
      setTimeout(() => viewer.render(), 80);
    });
  });

  console.log('🚀 3D-рендер: режим "загрузил один раз и держу в кэше" активирован');
})();
