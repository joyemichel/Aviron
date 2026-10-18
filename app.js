/* My Scoach — logique de l'application */
var APP_VERSION = '1.2 (18.10.2026)';
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');

  // ---------- réglages ----------
  var SETTINGS_KEY = 'avironlive.settings';
  var SESS_KEY = 'avironlive.sessions';
  var settings = { speedMode: 'split', theme: 'light', stopMode: 'tap', sens: '1', altSec: '3' };
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  Object.assign(settings, load(SETTINGS_KEY, {}));

  function applySettings() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.querySelector('meta[name=theme-color]').setAttribute('content', settings.theme === 'dark' ? '#000000' : '#f4f1ea');
    detector.sensitivity = parseFloat(settings.sens) || 1;
    var segs = document.querySelectorAll('.seg');
    for (var i = 0; i < segs.length; i++) {
      var key = segs[i].getAttribute('data-key');
      var bs = segs[i].querySelectorAll('button');
      for (var j = 0; j < bs.length; j++) bs[j].classList.toggle('on', bs[j].getAttribute('data-v') === String(settings[key]));
    }
    $('speedLabel').textContent = settings.speedMode === 'split' ? 'Split' : 'Vitesse';
    $('speedUnit').textContent = settings.speedMode === 'split' ? '/500 m' : 'km/h';
  }

  // ---------- état de la séance ----------
  var state = 'idle';          // idle | running | paused
  var accMs = 0;               // temps cumulé avant le dernier départ
  var startMs = 0;             // Date.now() au dernier départ
  var strokes = 0;
  var distance = 0;            // m
  var samples = [];            // 1 échantillon / s pendant la course
  var lastSampleSec = -1;
  var sessionStart = null;

  function elapsedMs() { return state === 'running' ? accMs + (Date.now() - startMs) : accMs; }

  // ---------- accéléromètre / coups ----------
  var beatTimer = null;
  var detector = new StrokeDetector({
    onStroke: function () {
      if (!movingEnough()) return;
      if (state === 'running') strokes++;
      var b = $('beat'); b.classList.add('on');
      clearTimeout(beatTimer); beatTimer = setTimeout(function () { b.classList.remove('on'); }, 120);
    }
  });
  var motionSeen = false;
  function onMotion(e) {
    var a = e.acceleration;
    if (!a || a.x === null || a.x === undefined) a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.x === undefined) return;
    motionSeen = true;
    detector.push(performance.now() / 1000, a.x, a.y, a.z);
  }

  // ---------- GPS ----------
  var fixes = [];              // {t, lat, lon, spd, acc} des 15 dernières secondes
  var lastFix = null;          // dernier point retenu pour la distance
  var speed = 0;               // m/s lissée
  var gpsAcc = null, gpsErr = null, lastFixTime = 0;

  function haversine(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function onPosition(p) {
    var c = p.coords, now = Date.now();
    gpsErr = null; gpsAcc = c.accuracy; lastFixTime = now;
    if (c.accuracy > 30) return; // trop imprécis : on ignore
    var f = { t: now, lat: c.latitude, lon: c.longitude, spd: (c.speed !== null && c.speed >= 0) ? c.speed : null, acc: c.accuracy };
    fixes.push(f);
    while (fixes.length && now - fixes[0].t > 15000) fixes.shift();
    speed = estimateSpeed(now);
    trackFix(f);

    if (state === 'running') {
      if (lastFix) {
        var d = haversine(lastFix, f), dt = (f.t - lastFix.t) / 1000;
        if (dt > 0 && d / dt < 10 && speed >= 0.4) distance += d;   // ignore sauts et dérive à l'arrêt
        if (dt > 0 && d / dt < 10) lastFix = f;
        else if (dt > 10) lastFix = f;
      } else lastFix = f;
    }
  }

  function estimateSpeed(now) {
    // moyenne sur ~5 s : lisse les variations à l'intérieur d'un coup
    var win = fixes.filter(function (f) { return now - f.t <= 5500; });
    if (!win.length) return 0;
    var withSpd = win.filter(function (f) { return f.spd !== null; });
    if (withSpd.length >= Math.ceil(win.length / 2)) {
      var s = 0; withSpd.forEach(function (f) { s += f.spd; });
      return s / withSpd.length;
    }
    if (win.length < 2) return speed;
    var a = win[0], b = win[win.length - 1], dt = (b.t - a.t) / 1000;
    return dt > 0 ? haversine(a, b) / dt : speed;
  }

  function onPosError(err) {
    gpsErr = err.code === 1 ? 'refusé' : 'indispo';
  }

  // Bateau arrêté (GPS fiable, < 0,7 m/s) : on ignore les « coups » dus aux vagues
  function gpsFresh() { return Date.now() - lastFixTime < 5000 && gpsAcc !== null && gpsAcc <= 30; }
  function movingEnough() { return !gpsFresh() || speed >= 0.7; }

  // ---------- boussole et ligne droite ----------
  var compass = new Heading.Compass({ tau: 1.0 });
  var lastOrientEvt = null;
  var tracker = new Line.LineTracker();
  var lastPos = null;                      // dernière position GPS retenue {lat, lon, t}
  var altStart = Date.now();               // début de l'alternance (écran Ligne affiché en premier)
  function onOrient(e) {
    if (compass.handleEvent(performance.now() / 1000, e)) lastOrientEvt = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
  }
  function compassOk() { return compass.fresh(performance.now() / 1000) && compass.heading() !== null; }
  function axisNow() { return compassOk() ? compass.axisHeading() : null; }
  function lineOn() { return tracker.line !== null; }
  function posFresh() { return lastPos && Date.now() - lastPos.t < 5000; }

  function trackFix(f) {
    lastPos = { lat: f.lat, lon: f.lon, t: f.t };
    tracker.pushFix(f.t / 1000, f.lat, f.lon, axisNow());
  }

  function setCap() {
    if (!posFresh()) { toast('GPS nécessaire pour donner le cap', 2500); return; }
    compass.lockAxis(lastOrientEvt);
    var L = tracker.start(axisNow());
    if (!L) { toast('GPS nécessaire pour donner le cap', 2500); return; }
    altStart = Date.now();
    app.setAttribute('data-cap', 'on');
    toast(tracker.direction() !== null ? 'Ligne fixée : ' + pad3(tracker.direction()) + '°' : 'Ligne fixée : rame droit pour le calage', 2200);
    if (navigator.vibrate) navigator.vibrate(60);
  }
  function clearCap() {
    tracker.clear();
    app.setAttribute('data-cap', 'off'); app.setAttribute('data-view', 'metrics');
  }
  $('btnCap').addEventListener('click', setCap);
  $('btnClearCap').addEventListener('click', clearCap);

  var eSmooth = null, eLastT = 0;
  function lineStatus() {
    if (!lineOn()) return null;
    var st = tracker.status(posFresh() ? lastPos : null, compassOk() ? compass.heading() : null);
    // léger lissage de l'écart latéral (bruit GPS)
    if (st.e !== null) {
      var now = Date.now(), k = eSmooth === null ? 1 : 1 - Math.exp(-(now - eLastT) / 1500);
      eSmooth = eSmooth === null ? st.e : eSmooth + k * (st.e - eSmooth); eLastT = now;
      st.e = eSmooth;
    } else eSmooth = null;
    return st;
  }
  function sideName(x) { return x > 0 ? 'tribord' : 'bâbord'; }

  function renderLine(st) {
    var v = $('viewCap');
    var acc = compass.accuracy, warn = (acc !== null && (acc < 0 || acc > 15)) ? ' · boussole imprécise' : '';
    var marker = $('lineMarker');
    if (!posFresh()) {
      $('capDev').textContent = '--'; $('capHint').textContent = 'GPS perdu';
      v.setAttribute('data-zone', 'bad'); marker.style.display = 'none';
      $('capAngle').textContent = ''; $('capInfo').textContent = '';
      return;
    }
    var ang = st.angle;
    var angTxt = ang === null ? '' : Math.abs(ang) < 1.5 ? "Pointe dans l'axe de la ligne" :
      'Pointe ' + Math.round(Math.abs(ang)) + '° vers ' + sideName(ang);
    $('capAngle').textContent = angTxt;
    var dTxt = st.s === null ? '' : Math.round(Math.abs(st.s)) + ' m depuis le départ';

    if (st.e === null) {
      // calage boussole / GPS pas encore terminé : on montre l'angle seulement
      $('capDev').textContent = '…';
      $('capHint').textContent = 'Calage ' + Math.round(tracker.calProgress() * 100) + ' % · rame droit';
      v.setAttribute('data-zone', 'warn'); marker.style.display = 'none';
      $('capInfo').textContent = dTxt + warn;
      return;
    }
    var a = Math.abs(st.e);
    var zone = a <= 3 ? 'ok' : a <= 10 ? 'warn' : 'bad';
    v.setAttribute('data-zone', zone);
    $('capDev').textContent = (a < 10 ? a.toFixed(0) : Math.round(a)) + ' m';
    $('capHint').textContent = a <= 2 ? 'Sur la ligne' : 'à ' + sideName(st.e);
    marker.style.display = 'block';
    var pos = Math.max(-20, Math.min(20, st.e));        // barre ±20 m, bâbord à gauche, tribord à droite
    marker.style.left = (50 + pos / 20 * 50) + '%';
    $('capInfo').textContent = 'Ligne ' + pad3(st.dir) + '° · ' + dTxt + warn;
  }
  function pad3(n) { n = Math.round(n) % 360; return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }

  // ---------- écran allumé ----------
  var wakeLock = null;
  function requestWake() {
    if (!('wakeLock' in navigator)) { $('lockTxt').textContent = ''; return; }
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l; $('lockTxt').textContent = '☀︎';
      l.addEventListener('release', function () { wakeLock = null; $('lockTxt').textContent = ''; });
    }).catch(function () { $('lockTxt').textContent = ''; });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && sensorsOn && !wakeLock) requestWake();
  });

  // ---------- démarrage des capteurs ----------
  var sensorsOn = false;
  $('btnSensors').addEventListener('click', function () {
    var msg = $('startMsg'); msg.textContent = '';
    // les deux demandes partent dans le même geste (exigence d'iOS)
    var pMotion = (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
      ? DeviceMotionEvent.requestPermission() : Promise.resolve('granted');
    var pOrient = (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function')
      ? DeviceOrientationEvent.requestPermission() : Promise.resolve('granted');
    var denied = [];
    Promise.all([
      pMotion.then(function (r) { if (r === 'granted') window.addEventListener('devicemotion', onMotion); else denied.push('cadence'); }, function () { denied.push('cadence'); }),
      pOrient.then(function (r) {
        if (r !== 'granted') { denied.push('boussole'); return; }
        if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
        window.addEventListener('deviceorientation', onOrient);
      }, function () { denied.push('boussole'); })
    ]).then(function () {
      if (denied.length) msg.innerHTML = '<span class="err">Accès refusé (' + denied.join(', ') + ').</span> Réglages iPhone → Apps → Safari → « Mouvement et orientation ».';
    }).then(function () {
      if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(onPosition, onPosError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      } else gpsErr = 'indispo';
      requestWake();
      sensorsOn = true;
      var warn = msg.textContent;
      $('ovStart').classList.remove('show');
      if (warn) toast('Indisponible : ' + denied.join(', ') + ' (accès refusé)', 4000);
      setTimeout(function () { if (!motionSeen) toast('Aucune donnée de mouvement reçue', 4000); }, 3000);
    });
  });

  // ---------- chrono au toucher ----------
  var holdTimer = null, holdStart = 0, holdRaf = null;
  function isUI(t) { return t && t.closest && t.closest('[data-ui], .overlay'); }

  app.addEventListener('pointerdown', function (e) {
    if (!sensorsOn || isUI(e.target)) return;
    if (state === 'running' && settings.stopMode === 'hold') {
      holdStart = performance.now();
      var bar = $('hold');
      var step = function () {
        var p = (performance.now() - holdStart) / 1000;
        bar.style.transform = 'scaleX(' + Math.min(1, p) + ')';
        if (p >= 1) { cancelHold(); pause(); return; }
        holdRaf = requestAnimationFrame(step);
      };
      holdRaf = requestAnimationFrame(step);
      return;
    }
    if (state === 'running') pause(); else start();
  });
  function cancelHold() {
    cancelAnimationFrame(holdRaf); holdRaf = null;
    $('hold').style.transform = 'scaleX(0)';
  }
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { app.addEventListener(ev, cancelHold); });

  function start() {
    if (state === 'idle') {
      accMs = 0; strokes = 0; distance = 0; samples = []; lastSampleSec = -1;
      sessionStart = new Date();
    }
    lastFix = fixes.length ? fixes[fixes.length - 1] : null;
    startMs = Date.now();
    setState('running');
    if (!wakeLock) requestWake();
  }
  function pause() {
    accMs = elapsedMs();
    setState('paused');
  }
  function setState(s) {
    state = s; app.setAttribute('data-state', s);
    $('state').textContent = s === 'running' ? 'En cours' : s === 'paused' ? 'Pause' : 'Prêt';
    $('hint').textContent = s === 'running'
      ? (settings.stopMode === 'hold' ? 'Appui 1 s pour arrêter' : '')
      : s === 'paused' ? 'Toucher pour reprendre' : "Toucher l'écran pour démarrer";
  }

  $('btnFinish').addEventListener('click', function () {
    var dur = accMs / 1000;
    if (dur >= 10) {
      var sess = {
        id: sessionStart.getTime(), date: sessionStart.toISOString(),
        duration: dur, distance: Math.round(distance), strokes: strokes,
        samples: samples
      };
      var list = load(SESS_KEY, []);
      list.unshift(sess);
      while (list.length > 30) list.pop();
      while (!store(SESS_KEY, list) && list.length > 1) list.pop(); // stockage plein : on retire les plus anciennes
      toast('Séance enregistrée : ' + fmtDur(dur) + ' · ' + fmtDist(distance), 3500);
    } else toast('Séance trop courte, non enregistrée', 2500);
    accMs = 0; strokes = 0; distance = 0; samples = [];
    setState('idle');
  });

  // ---------- formats ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(ms) {
    var t = Math.floor(ms / 100), ds = t % 10, s = Math.floor(t / 10), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return { main: (h ? h + ':' + pad(m) : m) + ':' + pad(sec), tenth: '.' + ds };
  }
  function fmtDur(s) { var f = fmtTime(s * 1000); return f.main; }
  function fmtSplit(v) {
    if (!v || v < 0.5) return '--:--';
    var s = 500 / v, m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }
  function fmtDist(d) { return d < 10000 ? Math.round(d) + ' m' : (d / 1000).toFixed(2) + ' km'; }

  // ---------- affichage (10 Hz) ----------
  var lastTimeTxt = '';
  setInterval(function () {
    var ms = elapsedMs();
    var f = fmtTime(ms), txt = f.main + f.tenth;
    if (txt !== lastTimeTxt) { $('time').innerHTML = f.main + '<small>' + f.tenth + '</small>'; lastTimeTxt = txt; }

    var nowS = performance.now() / 1000;
    var spm = movingEnough() ? detector.rate(nowS) : 0;
    $('rate').textContent = spm ? spm.toFixed(0) : '--';

    if (!gpsFresh()) speed = Date.now() - lastFixTime > 8000 ? 0 : speed;
    var kmh = speed * 3.6;
    if (settings.speedMode === 'split') {
      $('speed').textContent = fmtSplit(speed);
      $('speed2').textContent = speed >= 0.5 ? kmh.toFixed(1) + ' km/h' : '-- km/h';
    } else {
      $('speed').textContent = speed >= 0.3 ? kmh.toFixed(1) : '--';
      $('speed2').textContent = fmtSplit(speed) + ' /500 m';
    }
    // cap et alternance des écrans
    var capOn = lineOn(), lst = lineStatus();
    app.setAttribute('data-cap', capOn ? 'on' : 'off');
    var btn = $('btnCap');
    btn.disabled = !posFresh();
    btn.textContent = !posFresh() ? 'Cap (attente GPS…)' : capOn ? 'Nouveau cap' : 'Donner le cap';
    if (capOn) {
      renderLine(lst);
      var period = (parseFloat(settings.altSec) || 3) * 1000;
      var phase = Math.floor((Date.now() - altStart) / period) % 2;
      app.setAttribute('data-view', phase === 0 ? 'cap' : 'metrics');
    } else app.setAttribute('data-view', 'metrics');

    $('dist').textContent = fmtDist(distance);
    $('strokes').textContent = strokes;

    // GPS
    var dot = $('gpsDot'), gt = $('gpsTxt');
    if (gpsErr) { dot.className = 'dot bad'; gt.textContent = 'GPS ' + gpsErr; }
    else if (!lastFixTime) { dot.className = 'dot'; gt.textContent = 'GPS…'; }
    else if (Date.now() - lastFixTime > 5000) { dot.className = 'dot bad'; gt.textContent = 'GPS perdu'; }
    else { dot.className = 'dot ' + (gpsAcc <= 8 ? 'good' : gpsAcc <= 20 ? 'mid' : 'bad'); gt.textContent = '±' + Math.round(gpsAcc) + ' m'; }

    // échantillon par seconde pour l'historique
    if (state === 'running') {
      var sec = Math.floor(ms / 1000);
      if (sec !== lastSampleSec) {
        lastSampleSec = sec;
        var lf = fixes.length ? fixes[fixes.length - 1] : null;
        samples.push([sec, lf ? +lf.lat.toFixed(6) : null, lf ? +lf.lon.toFixed(6) : null,
          Math.round(distance), +speed.toFixed(2), Math.round(spm), strokes,
          compassOk() ? Math.round(compass.heading()) : null,
          lst && lst.dir !== null ? Math.round(lst.dir) : null,
          lst && lst.e !== null ? +lst.e.toFixed(1) : null,
          lst && lst.s !== null ? Math.round(lst.s) : null,
          lst && lst.angle !== null ? +lst.angle.toFixed(1) : null]);
      }
    }
  }, 100);

  // ---------- réglages / historique ----------
  $('btnMenu').addEventListener('click', function () { renderSessions(); $('ovMenu').classList.add('show'); });
  $('btnClose').addEventListener('click', function () { $('ovMenu').classList.remove('show'); setState(state); });
  document.querySelectorAll('.seg').forEach(function (seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      settings[seg.getAttribute('data-key')] = b.getAttribute('data-v');
      store(SETTINGS_KEY, settings); applySettings();
    });
  });

  function renderSessions() {
    var list = load(SESS_KEY, []), box = $('sessList');
    if (!list.length) { box.innerHTML = '<p style="margin:12px 0">Aucune séance pour l\'instant.</p>'; return; }
    box.innerHTML = list.map(function (s) {
      var d = new Date(s.date);
      var avgSpm = s.duration ? s.strokes / s.duration * 60 : 0;
      var avgSplit = s.distance > 50 ? fmtSplit(s.distance / s.duration) : '--:--';
      return '<div class="sess" data-id="' + s.id + '"><div class="t">' +
        d.toLocaleDateString('fr-CH', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' +
        d.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' }) + '</div>' +
        '<div class="m">' + fmtDur(s.duration) + ' · ' + fmtDist(s.distance) + ' · ' + avgSplit + ' /500 m · ' +
        avgSpm.toFixed(1) + ' cps/min · ' + s.strokes + ' coups</div>' +
        '<div class="a"><button data-act="csv">CSV</button><button data-act="gpx">GPX</button><button data-act="del">Supprimer</button></div></div>';
    }).join('');
  }
  $('sessList').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var id = +b.closest('.sess').getAttribute('data-id');
    var list = load(SESS_KEY, []), s = list.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var act = b.getAttribute('data-act');
    if (act === 'del') {
      if (!confirm('Supprimer cette séance ?')) return;
      store(SESS_KEY, list.filter(function (x) { return x.id !== id; })); renderSessions();
    } else if (act === 'csv') exportFile(s, 'csv');
    else exportFile(s, 'gpx');
  });

  function fileName(s, ext) {
    var d = new Date(s.date);
    return 'myscoach_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + '.' + ext;
  }
  function exportFile(s, kind) {
    var content, type;
    if (kind === 'csv') {
      var nz = function (x) { return x === null || x === undefined ? '' : x; };
      content = 'temps_s;latitude;longitude;distance_m;vitesse_ms;split_500m;cadence_cpm;coups;boussole_deg;ligne_deg;ecart_ligne_m;distance_ligne_m;angle_pointe_deg\n' +
        s.samples.map(function (r) { return [r[0], nz(r[1]), nz(r[2]), r[3], r[4], fmtSplit(r[4]), r[5], r[6], nz(r[7]), nz(r[8]), nz(r[9]), nz(r[10]), nz(r[11])].join(';'); }).join('\n');
      type = 'text/csv';
    } else {
      var t0 = new Date(s.date).getTime();
      content = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="My Scoach" xmlns="http://www.topografix.com/GPX/1/1">\n' +
        '<trk><name>My Scoach ' + new Date(s.date).toLocaleString('fr-CH') + '</name><type>rowing</type><trkseg>\n' +
        s.samples.filter(function (r) { return r[1] !== null; }).map(function (r) {
          return '<trkpt lat="' + r[1] + '" lon="' + r[2] + '"><time>' + new Date(t0 + r[0] * 1000).toISOString() + '</time></trkpt>';
        }).join('\n') + '\n</trkseg></trk>\n</gpx>\n';
      type = 'application/gpx+xml';
    }
    var name = fileName(s, kind), blob = new Blob([content], { type: type });
    try {
      var file = new File([blob], name, { type: type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name }).catch(function () {});
        return;
      }
    } catch (e) { /* partage non disponible : téléchargement */ }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // ---------- divers ----------
  var toastTimer = null;
  function toast(t, ms) {
    var el = $('toast'); el.textContent = t; el.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.style.display = 'none'; }, ms || 2500);
  }

  // empêche le zoom par double-toucher et le menu contextuel
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // séance en cours protégée contre la fermeture accidentelle
  window.addEventListener('beforeunload', function (e) { if (state !== 'idle') { e.preventDefault(); e.returnValue = ''; } });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  applySettings();
  setState('idle');
  $('appVersion').textContent = APP_VERSION;
})();
