/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         NEXUS LIGHTBOX v3.0 — CSM DRIVE ULTRA PRO              ║
 * ║         Developer: Csm Mohasin Alam                             ║
 * ║         Zero CDN deps · Offline-first · Focal-point zoom        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ZOOM FIX v3:
 *   - Image sits inside a "viewport" div that clips overflow.
 *   - transform is applied to the image directly (translate then scale).
 *   - clampPan reads elImg.getBoundingClientRect() AFTER setting scale
 *     so it uses the true on-screen pixel size.
 *   - All pan limits derived from real rendered dimensions — no guessing.
 */

const NexusLightbox = (() => {
    /* ─── State ─────────────────────────────────────────────────── */
    let items      = [];
    let currentIdx = 0;
    let isOpen     = false;
    let prevIdx    = -1;

    // Zoom/pan
    let scale         = 1;
    let panX          = 0;
    let panY          = 0;
    const MIN_SCALE   = 1;
    const MAX_SCALE   = 8;

    // Drag
    let isDragging = false;
    let dragSX = 0, dragSY = 0;
    let panSX  = 0, panSY  = 0;

    // Touch
    let swipeStartX = 0, swipeStartY = 0;
    let swipeMoved  = false;
    let isPinching  = false;
    let pinchDist0  = 0;
    let pinchScale0 = 1;
    let pinchMidX   = 0, pinchMidY = 0;

    // Slideshow
    let ssActive = false;
    let ssRAF    = null;
    let ssT0     = 0;
    const SS_DUR = 5000;

    // Info panel
    let infoOpen = false;

    // Callbacks
    let cb = {};

    /* ─── DOM refs ──────────────────────────────────────────────── */
    let elOv, elStage, elVp, elImg, elVideo, elLoader, elErr;
    let elPrev, elNext, elClose, elFS, elSS, elInfo;
    let elCnt, elZBadge, elDot;
    let elFilmScroll, elFilmInner;
    let elMeta, elActions;
    let elStar, elDl, elTrash, elZReset;
    let elSSRing;
    let elGridC, elScanC;
    let builtDom = false;

    /* ─── Build DOM ─────────────────────────────────────────────── */
    function buildDOM() {
        if (builtDom) return;
        builtDom = true;

        const mk = (tag, cls = '', html = '') => {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (html) e.innerHTML = html;
            return e;
        };
        const S = (d, vb = '0 0 24 24') =>
            `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

        // Overlay
        elOv = mk('div', 'nlb-ov');
        elOv.id = 'nlb-ov';

        // BG canvases
        elGridC = mk('canvas', 'nlb-gc');
        elScanC = mk('canvas', 'nlb-sc');
        elOv.append(elGridC, elScanC);

        // Stage: full screen, centers content
        elStage = mk('div', 'nlb-stage');

        // Viewport: clips the image when zoomed, constrained size
        elVp = mk('div', 'nlb-vp');

        // Image — transform applied here
        elImg = mk('img', 'nlb-img');
        elImg.draggable = false;

        // Video
        elVideo = mk('video', 'nlb-vid');
        elVideo.controls = true;
        elVideo.playsInline = true;

        // Loader + error
        elLoader = mk('div', 'nlb-load', `<div class="nlb-spin"></div><span>LOADING</span>`);
        elErr    = mk('div', 'nlb-err',  `<div class="nlb-err-i">⚠</div><span>Unavailable offline</span>`);

        elVp.append(elImg, elVideo);
        elStage.append(elVp, elLoader, elErr);
        elOv.appendChild(elStage);

        // Top bar
        const top = mk('div', 'nlb-top');
        elCnt    = mk('div', 'nlb-cnt', '1 / 1');
        elDot    = mk('div', 'nlb-dot', '● LIVE');
        elZBadge = mk('div', 'nlb-zb',  '1.0×');

        // Slideshow ring SVG
        const ssWrap = mk('div', 'nlb-ssw');
        ssWrap.innerHTML = `<svg viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="2.5"/>
            <circle id="nlb-rg" cx="18" cy="18" r="15" fill="none" stroke="var(--neon,#00ffcc)" stroke-width="2.5"
                stroke-dasharray="94.25 94.25" stroke-dashoffset="94.25" stroke-linecap="round"
                transform="rotate(-90 18 18)"/>
        </svg>`;
        elSSRing = ssWrap.querySelector('#nlb-rg');

        elClose = mk('button', 'nlb-btn nlb-xbtn',
            S(`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`));
        elFS = mk('button', 'nlb-btn',
            S(`<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>`));
        elSS = mk('button', 'nlb-btn nlb-ssb', svgPlay());
        elInfo = mk('button', 'nlb-btn',
            S(`<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>`));

        top.append(elCnt, elDot, elZBadge, ssWrap, elSS, elFS, elInfo, elClose);
        elOv.appendChild(top);

        // Nav
        elPrev = mk('button', 'nlb-nav nlb-prv',
            S(`<polyline points="15 18 9 12 15 6"/>`));
        elNext = mk('button', 'nlb-nav nlb-nxt',
            S(`<polyline points="9 18 15 12 9 6"/>`));
        elOv.append(elPrev, elNext);

        // Action bar
        elActions = mk('div', 'nlb-ab');
        elZReset  = mk('button', 'nlb-ac',
            S(`<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
               <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>`) + `<span>Zoom</span>`);
        elStar    = mk('button', 'nlb-ac nlb-astar',
            S(`<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`) + `<span>Star</span>`);
        elDl      = mk('button', 'nlb-ac nlb-adl',
            S(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
               <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`) + `<span>Save</span>`);
        elTrash   = mk('button', 'nlb-ac nlb-atr',
            S(`<polyline points="3 6 5 6 21 6"/>
               <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
               <path d="M10 11v6M14 11v6M9 6V4h6v2"/>`) + `<span>Trash</span>`);
        elActions.append(elZReset, elStar, elDl, elTrash);
        elOv.appendChild(elActions);

        // Meta panel
        elMeta = mk('div', 'nlb-meta');
        elOv.appendChild(elMeta);

        // Filmstrip
        const fw = mk('div', 'nlb-fw');
        elFilmScroll = mk('div', 'nlb-fs');
        elFilmInner  = mk('div', 'nlb-fi');
        elFilmScroll.appendChild(elFilmInner);
        fw.appendChild(elFilmScroll);
        elOv.appendChild(fw);

        // Developer credit
        const dev = mk('div', 'nlb-dev', '⬡ CSM DRIVE ULTRA PRO &nbsp;·&nbsp; Csm Mohasin Alam');
        elOv.appendChild(dev);

        document.body.appendChild(elOv);
        bindEvents();
        startBG();
    }

    /* ─── Background animation ──────────────────────────────────── */
    function startBG() {
        let f = 0;
        const drawGrid = () => {
            requestAnimationFrame(drawGrid);
            if (!isOpen) return;
            const W = elGridC.width  = window.innerWidth;
            const H = elGridC.height = window.innerHeight;
            const ctx = elGridC.getContext('2d');
            ctx.clearRect(0, 0, W, H);
            const sp = 65;
            const a = 0.016 + Math.sin(f * 0.009) * 0.006;
            ctx.strokeStyle = `rgba(0,255,204,${a})`;
            ctx.lineWidth = 0.5;
            for (let x = 0; x <= W; x += sp) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
            for (let y = 0; y <= H; y += sp) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
            const by = (f * 1.1) % H;
            const g = ctx.createLinearGradient(0, by - 60, 0, by + 60);
            g.addColorStop(0, 'transparent');
            g.addColorStop(0.5, 'rgba(0,255,204,0.03)');
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.fillRect(0, by - 60, W, 120);
            f++;
        };
        const drawScan = () => {
            requestAnimationFrame(drawScan);
            if (!isOpen) return;
            const W = elScanC.width  = window.innerWidth;
            const H = elScanC.height = window.innerHeight;
            const ctx = elScanC.getContext('2d');
            ctx.clearRect(0, 0, W, H);
            for (let y = 0; y < H; y += 3) {
                ctx.fillStyle = 'rgba(0,0,0,0.065)';
                ctx.fillRect(0, y, W, 1);
            }
        };
        requestAnimationFrame(drawGrid);
        requestAnimationFrame(drawScan);
    }

    /* ─── Events ────────────────────────────────────────────────── */
    function bindEvents() {
        elClose.onclick = close;
        elPrev.onclick  = () => navigate(-1);
        elNext.onclick  = () => navigate(1);
        elFS.onclick    = toggleFS;
        elSS.onclick    = toggleSS;
        elInfo.onclick  = toggleInfo;
        elZReset.onclick = () => { setZoom(1, 0, 0, true); };
        elStar.onclick   = onStar;
        elDl.onclick     = onDl;
        elTrash.onclick  = onTrash;

        // Backdrop close
        elOv.addEventListener('click', e => {
            if (e.target === elOv || e.target === elGridC || e.target === elScanC) close();
        });

        // ── WHEEL ZOOM with focal point ───────────────────────────
        elStage.addEventListener('wheel', e => {
            e.preventDefault();
            if (items[currentIdx]?.cat === 'video') return;

            const rect = elVp.getBoundingClientRect();
            const cx = rect.left + rect.width  / 2;
            const cy = rect.top  + rect.height / 2;
            // cursor offset from viewport center
            const mx = e.clientX - cx;
            const my = e.clientY - cy;

            const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
            const ns = clampScale(scale * factor);
            if (ns === scale) return;

            // Keep the point under cursor stationary:
            // new_pan = cursor - (cursor - old_pan) * (new_scale / old_scale)
            panX = mx - (mx - panX) * (ns / scale);
            panY = my - (my - panY) * (ns / scale);
            scale = ns;
            clampPan();
            applyTx(false);
        }, { passive: false });

        // ── MOUSE DRAG ────────────────────────────────────────────
        elVp.addEventListener('mousedown', e => {
            if (scale <= 1 || e.target === elVideo || e.button !== 0) return;
            isDragging = true;
            dragSX = e.clientX; dragSY = e.clientY;
            panSX  = panX;      panSY  = panY;
            elImg.style.transition = 'none';
            e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!isDragging) return;
            panX = panSX + (e.clientX - dragSX);
            panY = panSY + (e.clientY - dragSY);
            clampPan();
            applyTx(false);
        });
        window.addEventListener('mouseup', () => { isDragging = false; });

        // ── DOUBLE-CLICK to toggle 2.5× ──────────────────────────
        elVp.addEventListener('dblclick', e => {
            if (items[currentIdx]?.cat === 'video') return;
            if (scale > 1.05) {
                setZoom(1, 0, 0, true);
            } else {
                const rect = elVp.getBoundingClientRect();
                const mx = e.clientX - (rect.left + rect.width  / 2);
                const my = e.clientY - (rect.top  + rect.height / 2);
                const ns = 2.5;
                panX = mx - (mx - 0) * (ns / 1);
                panY = my - (my - 0) * (ns / 1);
                scale = ns;
                clampPan();
                applyTx(true);
            }
        });

        // ── TOUCH ─────────────────────────────────────────────────
        elVp.addEventListener('touchstart', e => {
            swipeMoved = false;
            if (e.touches.length === 2) {
                isPinching   = true;
                pinchDist0   = getTDist(e);
                pinchScale0  = scale;
                const rect   = elVp.getBoundingClientRect();
                const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                pinchMidX = mx - (rect.left + rect.width  / 2);
                pinchMidY = my - (rect.top  + rect.height / 2);
            } else if (e.touches.length === 1) {
                swipeStartX = e.touches[0].clientX;
                swipeStartY = e.touches[0].clientY;
                if (scale > 1.05) {
                    isDragging = true;
                    dragSX = swipeStartX; dragSY = swipeStartY;
                    panSX  = panX;        panSY  = panY;
                }
            }
        }, { passive: true });

        elVp.addEventListener('touchmove', e => {
            swipeMoved = true;
            if (isPinching && e.touches.length === 2) {
                e.preventDefault();
                const d  = getTDist(e);
                const ns = clampScale(pinchScale0 * (d / pinchDist0));
                panX = pinchMidX - (pinchMidX - panX) * (ns / scale);
                panY = pinchMidY - (pinchMidY - panY) * (ns / scale);
                scale = ns;
                clampPan();
                applyTx(false);
            } else if (isDragging && e.touches.length === 1) {
                panX = panSX + (e.touches[0].clientX - dragSX);
                panY = panSY + (e.touches[0].clientY - dragSY);
                clampPan();
                applyTx(false);
            }
        }, { passive: false });

        elVp.addEventListener('touchend', e => {
            isPinching = false;
            isDragging = false;
            if (!swipeMoved && e.changedTouches.length) return; // tap, ignore
            if (scale <= 1.05) {
                const dx = (e.changedTouches[0]?.clientX || 0) - swipeStartX;
                const dy = (e.changedTouches[0]?.clientY || 0) - swipeStartY;
                if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
                    navigate(dx < 0 ? 1 : -1);
                }
            }
        }, { passive: true });

        // ── KEYBOARD ──────────────────────────────────────────────
        document.addEventListener('keydown', e => {
            if (!isOpen) return;
            switch (e.key) {
                case 'ArrowLeft':  navigate(-1); break;
                case 'ArrowRight': navigate(1);  break;
                case 'Escape':     close();       break;
                case ' ':  e.preventDefault(); toggleSS(); break;
                case 'f': case 'F': toggleFS(); break;
                case 'z': case 'Z': setZoom(1,0,0,true); break;
                case 'i': case 'I': toggleInfo(); break;
                case '+': case '=': zStep(1);  break;
                case '-':           zStep(-1); break;
                case 's': case 'S': onStar(); break;
            }
        });

        // Filmstrip drag-scroll
        elFilmScroll.addEventListener('mousedown', e => {
            const sx = e.clientX, sl = elFilmScroll.scrollLeft;
            const mm = ev => { elFilmScroll.scrollLeft = sl - (ev.clientX - sx); };
            const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
            window.addEventListener('mousemove', mm);
            window.addEventListener('mouseup', mu);
            e.preventDefault();
        });
    }

    function getTDist(e) {
        return Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
    }

    /* ─── Zoom helpers ──────────────────────────────────────────── */
    function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }

    function clampPan() {
        if (scale <= 1) { panX = 0; panY = 0; return; }

        // Read actual rendered image size from bounding rect
        // We need the *unscaled* image size, so divide out current scale
        const r = elImg.getBoundingClientRect();
        const dispW = r.width  / scale;   // unscaled rendered width
        const dispH = r.height / scale;   // unscaled rendered height

        // Viewport (stage) size
        const vpW = elVp.clientWidth  || window.innerWidth;
        const vpH = elVp.clientHeight || window.innerHeight;

        // How much can we pan? Half the "overflow" beyond the viewport
        const maxPX = Math.max(0, (dispW  * scale - vpW)  / 2);
        const maxPY = Math.max(0, (dispH  * scale - vpH)  / 2);

        panX = Math.max(-maxPX, Math.min(maxPX, panX));
        panY = Math.max(-maxPY, Math.min(maxPY, panY));
    }

    function applyTx(animate = false) {
        elImg.style.transition = animate
            ? 'transform 0.3s cubic-bezier(0.22,1,0.36,1)'
            : 'none';
        elImg.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
        elZBadge.textContent  = `${scale.toFixed(1)}×`;
        elZBadge.classList.toggle('nlb-zb-on', scale > 1.05);
        // Cursor
        if (scale > 1.05) {
            elVp.style.cursor = isDragging ? 'grabbing' : 'grab';
        } else {
            elVp.style.cursor = 'zoom-in';
        }
    }

    function setZoom(s, px, py, animate = false) {
        scale = clampScale(s);
        panX  = px; panY = py;
        if (scale <= 1) { scale = 1; panX = 0; panY = 0; }
        else clampPan();
        applyTx(animate);
    }

    function zStep(dir) {
        const ns = clampScale(scale + dir * 0.35);
        const cx = elVp.clientWidth  / 2;
        const cy = elVp.clientHeight / 2;
        setZoom(ns, panX * (ns / scale), panY * (ns / scale), true);
    }

    /* ─── Open / Close ──────────────────────────────────────────── */
    function open(fileItems, startIndex = 0, callbacks = {}) {
        buildDOM();
        items      = fileItems;
        currentIdx = Math.max(0, Math.min(startIndex, fileItems.length - 1));
        prevIdx    = -1;
        cb         = callbacks;
        isOpen     = true;
        infoOpen   = false;
        setZoom(1, 0, 0, false);
        elMeta.classList.remove('nlb-meta-on');
        elInfo.classList.remove('nlb-active');
        document.body.style.overflow = 'hidden';
        elOv.classList.add('nlb-open');
        elDot.textContent = navigator.onLine ? '● LIVE' : '○ OFFLINE';
        elDot.style.color = navigator.onLine ? '#00ff88' : '#ffaa00';
        buildFilmstrip();
        loadItem(currentIdx);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        stopSS();
        elOv.classList.remove('nlb-open');
        document.body.style.overflow = '';
        elImg.src = '';
        elVideo.pause(); elVideo.src = '';
    }

    /* ─── Navigate ──────────────────────────────────────────────── */
    function navigate(dir) {
        const n = currentIdx + dir;
        if (n < 0 || n >= items.length) {
            elStage.classList.add('nlb-bounce');
            setTimeout(() => elStage.classList.remove('nlb-bounce'), 350);
            return;
        }
        prevIdx = currentIdx;
        currentIdx = n;
        setZoom(1, 0, 0, false);
        loadItem(currentIdx);
        scrollFilm(currentIdx);
        if (ssActive) { stopSS(); startSS(); }
    }

    /* ─── Load item ─────────────────────────────────────────────── */
    function loadItem(idx) {
        const item = items[idx];
        if (!item) return;

        elCnt.textContent = `${idx + 1}  /  ${items.length}`;
        elPrev.style.opacity = idx > 0 ? '1' : '0.2';
        elNext.style.opacity = idx < items.length - 1 ? '1' : '0.2';
        elPrev.style.pointerEvents = idx > 0 ? 'auto' : 'none';
        elNext.style.pointerEvents = idx < items.length - 1 ? 'auto' : 'none';

        elStar.classList.toggle('nlb-starred', !!item.starred);
        elFilmInner.querySelectorAll('.nlb-fitem').forEach((el, i) =>
            el.classList.toggle('nlb-fa', i === idx));

        if (infoOpen) renderMeta(item);

        const src = item.offlineData || item.src;
        showLoader(); hideErr();

        if (item.cat === 'video') {
            elImg.classList.remove('nlb-show');
            elVideo.classList.add('nlb-show');
            elVideo.src = src;
            elVideo.load();
            elVideo.onloadeddata = hideLoader;
            elVideo.onerror = () => { hideLoader(); showErr(); };
            elVp.style.cursor = 'default';
        } else {
            elVideo.classList.remove('nlb-show');
            elVideo.pause(); elVideo.src = '';
            elImg.classList.add('nlb-show');
            elImg.onload  = () => { hideLoader(); applyTx(); };
            elImg.onerror = () => {
                hideLoader();
                if (item.offlineData && elImg.src !== item.offlineData) elImg.src = item.offlineData;
                else showErr();
            };
            elImg.src = src;
        }

        // Slide-in from direction
        const dir = prevIdx >= 0 ? (idx > prevIdx ? 'r' : 'l') : 'r';
        elVp.classList.remove('nlb-slide-l', 'nlb-slide-r');
        void elVp.offsetWidth;
        elVp.classList.add(`nlb-slide-${dir}`);
    }

    /* ─── Loader/Error ──────────────────────────────────────────── */
    function showLoader() { elLoader.classList.add('nlb-on'); }
    function hideLoader() { elLoader.classList.remove('nlb-on'); }
    function showErr()    { elErr.classList.add('nlb-on'); }
    function hideErr()    { elErr.classList.remove('nlb-on'); }

    /* ─── Slideshow ─────────────────────────────────────────────── */
    function toggleSS() { ssActive ? stopSS() : startSS(); }

    function startSS() {
        ssActive = true;
        ssT0 = performance.now();
        elSS.classList.add('nlb-active');
        elSS.innerHTML = svgPause();
        tickSS();
    }

    function stopSS() {
        ssActive = false;
        cancelAnimationFrame(ssRAF);
        elSS.classList.remove('nlb-active');
        elSS.innerHTML = svgPlay();
        if (elSSRing) elSSRing.style.strokeDashoffset = '94.25';
    }

    function tickSS() {
        ssRAF = requestAnimationFrame(t => {
            if (!ssActive) return;
            const pct = Math.min((t - ssT0) / SS_DUR, 1);
            if (elSSRing) elSSRing.style.strokeDashoffset = String(94.25 * (1 - pct));
            if (pct >= 1) {
                if (currentIdx < items.length - 1) navigate(1);
                else { stopSS(); return; }
                ssT0 = performance.now();
            }
            tickSS();
        });
    }

    function svgPlay()  {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    }
    function svgPause() {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    }

    /* ─── Fullscreen ────────────────────────────────────────────── */
    function toggleFS() {
        if (!document.fullscreenElement) {
            (elOv.requestFullscreen || elOv.webkitRequestFullscreen)?.call(elOv);
            elFS.classList.add('nlb-active');
        } else {
            (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
            elFS.classList.remove('nlb-active');
        }
    }

    /* ─── Info ──────────────────────────────────────────────────── */
    function toggleInfo() {
        infoOpen = !infoOpen;
        elMeta.classList.toggle('nlb-meta-on', infoOpen);
        elInfo.classList.toggle('nlb-active', infoOpen);
        if (infoOpen) renderMeta(items[currentIdx]);
    }

    function renderMeta(item) {
        if (!item) return;
        const rows = [
            ['NAME',    item.name || '—'],
            ['TYPE',    item.cat === 'video' ? '▶ VIDEO' : '⬜ IMAGE'],
            ['SIZE',    item.size || '—'],
            ['DATE',    item.date || '—'],
            ['FOLDER',  item.folder || 'None'],
            ['CACHE',   item.offlineData ? '✅ Offline ready' : '⚡ Online only'],
            ['STARRED', item.starred ? '⭐ Yes' : '—'],
            ['INDEX',   `${currentIdx + 1} / ${items.length}`],
        ];
        elMeta.innerHTML = `<div class="nlb-mt">FILE INFO</div>` +
            rows.map(([k, v]) => `<div class="nlb-mr"><span class="nlb-mk">${k}</span><span class="nlb-mv">${v}</span></div>`).join('');
    }

    /* ─── Action handlers ───────────────────────────────────────── */
    function onStar()  { const it = items[currentIdx]; if (it && cb.onStar)  cb.onStar(it.id, !!it.starred); }
    function onTrash() { const it = items[currentIdx]; if (it && cb.onTrash) { close(); cb.onTrash(it.id); } }
    function onDl()    {
        const it = items[currentIdx]; if (!it) return;
        const a = document.createElement('a');
        a.href = it.offlineData || it.src;
        a.download = it.name || 'file';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }

    /* ─── Filmstrip ─────────────────────────────────────────────── */
    function buildFilmstrip() {
        elFilmInner.innerHTML = '';
        items.forEach((item, i) => {
            const fi = document.createElement('div');
            fi.className = 'nlb-fitem' + (i === currentIdx ? ' nlb-fa' : '') + (item.starred ? ' nlb-fstar' : '');
            const ts = item.offlineData || item.thumb || item.src;
            if (item.cat === 'video') {
                fi.innerHTML = `<div class="nlb-fvid">▶</div>`;
            } else {
                const img = document.createElement('img');
                img.src = ts; img.draggable = false;
                img.onerror = () => fi.classList.add('nlb-ferr');
                fi.appendChild(img);
            }
            const num = document.createElement('span');
            num.className = 'nlb-fnum';
            num.textContent = i + 1;
            fi.appendChild(num);
            fi.onclick = () => { prevIdx = currentIdx; currentIdx = i; setZoom(1,0,0,false); loadItem(i); scrollFilm(i); };
            elFilmInner.appendChild(fi);
        });
    }

    function scrollFilm(idx) {
        const item = elFilmInner.children[idx];
        if (!item) return;
        elFilmScroll.scrollTo({ left: item.offsetLeft - elFilmScroll.offsetWidth/2 + item.offsetWidth/2, behavior: 'smooth' });
    }

    /* ─── Public ────────────────────────────────────────────────── */
    return {
        open, close, navigate,
        updateItem(id, changes) {
            const item = items.find(i => i.id === id);
            if (item) Object.assign(item, changes);
            if (items[currentIdx]?.id === id) {
                elStar.classList.toggle('nlb-starred', !!items[currentIdx].starred);
                if (infoOpen) renderMeta(items[currentIdx]);
            }
            elFilmInner.querySelectorAll('.nlb-fitem').forEach((el, i) => {
                el.classList.toggle('nlb-fstar', !!items[i]?.starred);
            });
        }
    };
})();
window.NexusLightbox = NexusLightbox;
