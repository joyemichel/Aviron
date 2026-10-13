/*
 * Boussole : cap du bateau à partir des capteurs d'orientation du téléphone.
 *
 * Le téléphone est fixé sur le bateau : l'angle entre le téléphone et l'axe du bateau
 * est constant. Quand on « prend le cap », on enregistre le cap mesuré à cet instant,
 * qui correspond donc à l'axe longitudinal du bateau ; l'écart affiché ensuite est
 * la rotation du bateau depuis ce moment, quelle que soit la façon dont le support est monté.
 *
 *  - iPhone : event.webkitCompassHeading (cap magnétique, fusion boussole + gyroscope par iOS)
 *  - Android : deviceorientationabsolute (alpha, beta, gamma) → matrice de rotation,
 *    cap de l'axe du téléphone le plus horizontal (haut de l'écran ou dos du téléphone).
 */
(function (root) {
  'use strict';

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function norm360(a) { a = a % 360; return a < 0 ? a + 360 : a; }
  /** écart signé dans [-180, 180) : positif = le bateau a tourné dans le sens horaire */
  function diff(a, b) { var d = norm360(a - b); return d >= 180 ? d - 360 : d; }

  /** Cap des deux axes candidats à partir des angles W3C (degrés). */
  function headingsFromEuler(alpha, beta, gamma) {
    var a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
    var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // R = Rz(a)·Rx(b)·Ry(g) ; repère terrestre x = est, y = nord, z = haut
    // colonne 1 : haut de l'écran (0,1,0)
    var top = [-sa * cb, ca * cb, sb];
    // colonne 2 : (0,0,1) sortant de l'écran ; le dos du téléphone est l'opposé
    var z = [ca * sg + sa * sb * cg, sa * sg - ca * sb * cg, cb * cg];
    var back = [-z[0], -z[1], -z[2]];
    function h(v) { return { heading: norm360(Math.atan2(v[0], v[1]) * R2D), horiz: Math.sqrt(v[0] * v[0] + v[1] * v[1]) }; }
    return { top: h(top), back: h(back) };
  }

  function Compass(opts) {
    opts = opts || {};
    this.tau = opts.tau || 1.0;     // s, lissage
    this.reset();
  }

  Compass.prototype.reset = function () {
    this.s = 0; this.c = 0; this.ready = false;
    this.ss = 0; this.sc = 0;       // moyenne lente (~3 s, environ un cycle de coup) pour l'axe du bateau
    this.lastT = null; this.lastRaw = null;
    this.accuracy = null;           // degrés (iOS) ou null
    this.source = null;             // 'ios' | 'android'
    this.axis = null;               // axe Android retenu ('top' | 'back')
    this.lastEventT = 0;
  };

  /** Ajoute une mesure brute de cap (degrés) au temps t (s). */
  Compass.prototype.pushHeading = function (t, deg) {
    if (!isFinite(deg)) return;
    var r = deg * D2R, s = Math.sin(r), c = Math.cos(r);
    if (!this.ready || this.lastT === null || t - this.lastT > 2) {
      this.s = s; this.c = c; this.ss = s; this.sc = c; this.ready = true;
    } else {
      var dt = Math.max(0, t - this.lastT), k = 1 - Math.exp(-dt / this.tau), k2 = 1 - Math.exp(-dt / 3);
      this.s += k * (s - this.s); this.c += k * (c - this.c);
      this.ss += k2 * (s - this.ss); this.sc += k2 * (c - this.sc);
    }
    this.lastT = t; this.lastRaw = deg; this.lastEventT = t;
  };

  /** Traite un événement deviceorientation / deviceorientationabsolute. */
  Compass.prototype.handleEvent = function (t, e) {
    if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null && e.webkitCompassHeading >= 0) {
      this.source = 'ios';
      var acc = e.webkitCompassAccuracy;
      this.accuracy = (acc === undefined || acc === null) ? null : acc;
      this.pushHeading(t, e.webkitCompassHeading);
      return true;
    }
    if (this.source === 'ios') return false;
    if (!e.absolute || e.alpha === null || e.beta === null || e.gamma === null) return false;
    this.source = 'android';
    var hs = headingsFromEuler(e.alpha, e.beta, e.gamma);
    var axis = this.axis || (hs.back.horiz >= hs.top.horiz ? 'back' : 'top');
    if (hs[axis].horiz < 0.2) return false;  // axe presque vertical : cap indéfini
    this.pushHeading(t, hs[axis].heading);
    return true;
  };

  /** Fige l'axe Android pour la durée du cap (évite un saut si le choix d'axe change). */
  Compass.prototype.lockAxis = function (e) {
    if (this.source !== 'android' || !e) return;
    var hs = headingsFromEuler(e.alpha, e.beta, e.gamma);
    var axis = hs.back.horiz >= hs.top.horiz ? 'back' : 'top';
    if (axis !== this.axis) { this.axis = axis; this.ready = false; this.pushHeading(this.lastT || 0, hs[axis].heading); }
  };

  /** Cap lissé (degrés) ou null. */
  Compass.prototype.heading = function () {
    if (!this.ready || (this.s === 0 && this.c === 0)) return null;
    return norm360(Math.atan2(this.s, this.c) * R2D);
  };

  /** Cap moyen sur ~3 s : axe du bateau sans l'oscillation à l'intérieur du coup. */
  Compass.prototype.axisHeading = function () {
    if (!this.ready || (this.ss === 0 && this.sc === 0)) return null;
    return norm360(Math.atan2(this.ss, this.sc) * R2D);
  };

  /** Données de cap récentes (moins de 2 s) ? */
  Compass.prototype.fresh = function (now) { return this.ready && now - this.lastEventT < 2; };

  var api = { Compass: Compass, diff: diff, norm360: norm360, headingsFromEuler: headingsFromEuler };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Heading = api;
})(this);
