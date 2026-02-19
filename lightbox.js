/**
 * CSM DRIVE | NEXUS LIGHTBOX v1.0
 * Zero dependencies. Fully offline-capable. Futuristic design.
 *
 * Features:
 *  - Works with online URLs AND offline IDB base64 blobs
 *  - Mouse-wheel + pinch-to-zoom with pan
 *  - Touch swipe navigation (left/right)
 *  - Animated filmstrip with thumbnail preview
 *  - Metadata HUD (name, size, date, folder, cached status)
 *  - In-lightbox actions: star, download, trash, info toggle
 *  - Slideshow mode with neon progress ring
 *  - Keyboard: ArrowLeft/Right, Escape, Space (slideshow), F (fullscreen), Z (zoom reset)
 *  - Animated scanline + neon grid background
 *  - Video player with native controls
 *  - Drag-to-pan when zoomed in
 *  - Corner "NEXUS LB" HUD indicators
 */

const NexusLightbox = (() => {

    // ===== State =====
    let items       = [];     // { id, src, thumb, name, size, date, cat, starred, folder, offlineData }
    let currentIdx  = 0;
    let isOpen      = false;
    let zoom        = 1;
    let panX        = 0;
    let panY        = 0;
    let isDragging  = false;
    let dragStartX  = 0;
    let dragStartY  = 0;
    let panStartX   = 0;
    let panStartY   = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let lastTouchDist = 0;
    let slideshowTimer = null;
    let slideshowActive = false;
    let slideshowInterval = 4000;
    let slideshowProgress = 0;
    let slideshowAnimFrame = null;
    let infoVisible = false;
    let filmstripDragging = false;
    let filmDragStartX = 0;
    let filmScrollStart = 0;
    let externalCallbacks = {};
    let scanlineCanvas = null;
    let scanlineCtx   = null;
    let scanlineAnim  = null;

    // ===== DOM refs (created once) =====
    let overlay, stage, imgEl, videoEl, loader, errorEl;
    let btnPrev, btnNext, btnClose, btnFullscreen, btnSlideshow, btnInfo, btnStar, btnDownload, btnTrash, btnZoomReset;
    let counter, filmstrip, filmInner;
    let hudTL, hudTR, hudBL, metaPanel;
    let slideshowRing, slideshowRingSVG;
    let zoomHud;
    let gridCanvas;

    // ===== Build DOM =====
    function buildDOM() {
        if (document.getElementById('nlb-overlay')) return;

        const el = (tag, cls, html = '') => {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (html) e.innerHTML = html;
            return e;
        };

        overlay = el('div', 'nlb-overlay');
        overlay.id = 'nlb-overlay';

        // Animated neon grid background canvas
        gridCanvas = el('canvas', 'nlb-grid-canvas');
        overlay.appendChild(gridCanvas);

        // Scanline canvas
        scanlineCanvas = el('canvas', 'nlb-scanline');
        overlay.appendChild(scanlineCanvas);

        // Main stage (image/video holder)
        stage = el('div', 'nlb-stage');
        imgEl = el('img', 'nlb-media');
        imgEl.draggable = false;
        videoEl = el('video', 'nlb-media nlb-video');
        videoEl.controls = true;
        videoEl.playsInline = true;
        loader = el('div', 'nlb-loader',
            `<div class="nlb-spin-ring"></div><div class="nlb-load-text">LOADING</div>`);
        errorEl = el('div', 'nlb-error',
            `<div class="nlb-error-icon">⚠</div><div>File unavailable offline</div>`);
        stage.append(imgEl, videoEl, loader, errorEl);
        overlay.appendChild(stage);

        // Corner HUD elements
        hudTL = el('div', 'nlb-hud nlb-hud-tl',
            `<span class="nlb-hud-label">NEXUS</span><span class="nlb-hud-sub" id="nlb-online-status">● ONLINE</span>`);
        hudTR = el('div', 'nlb-hud nlb-hud-tr');
        // Zoom indicator inside TR
        zoomHud = el('div', 'nlb-zoom-hud', '1.0×');
        hudTR.appendChild(zoomHud);

        hudBL = el('div', 'nlb-hud nlb-hud-bl');

        overlay.append(hudTL, hudTR, hudBL);

        // Slideshow ring (SVG in TR alongside counter)
        slideshowRing = el('div', 'nlb-ss-ring-wrap hidden');
        slideshowRingSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        slideshowRingSVG.setAttribute('viewBox', '0 0 36 36');
        slideshowRingSVG.innerHTML = `
            <circle class="nlb-ring-bg" cx="18" cy="18" r="15.9" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="2.5"/>
            <circle class="nlb-ring-fg" cx="18" cy="18" r="15.9" fill="none" stroke="var(--neon)" stroke-width="2.5"
                stroke-dasharray="100 100" stroke-dashoffset="100" stroke-linecap="round"
                transform="rotate(-90 18 18)"/>`;
        slideshowRing.appendChild(slideshowRingSVG);
        hudTR.appendChild(slideshowRing);

        // Top bar: counter + action buttons
        const topBar = el('div', 'nlb-topbar');
        counter = el('div', 'nlb-counter', '1 / 1');
        btnClose      = el('button', 'nlb-btn nlb-btn-close',    `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>`);
        btnFullscreen = el('button', 'nlb-btn nlb-btn-fs',       `<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`);
        btnSlideshow  = el('button', 'nlb-btn nlb-btn-ss',        `<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`);
        btnInfo       = el('button', 'nlb-btn nlb-btn-info',     `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`);
        topBar.append(counter, btnSlideshow, btnFullscreen, btnInfo, btnClose);
        overlay.appendChild(topBar);

        // Left/Right nav arrows
        btnPrev = el('button', 'nlb-nav nlb-nav-prev',
            `<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>`);
        btnNext = el('button', 'nlb-nav nlb-nav-next',
            `<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>`);
        overlay.append(btnPrev, btnNext);

        // Bottom action bar: star, download, trash, zoom-reset
        const actionBar = el('div', 'nlb-actionbar');
        btnStar     = el('button', 'nlb-action-btn nlb-btn-star',     `<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg><span>Star</span>`);
        btnDownload = el('button', 'nlb-action-btn nlb-btn-dl',       `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Download</span>`);
        btnTrash    = el('button', 'nlb-action-btn nlb-btn-trash',    `<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg><span>Trash</span>`);
        btnZoomReset= el('button', 'nlb-action-btn nlb-btn-zoom',     `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg><span>Zoom</span>`);
        actionBar.append(btnZoomReset, btnStar, btnDownload, btnTrash);
        overlay.appendChild(actionBar);

        // Metadata panel (slide-up on info toggle)
        metaPanel = el('div', 'nlb-meta-panel');
        overlay.appendChild(metaPanel);

        // Filmstrip
        const filmWrap = el('div', 'nlb-filmstrip-wrap');
        filmstrip = el('div', 'nlb-filmstrip');
        filmInner = el('div', 'nlb-film-inner');
        filmstrip.appendChild(filmInner);
        filmWrap.appendChild(filmstrip);
        overlay.appendChild(filmWrap);

        document.body.appendChild(overlay);
        bindEvents();
        startGridAnimation();
        startScanlineAnimation();
    }

    // ===== Neon Grid BG =====
    function startGridAnimation() {
        const c = gridCanvas;
        let frame = 0;
        function draw() {
            if (!isOpen) { scanlineAnim = requestAnimationFrame(draw); return; }
            c.width = window.innerWidth;
            c.height = window.innerHeight;
            const ctx = c.getContext('2d');
            ctx.clearRect(0, 0, c.width, c.height);
            const spacing = 60;
            const fade = 0.025 + Math.sin(frame * 0.01) * 0.008;
            ctx.strokeStyle = `rgba(0,255,204,${fade})`;
            ctx.lineWidth = 0.5;
            for (let x = 0; x < c.width; x += spacing) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke();
            }
            for (let y = 0; y < c.height; y += spacing) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
            }
            // Moving horizontal glow band
            const bandY = (frame * 1.5) % c.height;
            const grd = ctx.createLinearGradient(0, bandY - 40, 0, bandY + 40);
            grd.addColorStop(0, 'transparent');
            grd.addColorStop(0.5, `rgba(0,255,204,0.04)`);
            grd.addColorStop(1, 'transparent');
            ctx.fillStyle = grd;
            ctx.fillRect(0, bandY - 40, c.width, 80);
            frame++;
            requestAnimationFrame(draw);
        }
        requestAnimationFrame(draw);
    }

    // ===== Scanline =====
    function startScanlineAnimation() {
        function draw() {
            if (!isOpen) { requestAnimationFrame(draw); return; }
            const c = scanlineCanvas;
            c.width = window.innerWidth;
            c.height = window.innerHeight;
            const ctx = c.getContext('2d');
            ctx.clearRect(0, 0, c.width, c.height);
            for (let y = 0; y < c.height; y += 3) {
                ctx.fillStyle = 'rgba(0,0,0,0.08)';
                ctx.fillRect(0, y, c.width, 1);
            }
            requestAnimationFrame(draw);
        }
        requestAnimationFrame(draw);
    }

    // ===== Bind Events =====
    function bindEvents() {
        btnClose.addEventListener('click', close);
        btnPrev.addEventListener('click', () => navigate(-1));
        btnNext.addEventListener('click', () => navigate(1));
        btnFullscreen.addEventListener('click', toggleFullscreen);
        btnSlideshow.addEventListener('click', toggleSlideshow);
        btnInfo.addEventListener('click', toggleInfo);
        btnStar.addEventListener('click', () => {
            const item = items[currentIdx];
            if (item && externalCallbacks.onStar) externalCallbacks.onStar(item.id, !!item.starred);
        });
        btnDownload.addEventListener('click', () => {
            const item = items[currentIdx];
            if (!item) return;
            const a = document.createElement('a');
            a.href = item.offlineData || item.src;
            a.download = item.name || 'file';
            a.target = '_blank';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        });
        btnTrash.addEventListener('click', () => {
            const item = items[currentIdx];
            if (item && externalCallbacks.onTrash) externalCallbacks.onTrash(item.id);
        });
        btnZoomReset.addEventListener('click', resetZoom);

        // Click backdrop to close
        overlay.addEventListener('click', e => {
            if (e.target === overlay || e.target === gridCanvas || e.target === scanlineCanvas) close();
        });

        // Mouse wheel zoom
        stage.addEventListener('wheel', onWheel, { passive: false });

        // Mouse drag (pan when zoomed)
        stage.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        // Touch gestures
        stage.addEventListener('touchstart', onTouchStart, { passive: true });
        stage.addEventListener('touchmove', onTouchMove, { passive: false });
        stage.addEventListener('touchend', onTouchEnd);

        // Keyboard
        document.addEventListener('keydown', onKeyDown);

        // Filmstrip drag
        filmstrip.addEventListener('mousedown', onFilmDragStart);
        filmstrip.addEventListener('touchstart', onFilmTouchStart, { passive: true });

        // Double-click to zoom
        stage.addEventListener('dblclick', e => {
            if (zoom > 1) resetZoom();
            else {
                zoom = 2.5;
                applyTransform(true);
            }
        });
    }

    // ===== Open =====
    function open(fileItems, startIndex = 0, callbacks = {}) {
        buildDOM();
        items = fileItems;
        currentIdx = startIndex;
        externalCallbacks = callbacks;
        isOpen = true;
        infoVisible = false;
        metaPanel.classList.remove('nlb-visible');

        // Online status
        document.getElementById('nlb-online-status').textContent = navigator.onLine ? '● ONLINE' : '○ OFFLINE';
        document.getElementById('nlb-online-status').style.color = navigator.onLine ? 'var(--success)' : 'var(--warning)';

        overlay.classList.add('nlb-open');
        document.body.style.overflow = 'hidden';

        resetZoom();
        buildFilmstrip();
        loadCurrent();
    }

    // ===== Close =====
    function close() {
        if (!isOpen) return;
        isOpen = false;
        stopSlideshow();
        overlay.classList.remove('nlb-open');
        document.body.style.overflow = '';
        imgEl.src = '';
        videoEl.pause();
        videoEl.src = '';
        metaPanel.classList.remove('nlb-visible');
        infoVisible = false;
    }

    // ===== Navigate =====
    function navigate(dir) {
        const next = currentIdx + dir;
        if (next < 0 || next >= items.length) return;
        currentIdx = next;
        resetZoom();
        loadCurrent();
        scrollFilmstripTo(currentIdx);
        resetSlideshowProgress();
    }

    // ===== Load Current =====
    function loadCurrent() {
        const item = items[currentIdx];
        if (!item) return;

        // Counter
        counter.textContent = `${currentIdx + 1} / ${items.length}`;

        // Nav visibility
        btnPrev.style.opacity = currentIdx > 0 ? '1' : '0.2';
        btnNext.style.opacity = currentIdx < items.length - 1 ? '1' : '0.2';
        btnPrev.style.pointerEvents = currentIdx > 0 ? 'auto' : 'none';
        btnNext.style.pointerEvents = currentIdx < items.length - 1 ? 'auto' : 'none';

        // Star button state
        btnStar.classList.toggle('nlb-starred', !!item.starred);
        btnStar.querySelector('span').textContent = item.starred ? 'Unstar' : 'Star';

        // Filmstrip active
        filmInner.querySelectorAll('.nlb-film-item').forEach((el, i) => {
            el.classList.toggle('nlb-film-active', i === currentIdx);
        });

        // Update meta panel if open
        if (infoVisible) renderMeta(item);

        // HUD BL: filename
        hudBL.innerHTML = `<span class="nlb-filename-hud">${item.name || 'Untitled'}</span>`;

        const isVid = item.cat === 'video';
        const src = item.offlineData || item.src;

        showLoader();
        hideError();

        if (isVid) {
            imgEl.classList.remove('nlb-active');
            videoEl.classList.add('nlb-active');
            videoEl.src = src;
            videoEl.load();
            videoEl.onloadeddata = hideLoader;
            videoEl.onerror = () => { hideLoader(); showError(); };
            // Disable zoom for video
            stage.style.cursor = 'default';
        } else {
            videoEl.classList.remove('nlb-active');
            videoEl.pause();
            videoEl.src = '';
            imgEl.classList.add('nlb-active');
            imgEl.onload = () => { hideLoader(); applyTransform(); };
            imgEl.onerror = () => {
                hideLoader();
                // If online URL failed and we have offlineData try that
                if (item.src && !item.offlineData) showError();
                else if (item.offlineData && imgEl.src !== item.offlineData) {
                    imgEl.src = item.offlineData;
                } else showError();
            };
            imgEl.src = src;
            stage.style.cursor = zoom > 1 ? 'grab' : 'zoom-in';
        }

        // Add slide-in animation
        const mediaEl = isVid ? videoEl : imgEl;
        mediaEl.classList.remove('nlb-slide-in');
        void mediaEl.offsetWidth;
        mediaEl.classList.add('nlb-slide-in');
    }

    // ===== Loader / Error =====
    function showLoader() { loader.classList.add('nlb-visible'); }
    function hideLoader() { loader.classList.remove('nlb-visible'); }
    function showError() { errorEl.classList.add('nlb-visible'); }
    function hideError() { errorEl.classList.remove('nlb-visible'); }

    // ===== Zoom & Pan =====
    function applyTransform(animate = false) {
        const t = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        imgEl.style.transition = animate ? 'transform 0.3s cubic-bezier(0.22,1,0.36,1)' : 'none';
        imgEl.style.transform = t;
        zoomHud.textContent = `${zoom.toFixed(1)}×`;
        stage.style.cursor = zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in';
    }

    function resetZoom(animate = true) {
        zoom = 1; panX = 0; panY = 0;
        applyTransform(animate);
    }

    function clampPan() {
        const maxX = (imgEl.clientWidth * (zoom - 1)) / 2;
        const maxY = (imgEl.clientHeight * (zoom - 1)) / 2;
        panX = Math.max(-maxX, Math.min(maxX, panX));
        panY = Math.max(-maxY, Math.min(maxY, panY));
    }

    function onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        zoom = Math.max(1, Math.min(6, zoom + delta));
        if (zoom === 1) { panX = 0; panY = 0; }
        else clampPan();
        applyTransform();
    }

    function onMouseDown(e) {
        if (zoom <= 1 || e.target === videoEl) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panStartX = panX;
        panStartY = panY;
        stage.style.cursor = 'grabbing';
        e.preventDefault();
    }
    function onMouseMove(e) {
        if (!isDragging) return;
        panX = panStartX + (e.clientX - dragStartX);
        panY = panStartY + (e.clientY - dragStartY);
        clampPan();
        applyTransform();
    }
    function onMouseUp() {
        isDragging = false;
        if (zoom > 1) stage.style.cursor = 'grab';
    }

    // ===== Touch =====
    function onTouchStart(e) {
        if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            if (zoom > 1) {
                isDragging = true;
                dragStartX = touchStartX;
                dragStartY = touchStartY;
                panStartX = panX;
                panStartY = panY;
            }
        } else if (e.touches.length === 2) {
            lastTouchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
        }
    }
    function onTouchMove(e) {
        if (e.touches.length === 2) {
            e.preventDefault();
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const scaleDelta = (dist - lastTouchDist) * 0.01;
            zoom = Math.max(1, Math.min(6, zoom + scaleDelta));
            lastTouchDist = dist;
            if (zoom === 1) { panX = 0; panY = 0; }
            clampPan();
            applyTransform();
        } else if (e.touches.length === 1 && isDragging) {
            panX = panStartX + (e.touches[0].clientX - dragStartX);
            panY = panStartY + (e.touches[0].clientY - dragStartY);
            clampPan();
            applyTransform();
        }
    }
    function onTouchEnd(e) {
        if (isDragging) { isDragging = false; return; }
        const dx = (e.changedTouches[0]?.clientX || 0) - touchStartX;
        const dy = (e.changedTouches[0]?.clientY || 0) - touchStartY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && zoom === 1) {
            navigate(dx < 0 ? 1 : -1);
        }
    }

    // ===== Keyboard =====
    function onKeyDown(e) {
        if (!isOpen) return;
        switch (e.key) {
            case 'ArrowLeft':  navigate(-1); break;
            case 'ArrowRight': navigate(1);  break;
            case 'Escape':     close();      break;
            case ' ':          toggleSlideshow(); e.preventDefault(); break;
            case 'f': case 'F': toggleFullscreen(); break;
            case 'z': case 'Z': resetZoom(); break;
            case 'i': case 'I': toggleInfo(); break;
            case 's': case 'S': {
                const item = items[currentIdx];
                if (item && externalCallbacks.onStar) externalCallbacks.onStar(item.id, !!item.starred);
                break;
            }
        }
    }

    // ===== Fullscreen =====
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            overlay.requestFullscreen?.() || overlay.webkitRequestFullscreen?.();
            btnFullscreen.classList.add('nlb-active');
        } else {
            document.exitFullscreen?.() || document.webkitExitFullscreen?.();
            btnFullscreen.classList.remove('nlb-active');
        }
    }

    // ===== Slideshow =====
    function toggleSlideshow() {
        slideshowActive = !slideshowActive;
        if (slideshowActive) {
            btnSlideshow.classList.add('nlb-active');
            btnSlideshow.innerHTML = `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
            slideshowRing.classList.remove('hidden');
            runSlideshow();
        } else {
            stopSlideshow();
        }
    }

    function stopSlideshow() {
        slideshowActive = false;
        clearTimeout(slideshowTimer);
        if (slideshowAnimFrame) cancelAnimationFrame(slideshowAnimFrame);
        btnSlideshow.classList.remove('nlb-active');
        btnSlideshow.innerHTML = `<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
        slideshowRing.classList.add('hidden');
        resetSlideshowProgress();
    }

    function resetSlideshowProgress() {
        slideshowProgress = 0;
        updateRing(0);
        if (slideshowAnimFrame) cancelAnimationFrame(slideshowAnimFrame);
        if (slideshowActive) runSlideshow();
    }

    function runSlideshow() {
        if (!slideshowActive) return;
        const startTime = performance.now();
        function tick(now) {
            if (!slideshowActive) return;
            const elapsed = now - startTime;
            const pct = Math.min(elapsed / slideshowInterval, 1);
            updateRing(pct * 100);
            if (pct < 1) {
                slideshowAnimFrame = requestAnimationFrame(tick);
            } else {
                if (currentIdx < items.length - 1) navigate(1);
                else { stopSlideshow(); return; }
                resetSlideshowProgress();
            }
        }
        slideshowAnimFrame = requestAnimationFrame(tick);
    }

    function updateRing(pct) {
        const circle = slideshowRingSVG.querySelector('.nlb-ring-fg');
        if (circle) circle.setAttribute('stroke-dashoffset', 100 - pct);
    }

    // ===== Info Panel =====
    function toggleInfo() {
        infoVisible = !infoVisible;
        metaPanel.classList.toggle('nlb-visible', infoVisible);
        btnInfo.classList.toggle('nlb-active', infoVisible);
        if (infoVisible) renderMeta(items[currentIdx]);
    }

    function renderMeta(item) {
        if (!item) return;
        const cached = item.offlineData ? '✅ Cached offline' : '⚡ Online only';
        const dateStr = item.date || '—';
        const folderStr = item.folder || 'No folder';
        metaPanel.innerHTML = `
            <div class="nlb-meta-grid">
                <div class="nlb-meta-row"><span class="nlb-meta-key">NAME</span><span class="nlb-meta-val">${item.name || 'Untitled'}</span></div>
                <div class="nlb-meta-row"><span class="nlb-meta-key">TYPE</span><span class="nlb-meta-val">${item.cat === 'video' ? '⬛ VIDEO' : '🖼 IMAGE'}</span></div>
                <div class="nlb-meta-row"><span class="nlb-meta-key">SIZE</span><span class="nlb-meta-val">${item.size || '—'}</span></div>
                <div class="nlb-meta-row"><span class="nlb-meta-key">DATE</span><span class="nlb-meta-val">${dateStr}</span></div>
                <div class="nlb-meta-row"><span class="nlb-meta-key">FOLDER</span><span class="nlb-meta-val">${folderStr}</span></div>
                <div class="nlb-meta-row"><span class="nlb-meta-key">CACHE</span><span class="nlb-meta-val">${cached}</span></div>
                <div class="nlb-meta-row"><span class="nlb-meta-key">STARRED</span><span class="nlb-meta-val">${item.starred ? '⭐ Yes' : '—'}</span></div>
                <div class="nlb-meta-row"><span class="nlb-meta-key">INDEX</span><span class="nlb-meta-val">${currentIdx + 1} / ${items.length}</span></div>
            </div>`;
    }

    // ===== Filmstrip =====
    function buildFilmstrip() {
        filmInner.innerHTML = '';
        items.forEach((item, i) => {
            const thumb = document.createElement('div');
            thumb.className = `nlb-film-item${i === currentIdx ? ' nlb-film-active' : ''}`;
            thumb.setAttribute('data-idx', i);

            const thumbSrc = item.offlineData || item.thumb || item.src;
            if (item.cat === 'video') {
                thumb.innerHTML = `<div class="nlb-film-vid-icon">▶</div>`;
                thumb.style.background = 'rgba(168,85,247,0.15)';
            } else {
                const img = document.createElement('img');
                img.src = thumbSrc;
                img.draggable = false;
                img.onerror = () => { thumb.style.background = 'rgba(0,255,204,0.06)'; };
                thumb.appendChild(img);
            }

            // Index badge
            const badge = document.createElement('div');
            badge.className = 'nlb-film-badge';
            badge.textContent = i + 1;
            thumb.appendChild(badge);

            thumb.addEventListener('click', () => {
                currentIdx = i;
                resetZoom();
                loadCurrent();
                scrollFilmstripTo(i);
                resetSlideshowProgress();
            });
            filmInner.appendChild(thumb);
        });
        scrollFilmstripTo(currentIdx);
        bindFilmstripDrag();
    }

    function scrollFilmstripTo(idx) {
        const item = filmInner.children[idx];
        if (!item) return;
        const itemLeft = item.offsetLeft;
        const itemWidth = item.offsetWidth;
        const stripWidth = filmstrip.offsetWidth;
        filmstrip.scrollTo({ left: itemLeft - stripWidth / 2 + itemWidth / 2, behavior: 'smooth' });
    }

    function onFilmDragStart(e) {
        filmstripDragging = true;
        filmDragStartX = e.clientX;
        filmScrollStart = filmstrip.scrollLeft;
        filmstrip.style.cursor = 'grabbing';
        e.preventDefault();
        const onMove = ev => {
            if (!filmstripDragging) return;
            filmstrip.scrollLeft = filmScrollStart - (ev.clientX - filmDragStartX);
        };
        const onUp = () => {
            filmstripDragging = false;
            filmstrip.style.cursor = 'grab';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }
    function onFilmTouchStart(e) {
        filmDragStartX = e.touches[0].clientX;
        filmScrollStart = filmstrip.scrollLeft;
    }
    function bindFilmstripDrag() {
        filmstrip.style.cursor = 'grab';
        filmstrip.addEventListener('mousedown', onFilmDragStart);
        filmstrip.addEventListener('touchmove', ev => {
            filmstrip.scrollLeft = filmScrollStart - (ev.touches[0].clientX - filmDragStartX);
        }, { passive: true });
    }

    // ===== Public API =====
    return {
        open,
        close,
        navigate,
        updateItem(id, changes) {
            const item = items.find(i => i.id === id);
            if (item) Object.assign(item, changes);
            if (items[currentIdx]?.id === id) {
                btnStar.classList.toggle('nlb-starred', !!items[currentIdx].starred);
                btnStar.querySelector('span').textContent = items[currentIdx].starred ? 'Unstar' : 'Star';
                if (infoVisible) renderMeta(items[currentIdx]);
            }
            // Refresh filmstrip star state
            filmInner.querySelectorAll('.nlb-film-item').forEach((el, i) => {
                el.classList.toggle('nlb-film-starred', !!items[i]?.starred);
            });
        }
    };
})();

window.NexusLightbox = NexusLightbox;
