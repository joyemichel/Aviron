/*
 * Suivi d'une ligne droite à partir du lieu et du moment où le cap est donné.
 *
 *  - Origine : position GPS au moment de l'appui.
 *  - Direction : axe du bateau à cet instant = boussole lissée au moment de l'appui + calage.
 *    Le calage (offset = route GPS − boussole) corrige l'angle de montage du support et
 *    l'influence des ferrures. Il est appris en continu, en ramant droit, sur toute la séance
 *    (moyenne de toutes les mesures stables) ; il peut donc se terminer après l'appui :
 *    la ligne reste celle de l'axe du bateau au moment de l'appui, sa direction s'affine.
 *  - Sans boussole : direction = route GPS au moment de l'appui, ou trajet des 50 premiers mètres.
 *  - e : écart latéral en mètres (> 0 = le bateau est à tribord de la ligne).
 *  - angle : cap du bateau − direction de la ligne (> 0 = la pointe vise à tribord de la ligne).
 */
(function (root) {
  'use strict';
  var D2R = Math.PI / 180, R2D = 180 / Math.PI, R = 6371000;

  function norm360(a) { a = a % 360; return a < 0 ? a + 360 : a; }
  function diff(a, b) { var d = norm360(a - b); return d >= 180 ? d - 360 : d; }
  function project(o, p) {
    return { x: (p.lon - o.lon) * D2R * R * Math.cos(o.lat * D2R), y: (p.lat - o.lat) * D2R * R };
  }
  function bearing(a, b) { var v = project(a, b); return norm360(Math.atan2(v.x, v.y) * R2D); }
  function dist(a, b) { var v = project(a, b); return Math.sqrt(v.x * v.x + v.y * v.y); }

  function LineTracker(opts) {
    opts = opts || {};
    this.minCal = opts.minCal || 25;          // mesures stables avant de considérer le calage fiable
    this.fixes = [];                           // {t, lat, lon, compass}
    this.offS = 0; this.offC = 0; this.offN = 0;
    this.line = null;
  }

  LineTracker.prototype.offset = function () {
    return this.offN ? norm360(Math.atan2(this.offS, this.offC) * R2D) : null;
  };
  LineTracker.prototype.calibrated = function () { return this.offN >= this.minCal; };
  /** progression du calage, 0..1 */
  LineTracker.prototype.calProgress = function () { return Math.min(1, this.offN / this.minCal); };

  /** Route et vitesse GPS sur `win` s, par moindres carrés (robuste au bruit GPS). */
  LineTracker.prototype.course = function (win) {
    var f = this.fixes; if (f.length < 3) return null;
    var last = f[f.length - 1], pts = [], i;
    for (i = f.length - 1; i >= 0 && last.t - f[i].t <= win; i--) pts.unshift(f[i]);
    if (pts.length < 3) return null;
    var o = pts[0], n = pts.length, st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    for (i = 0; i < n; i++) {
      var v = project(o, pts[i]), t = pts[i].t - o.t;
      st += t; sx += v.x; sy += v.y; stt += t * t; stx += t * v.x; sty += t * v.y;
    }
    var den = n * stt - st * st; if (den <= 0) return null;
    var vx = (n * stx - st * sx) / den, vy = (n * sty - st * sy) / den;
    var sp = Math.sqrt(vx * vx + vy * vy), dur = last.t - o.t;
    if (dur < 3 || sp * dur < 8) return null;
    return { heading: norm360(Math.atan2(vx, vy) * R2D), speed: sp };
  };

  /** Nouvelle position GPS (t en s) avec le cap boussole lissé du moment (ou null). */
  LineTracker.prototype.pushFix = function (t, lat, lon, compass) {
    var fx = { t: t, lat: lat, lon: lon, compass: compass };
    this.fixes.push(fx);
    while (this.fixes.length && t - this.fixes[0].t > 20) this.fixes.shift();

    // calage : seulement en mouvement et cap stable sur toute la fenêtre de 15 s
    var cog = this.course(15);
    if (compass !== null && cog && cog.speed >= 1.5) {
      var steady = true, n = 0;
      for (var i = 0; i < this.fixes.length; i++) {
        var c = this.fixes[i];
        if (t - c.t > 15) continue;
        n++;
        if (c.compass === null || Math.abs(diff(compass, c.compass)) > 4) { steady = false; break; }
      }
      if (steady && n >= 10) {
        var off = diff(cog.heading, compass), cur = this.offset();
        if (cur === null || this.offN < 5 || Math.abs(diff(off, cur)) < 20) {   // rejette les valeurs aberrantes
          var r = off * D2R, w = 1 / Math.min(this.offN + 1, 300);
          if (!this.offN) { this.offS = Math.sin(r); this.offC = Math.cos(r); }
          else { this.offS += w * (Math.sin(r) - this.offS); this.offC += w * (Math.cos(r) - this.offC); }
          this.offN++;
        }
      }
    }

    // sans boussole et sans route au départ : direction = trajet des 50 premiers mètres
    var L = this.line;
    if (L && L.compass0 === null && L.dirFixed === null && dist(L.origin, fx) >= 50) L.dirFixed = bearing(L.origin, fx);
  };

  /** Donne le cap : la ligne part de la dernière position GPS. */
  LineTracker.prototype.start = function (compass) {
    var last = this.fixes[this.fixes.length - 1];
    if (!last) return null;
    var dirFixed = null;
    if (compass === null) { var cog = this.course(10); if (cog && cog.speed >= 1.0) dirFixed = cog.heading; }
    this.line = { origin: { lat: last.lat, lon: last.lon }, compass0: compass, dirFixed: dirFixed };
    return this.line;
  };
  LineTracker.prototype.clear = function () { this.line = null; };

  /** Direction actuelle de la ligne (degrés vrais) ou null si pas encore connue. */
  LineTracker.prototype.direction = function () {
    var L = this.line; if (!L) return null;
    if (L.compass0 !== null) return this.calibrated() ? norm360(L.compass0 + this.offset()) : null;
    return L.dirFixed;
  };

  LineTracker.prototype.status = function (p, compass) {
    var L = this.line; if (!L) return null;
    var dir = this.direction();
    var out = { dir: dir, e: null, s: null, angle: null, boat: null, calibrating: dir === null };
    var off = this.offset();
    if (compass !== null && this.calibrated()) out.boat = norm360(compass + off);
    else { var cog = this.course(6); if (cog && cog.speed >= 1) out.boat = cog.heading; }

    if (dir === null) {
      // calage en cours : angle par rapport à l'axe au moment de l'appui (boussole seule)
      if (compass !== null && L.compass0 !== null) out.angle = diff(compass, L.compass0);
      if (p) out.s = dist(L.origin, p);
      return out;
    }
    if (p) {
      var v = project(L.origin, p), th = dir * D2R;
      out.s = v.x * Math.sin(th) + v.y * Math.cos(th);
      out.e = v.x * Math.cos(th) - v.y * Math.sin(th);
    }
    if (compass !== null && L.compass0 !== null) out.angle = diff(compass, L.compass0);
    else if (out.boat !== null) out.angle = diff(out.boat, dir);
    return out;
  };

  var api = { LineTracker: LineTracker, diff: diff, norm360: norm360, bearing: bearing, dist: dist, project: project };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Line = api;
})(this);
