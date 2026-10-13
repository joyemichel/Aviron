/*
 * Détecteur de coups de rame à partir de l'accéléromètre.
 *
 * Principe :
 *  1. On retire la gravité et les dérives lentes (filtre passe-haut par axe).
 *  2. On suit en continu l'axe dominant des oscillations (axe du bateau),
 *     quelle que soit l'orientation du téléphone (analyse en composante principale glissante).
 *  3. On lisse le signal projeté (passe-bas ~1,2 Hz) pour garder une seule bosse par coup.
 *  4. Un déclencheur à hystérésis, avec seuil adaptatif à l'amplitude du moment,
 *     compte un coup par cycle. Une période réfractaire évite les doubles comptes.
 */
(function (root) {
  'use strict';

  function StrokeDetector(opts) {
    opts = opts || {};
    this.sensitivity = opts.sensitivity || 1;   // 0.7 = moins sensible, 1.4 = plus sensible
    this.minInterval = opts.minInterval || 1.1; // s → 55 cps max
    this.maxInterval = opts.maxInterval || 6;   // s → au-delà, cadence = 0
    this.noiseFloor = opts.noiseFloor || 0.12;  // m/s², en dessous : bateau à l'arrêt
    this.onStroke = opts.onStroke || null;
    this.reset();
  }

  StrokeDetector.prototype.reset = function () {
    this.lastT = null;
    this.base = null;                 // moyenne lente par axe (gravité + dérive)
    this.bpA = [0, 0, 0]; this.bpB = [0, 0, 0]; // passe-bande pour le choix de l'axe
    this.cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.axis = [1, 0, 0];            // axe dominant (vecteur unitaire)
    this.lp1 = 0; this.lp2 = 0;       // passe-bas 2 étages
    this.amp = 0;                     // enveloppe d'amplitude
    this.armed = true;
    this.lastStroke = null;
    this.intervals = [];
    this.signal = 0;
  };

  function ema(prev, x, dt, tau) {
    var a = 1 - Math.exp(-dt / tau);
    return prev + a * (x - prev);
  }

  /** t en secondes, ax/ay/az en m/s² */
  StrokeDetector.prototype.push = function (t, ax, ay, az) {
    if (!isFinite(ax) || !isFinite(ay) || !isFinite(az)) return;
    if (this.lastT === null) {
      this.lastT = t;
      this.base = [ax, ay, az];
      return;
    }
    var dt = t - this.lastT;
    if (dt <= 0) return;
    if (dt > 0.5) { // trou dans les données (app suspendue) : on repart proprement
      this.lastT = t;
      this.base = [ax, ay, az];
      this.lp1 = this.lp2 = 0;
      this.bpA = [0, 0, 0]; this.bpB = [0, 0, 0];
      this.armed = true;
      return;
    }
    this.lastT = t;

    // 1. passe-haut : retire gravité et dérives (> ~3 s)
    var v = [ax, ay, az];
    for (var i = 0; i < 3; i++) {
      this.base[i] = ema(this.base[i], v[i], dt, 1.5);
      v[i] -= this.base[i];
    }

    // 2. axe du bateau : covariance glissante (≈ 15 s) d'un signal passe-bande (~0,6–3 Hz).
    //    La prise d'eau donne un à-coup net dans l'axe du bateau ; le roulis et les vagues,
    //    plus lents et réguliers, pèsent peu dans ce choix, et le bruit du capteur non plus.
    var d = [0, 0, 0];
    for (i = 0; i < 3; i++) {
      this.bpA[i] = ema(this.bpA[i], v[i], dt, 0.05);
      this.bpB[i] = ema(this.bpB[i], v[i], dt, 0.25);
      d[i] = this.bpA[i] - this.bpB[i];
    }
    var ac = 1 - Math.exp(-dt / 15);
    for (i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        this.cov[i][j] += ac * (d[i] * d[j] - this.cov[i][j]);
      }
    }
    var c = this.cov, a0 = this.axis;
    var n = [
      c[0][0] * a0[0] + c[0][1] * a0[1] + c[0][2] * a0[2],
      c[1][0] * a0[0] + c[1][1] * a0[1] + c[1][2] * a0[2],
      c[2][0] * a0[0] + c[2][1] * a0[1] + c[2][2] * a0[2]
    ];
    var norm = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (norm > 1e-9) {
      n = [n[0] / norm, n[1] / norm, n[2] / norm];
      // garde le même sens que précédemment pour ne pas inverser le signal
      if (n[0] * a0[0] + n[1] * a0[1] + n[2] * a0[2] < 0) n = [-n[0], -n[1], -n[2]];
      this.axis = n;
    }

    // 3. projection + passe-bas 2 étages (~1,2 Hz)
    var s = v[0] * this.axis[0] + v[1] * this.axis[1] + v[2] * this.axis[2];
    this.lp1 = ema(this.lp1, s, dt, 0.13);
    this.lp2 = ema(this.lp2, this.lp1, dt, 0.13);
    var y = this.lp2;
    this.signal = y;

    // 4. enveloppe et déclencheur à hystérésis
    this.amp = ema(this.amp, Math.abs(y), dt, 4);
    if (this.amp < this.noiseFloor * 0.5) { this.armed = true; return; }

    var hi = this.amp * 0.6 / this.sensitivity;
    var lo = -this.amp * 0.4 / this.sensitivity;

    if (this.armed && y > hi) {
      this.armed = false;
      // période réfractaire : au moins minInterval, et au moins la moitié du rythme établi
      // (rejette les bosses parasites du roulis entre deux coups)
      var minIv = this.minInterval;
      if (this.intervals.length >= 3) {
        var srt = this.intervals.slice().sort(function (a, b) { return a - b; });
        minIv = Math.max(minIv, 0.5 * srt[Math.floor(srt.length / 2)]);
      }
      if (this.lastStroke === null || t - this.lastStroke >= minIv) {
        if (this.lastStroke !== null) {
          var iv = t - this.lastStroke;
          if (iv <= this.maxInterval) {
            this.intervals.push(iv);
            if (this.intervals.length > 4) this.intervals.shift();
          } else {
            this.intervals = [];
          }
        }
        this.lastStroke = t;
        if (this.amp >= this.noiseFloor && this.onStroke) this.onStroke(t);
      }
    } else if (!this.armed && y < lo) {
      this.armed = true;
    }
  };

  /** Cadence en coups par minute (0 si pas de coup récent). */
  StrokeDetector.prototype.rate = function (now) {
    if (this.lastStroke === null || this.intervals.length === 0) return 0;
    if (this.amp < this.noiseFloor) return 0;
    if (now - this.lastStroke > this.maxInterval) return 0;
    // moyenne des derniers intervalles, en écartant le plus extrême si on en a assez
    var arr = this.intervals.slice().sort(function (a, b) { return a - b; });
    if (arr.length >= 4) arr = arr.slice(1, -1);
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return 60 / (sum / arr.length);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = StrokeDetector;
  else root.StrokeDetector = StrokeDetector;
})(this);
