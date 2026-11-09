(() => {
  'use strict';

  // ============================================================
  //  Voxel Paris 1888 — floating voxel diorama
  //  Deterministic: every visual is a pure function of time t.
  // ============================================================

  const VERSION = '1.0';
  const WIDTH = 1280;
  const HEIGHT = 720;
  const DURATION = 14;
  const SS = 1.5;                       // supersampled scene buffer
  const RW = Math.round(WIDTH * SS);
  const RH = Math.round(HEIGHT * SS);
  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;

  const stage = document.getElementById('stage');
  const canvas = document.getElementById('scene');
  const errorEl = document.getElementById('error');

  function fail(err) {
    console.error(err);
    window.__lastError = String(err && (err.stack || err.message) || err);
    if (errorEl) {
      errorEl.style.display = 'block';
      errorEl.textContent = 'Renderer error\n\n' + window.__lastError;
    }
    window.__ready = true;
  }

  try {
    // ---------- deterministic random / math helpers ----------
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rng = mulberry32(18880331);
    function rand(a, b) { return a + (b - a) * rng(); }
    function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
    function pick(arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
    function hash2(x, z) {
      const s = Math.sin(x * 127.1 + z * 311.7 + 74.7) * 43758.5453123;
      return s - Math.floor(s);
    }
    function hash3(x, y, z) {
      const s = Math.sin(x * 127.1 + y * 269.5 + z * 311.7 + 19.19) * 43758.5453123;
      return s - Math.floor(s);
    }
    // stable integer hash used for terrain speckle (no directional lattice)
    function cellHash(ix, iz) {
      let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }
    function vnoise2(x, z) {
      const ix = Math.floor(x), iz = Math.floor(z);
      const fx = x - ix, fz = z - iz;
      const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
      const a = cellHash(ix, iz), b = cellHash(ix + 1, iz);
      const c = cellHash(ix, iz + 1), d = cellHash(ix + 1, iz + 1);
      return lerp(lerp(a, b, u), lerp(c, d, u), v);
    }
    function fbm2(x, z) {
      let v = 0, a = 0.55, s = 1;
      for (let i = 0; i < 4; i++) {
        v += a * vnoise2(x * s, z * s);
        s *= 2.03; a *= 0.5;
      }
      return v;
    }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function smooth(t) { return t * t * (3 - 2 * t); }
    function invLerp(a, b, v) { return clamp((v - a) / (b - a), 0, 1); }

    const updaters = [];
    function onFrame(fn) { updaters.push(fn); }

    // sRGB hex -> linear THREE.Color. The whole pipeline is linear until the
    // final ACES + sRGB composite pass.
    const _colorCache = new Map();
    function C(hex, mul) {
      let base = _colorCache.get(hex);
      if (!base) {
        base = new THREE.Color(hex).convertSRGBToLinear();
        _colorCache.set(hex, base);
      }
      return mul === undefined ? base : base.clone().multiplyScalar(mul);
    }
    function mixColor(a, b, t) {
      return a.clone().lerp(b, t);
    }

    // ---------- renderer ----------
    // Probe WebGL2 on a throwaway canvas; probing on the real canvas would
    // lock its context attributes before WebGLRenderer can request them.
    const gl2 = (() => {
      try {
        const probe = document.createElement('canvas');
        return !!probe.getContext('webgl2');
      } catch (e) { return false; }
    })();
    if (!gl2) throw new Error('This scene needs WebGL2. Please use a current desktop browser.');

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    renderer.outputEncoding = THREE.LinearEncoding;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false;

    // ---------- scene / camera ----------
    const scene = new THREE.Scene();
    const hazeColor = C(0xcfab8d);
    scene.fog = new THREE.FogExp2(hazeColor.clone(), 0.00175);

    const camera = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 0.6, 1200);
    camera.position.set(24, 26, 64);

    // ---------- procedural textures ----------
    function makeEnvTexture() {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 512;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0.0, '#527fa6');
      g.addColorStop(0.34, '#a5bfd4');
      g.addColorStop(0.52, '#f3d0aa');
      g.addColorStop(0.62, '#e8bd90');
      g.addColorStop(1.0, '#5d4b3b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1024, 512);
      // warm scattered glow around the sun hemisphere
      const sun = ctx.createRadialGradient(310, 255, 2, 310, 255, 280);
      sun.addColorStop(0, 'rgba(255,242,206,1)');
      sun.addColorStop(0.07, 'rgba(255,223,164,0.85)');
      sun.addColorStop(0.32, 'rgba(255,193,124,0.25)');
      sun.addColorStop(1, 'rgba(255,190,120,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, 1024, 512);
      // a few soft distant clouds for reflections
      for (let i = 0; i < 12; i++) {
        const x = rand(0, 1024), y = rand(190, 300), r = rand(40, 120);
        const cg = ctx.createRadialGradient(x, y, 0, x, y, r);
        cg.addColorStop(0, 'rgba(255,244,228,0.23)');
        cg.addColorStop(1, 'rgba(255,244,228,0)');
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.encoding = THREE.sRGBEncoding;
      return tex;
    }

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = makeEnvTexture();
    const envRT = pmrem.fromEquirectangular(envTex);
    scene.environment = envRT.texture;
    envTex.dispose();
    pmrem.dispose();

    function makeSoftTexture(size, stops) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (const s of stops) g.addColorStop(s[0], s[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    }
    const glowTex = makeSoftTexture(128, [
      [0, 'rgba(255,255,255,1)'],
      [0.12, 'rgba(255,244,218,0.95)'],
      [0.34, 'rgba(255,185,100,0.42)'],
      [0.7, 'rgba(255,135,50,0.08)'],
      [1, 'rgba(255,120,30,0)'],
    ]);
    const whiteGlowTex = makeSoftTexture(128, [
      [0, 'rgba(255,255,255,1)'],
      [0.22, 'rgba(255,255,255,0.55)'],
      [0.6, 'rgba(255,255,255,0.09)'],
      [1, 'rgba(255,255,255,0)'],
    ]);

    function makeCloudTexture() {
      const s = 256;
      const c = document.createElement('canvas'); c.width = c.height = s;
      const ctx = c.getContext('2d');
      const rr = mulberry32(4117);
      for (let i = 0; i < 26; i++) {
        const x = s * (0.18 + 0.64 * rr());
        const y = s * (0.3 + 0.4 * rr());
        const r = s * (0.1 + 0.19 * rr());
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,244,224,0.38)');
        g.addColorStop(0.55, 'rgba(255,235,214,0.16)');
        g.addColorStop(1, 'rgba(255,235,214,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    }
    const cloudTex = makeCloudTexture();

    function makeWaterNormalTexture() {
      const s = 256;
      const c = document.createElement('canvas'); c.width = c.height = s;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(s, s);
      const wRand = mulberry32(4137);
      const waves = [];
      for (let i = 0; i < 12; i++) {
        // integer frequencies keep the normal map seamlessly tileable
        const a = 1 + Math.floor(wRand() * 11);
        const b = (wRand() > 0.5 ? 1 : -1) * (1 + Math.floor(wRand() * 9));
        const amp = 0.38 / (1 + i * 0.42);
        waves.push([a, b, amp, wRand() * TAU]);
      }
      function height(x, y) {
        let h = 0;
        for (const w of waves) h += w[2] * Math.sin(TAU * (w[0] * x + w[1] * y) + w[3]);
        return h;
      }
      const strength = 1.45;
      const e = 1 / s;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const u = x / s, v = y / s;
          const dx = (height(u + e, v) - height(u - e, v)) / (2 * e);
          const dy = (height(u, v + e) - height(u, v - e)) / (2 * e);
          const nx = -dx * strength, ny = -dy * strength, nz = 1;
          const l = Math.hypot(nx, ny, nz);
          const i = (y * s + x) * 4;
          img.data[i] = Math.round((nx / l * 0.5 + 0.5) * 255);
          img.data[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
          img.data[i + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(3.2, 1.3);
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    }

    // ---------- lights ----------
    const sunDir = new THREE.Vector3(-0.64, 0.5, 0.42).normalize();
    const sunColor = C(0xffc985);
    const hemi = new THREE.HemisphereLight(C(0x7fa6c7), C(0x543d2d), 0.30);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(sunColor, 2.08);
    sun.position.copy(sunDir).multiplyScalar(95).add(new THREE.Vector3(0, 6, 0));
    sun.target.position.set(-1, 0, -2);
    scene.add(sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -38;
    sun.shadow.camera.right = 38;
    sun.shadow.camera.top = 38;
    sun.shadow.camera.bottom = -38;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 190;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2.2;
    sun.shadow.autoUpdate = true;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(C(0x89aecd), 0.22);
    fill.position.set(40, 30, -50);
    scene.add(fill);

    // faint cool bounce that reveals the layered underside of the island
    const underFill = new THREE.DirectionalLight(C(0x9aabc0), 0.22);
    underFill.position.set(-10, -35, 30);
    underFill.target.position.set(0, -4, 0);
    scene.add(underFill);
    scene.add(underFill.target);

    const rim = new THREE.DirectionalLight(C(0xffaa62), 0.13);
    rim.position.set(-20, 16, -60);
    scene.add(rim);

    // A warm virtual bounce from the sunlit stone around the base.
    const baseBounce = new THREE.PointLight(C(0xffb575), 0.22, 80, 2);
    baseBounce.position.set(10, 8, 20);
    scene.add(baseBounce);

    // ---------- sky dome ----------
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uZenith: { value: C(0x3975a2) },
        uMid: { value: C(0xafc1ca) },
        uHorizon: { value: C(0xffba7a) },
        uHaze: { value: C(0xc9a182) },
        uSunDir: { value: new THREE.Vector3(-0.68, 0.078, -0.72).normalize() },
        uSunColor: { value: C(0xffedc6) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDir = normalize(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uZenith, uMid, uHorizon, uHaze, uSunColor, uSunDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, smoothstep(-0.004, 0.062, h));
          col = mix(col, uMid, smoothstep(-0.045, 0.003, h) * 0.55);
          col = mix(uHaze, col, smoothstep(-0.12, -0.004, h));
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunColor * (pow(sd, 900.0) * 0.55 + pow(sd, 36.0) * 0.20 + pow(sd, 5.0) * 0.035);
          vec2 az = normalize(vec2(d.x, d.z) + vec2(0.0001));
          vec2 saz = normalize(vec2(uSunDir.x, uSunDir.z));
          float west = smoothstep(-0.15, 0.7, dot(az, saz));
          col = mix(col, uSunColor * 0.55, west * smoothstep(0.12, -0.01, abs(h)) * 0.25);
          float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          col += (dither - 0.5) * 0.0017;
          gl_FragColor = vec4(max(col, 0.0), 1.0);
        }
      `,
    });
    const SUN_SKY_DIR = new THREE.Vector3(-0.68, 0.072, -0.72).normalize();
    const skyDome = new THREE.Mesh(new THREE.SphereGeometry(620, 64, 32), skyMat);
    skyDome.name = 'sky';
    skyDome.frustumCulled = false;
    skyDome.renderOrder = -1000;
    scene.add(skyDome);

    // an HDR sun disk and halo to feed the bloom pass
    const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: whiteGlowTex, color: new THREE.Color(1.7, 0.65, 0.22),
      transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, fog: false,
    }));
    sunHalo.scale.set(86, 86, 1);
    sunHalo.material.opacity = 0.2;
    sunHalo.renderOrder = -700;
    scene.add(sunHalo);
    const sunCore = new THREE.Sprite(new THREE.SpriteMaterial({
      map: whiteGlowTex, color: new THREE.Color(3.2, 1.35, 0.45),
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, fog: false,
    }));
    sunCore.scale.set(12, 12, 1);
    sunCore.material.opacity = 0.75;
    sunCore.renderOrder = -699;
    scene.add(sunCore);
    onFrame(() => {
      sunHalo.position.copy(camera.position).addScaledVector(SUN_SKY_DIR, 500);
      sunCore.position.copy(camera.position).addScaledVector(SUN_SKY_DIR, 502);
    });

    // ---------- a painted cloud bank far behind the island ----------
    function makeCloudBankTexture() {
      const W = 2048, H = 512;
      const cvs = document.createElement('canvas');
      cvs.width = W; cvs.height = H;
      const ctx = cvs.getContext('2d');
      const rr = mulberry32(90211);
      function blob(x, y, rx, ry, color, alpha) {
        if (alpha <= 0.002) return;
        ctx.save();
        ctx.translate(x, y); ctx.scale(rx, ry);
        const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        rg.addColorStop(0, color.replace('A', alpha.toFixed(3)));
        rg.addColorStop(0.5, color.replace('A', (alpha * 0.8).toFixed(3)));
        rg.addColorStop(1, color.replace('A', '0'));
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
        ctx.restore();
      }
      function cloud(cx, cy, scale, alphaScale, warmth) {
        const n = 10 + Math.floor(rr() * 10);
        for (let j = 0; j < n; j++) {
          const ox = (rr() - 0.5) * 220 * scale;
          const oy = (rr() * 0.7 + 0.1) * 55 * scale;
          blob(cx + ox, cy + oy, (28 + rr() * 66) * scale, (12 + rr() * 24) * scale,
            'rgba(72,63,84,A)', (0.1 + rr() * 0.13) * alphaScale);
        }
        for (let j = 0; j < n; j++) {
          const ox = (rr() - 0.5) * 200 * scale;
          const oy = (rr() - 0.45) * 38 * scale;
          const alpha = (0.16 + rr() * 0.2) * alphaScale;
          blob(cx + ox, cy + oy, (24 + rr() * 60) * scale, (10 + rr() * 22) * scale,
            warmth > 0.5 ? 'rgba(244,204,169,A)' : 'rgba(224,207,201,A)', alpha);
        }
        for (let j = 0; j < 7; j++) {
          const ox = (rr() - 0.5) * 145 * scale;
          const oy = -(3 + rr() * 26) * scale;
          blob(cx + ox, cy + oy, (18 + rr() * 44) * scale, (5 + rr() * 10) * scale,
            'rgba(255,234,201,A)', (0.16 + rr() * 0.18) * alphaScale);
        }
      }
      // far, softer clouds
      for (let i = 0; i < 10; i++) {
        cloud(rr() * W, 185 + rr() * 100, 0.7 + rr() * 0.8, 0.5, 0.5);
      }
      // main dramatic bank
      for (let i = 0; i < 18; i++) {
        const cx = rr() * W;
        const cy = 265 + rr() * 145;
        const scale = 0.9 + rr() * 1.55;
        cloud(cx, cy, scale, 0.85, cx < W * 0.55 ? 0.8 : 0.45);
      }
      // a dense base of cloud, fading into haze
      for (let i = 0; i < 40; i++) {
        const cx = rr() * W;
        const cy = 380 + rr() * 120;
        const rx = 120 + rr() * 280;
        blob(cx, cy, rx, 35 + rr() * 70, i % 4 === 0 ? 'rgba(73,64,82,A)' : 'rgba(198,158,142,A)',
          0.05 + rr() * 0.12);
        blob(cx + (rr() - 0.5) * 100, cy - 26, rx * 0.7, 20 + rr() * 28,
          'rgba(255,226,190,A)', 0.04 + rr() * 0.09);
      }
      // very faint high wisps at the top
      for (let i = 0; i < 13; i++) {
        blob(rr() * W, 50 + rr() * 100, 100 + rr() * 240, 5 + rr() * 16,
          'rgba(255,232,202,A)', 0.02 + rr() * 0.035);
      }
      const tex = new THREE.CanvasTexture(cvs);
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    }
    const cloudBankTex = makeCloudBankTexture();
    const cloudBank = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudBankTex,
      color: C(0xffffff),
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      depthTest: true,
      fog: false,
    }));
    cloudBank.name = 'cloud-bank';
    cloudBank.scale.set(620, 245, 1);
    cloudBank.position.set(8, -8, -235);
    cloudBank.renderOrder = -850;
    cloudBank.visible = false;
    scene.add(cloudBank);
    const cloudBankNear = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudBankTex,
      color: C(0xead2c1),
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      depthTest: true,
      fog: false,
    }));
    cloudBankNear.scale.set(420, 140, 1);
    cloudBankNear.position.set(-30, -17, -115);
    cloudBankNear.renderOrder = -840;
    cloudBankNear.visible = false;
    scene.add(cloudBankNear);

    // soft distant clouds
    const cloudGroup = new THREE.Group();
    cloudGroup.name = 'clouds';
    const cloudMat = new THREE.SpriteMaterial({
      map: cloudTex,
      color: C(0xffe6cc),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      fog: false,
    });
    const cloudDefs = [
      // high clouds catching the last light
      [-180, 42, -260, 165, 34, 0.48, 0xffead3],
      [195, 37, -300, 180, 38, 0.38, 0xffddc2],
      [-40, 28, -350, 210, 34, 0.24, 0xffe6cd],
      // horizon banks framing the island
      [-165, 10, -105, 135, 25, 0.58, 0xf3cdb1],
      [150, 8, -125, 130, 24, 0.54, 0xf3cdb1],
      [-70, 1, -165, 185, 28, 0.44, 0xdab3a4],
      [78, 0, -180, 175, 27, 0.40, 0xdab3a4],
      [-330, 12, -95, 150, 24, 0.28, 0xe7c0aa],
      [335, 14, -90, 150, 24, 0.24, 0xe7c0aa],
      // cloud bank around and below the island
      [-48, -7, 18, 60, 20, 0.44, 0xffe4c6],
      [52, -9, 8, 68, 22, 0.40, 0xffdfc1],
      [-78, -13, -12, 80, 24, 0.34, 0xf4d3b8],
      [84, -15, -22, 85, 25, 0.30, 0xf0cfb5],
      [0, -20, 36, 75, 22, 0.26, 0xe9c4ad],
      [-120, -8, -55, 100, 26, 0.30, 0xccb0a7],
      [125, -9, -65, 100, 26, 0.26, 0xccb0a7],
    ];
    for (const [x, y, z, sx, sy, op, col] of cloudDefs) {
      const sp = new THREE.Sprite(cloudMat.clone());
      sp.material.opacity = op;
      sp.material.color = C(col || 0xffe6cc);
      sp.position.set(x, y, z);
      sp.scale.set(sx, sy, 1);
      cloudGroup.add(sp);
      sp.renderOrder = -900;
    }
    cloudGroup.visible = false;
    scene.add(cloudGroup);

    // ---------- a sea of clouds far below the island ----------
    const cloudSeaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uWarm: { value: C(0xbd9069) },
        uLight: { value: C(0xf5cea0) },
        uCool: { value: C(0x485a6c) },
        uHaze: { value: C(0xb59376) },
        uSunDir: { value: sunDir.clone() },
      },
      vertexShader: `
        varying vec3 vWorld;
        varying vec3 vView;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vView = cameraPosition - wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vWorld;
        varying vec3 vView;
        uniform float uTime;
        uniform vec3 uWarm, uLight, uCool, uHaze, uSunDir;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                     mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.55;
          mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
          for (int i = 0; i < 5; i++) {
            v += a * noise(p);
            p = rot * p * 2.03 + vec2(4.1, -2.7);
            a *= 0.5;
          }
          return v;
        }
        void main() {
          vec2 p = vWorld.xz * 0.014;
          p += uTime * vec2(0.0045, 0.0022);
          float cloud = fbm(p * 1.25);
          float billow = fbm(p * 0.36 + 5.1);
          float detail = fbm(p * 3.9 + 13.0);
          float mass = fbm(p * 0.18 + 21.0);
          float lit = smoothstep(0.28, 0.64, billow) * 0.72 + smoothstep(0.44, 0.75, cloud) * 0.5;
          vec3 col = mix(uCool, uWarm, clamp(billow * 1.35, 0.0, 1.0));
          col = mix(col, uLight, pow(clamp(lit, 0.0, 1.0), 1.4) * 0.8);
          float valley = smoothstep(0.48, 0.17, cloud) * smoothstep(0.58, 0.2, billow);
          col = mix(col, uCool * 0.55, valley * 0.48);
          float shadow = smoothstep(0.52, 0.25, mass);
          col = mix(col, uCool * 0.7, shadow * 0.4);
          col *= 0.86 + detail * 0.32;
          float sun = 0.5 + 0.5 * dot(normalize(vec3(-uSunDir.x, 0.0, -uSunDir.z)), vec3(0.78, 0.0, 0.62));
          col = mix(col, uLight, sun * lit * 0.18);
          float d = length(vView);
          float fog = smoothstep(360.0, 980.0, d);
          vec3 horizon = mix(uHaze, uWarm, 0.28);
          col = mix(col, horizon, fog);
          col *= 0.87;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: false,
    });
    const cloudSea = new THREE.Mesh(new THREE.PlaneGeometry(1700, 1700), cloudSeaMat);
    cloudSea.name = 'cloud-sea';
    cloudSea.rotation.x = -Math.PI / 2;
    cloudSea.position.set(0, -23, 0);
    cloudSea.receiveShadow = false;
    cloudSea.castShadow = false;
    cloudSea.visible = true;
    scene.add(cloudSea);

    // low haze around the floating island
    const hazeMat = new THREE.SpriteMaterial({
      map: cloudTex,
      color: C(0xf2d1b3),
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      fog: false,
    });
    const hazeGroup = new THREE.Group();
    hazeGroup.name = 'haze';
    const hazeDefs = [
      [-38, 2.5, 10, 65, 20],
      [34, 1.8, 12, 58, 17],
      [-18, -9, 2, 72, 22],
      [24, -10, -10, 54, 16],
      [0, 10, 28, 85, 22],
    ];
    for (const [x, y, z, sx, sy] of hazeDefs) {
      const sp = new THREE.Sprite(hazeMat.clone());
      sp.position.set(x, y, z);
      sp.scale.set(sx, sy, 1);
      sp.renderOrder = -800;
      hazeGroup.add(sp);
    }
    hazeGroup.visible = false;
    scene.add(hazeGroup);

    // ============================================================
    //  VOXEL GEOMETRY & STATIC BATCHING
    // ============================================================
    function createRoundedBoxGeometry(width, height, depth, segments, radius) {
      segments = segments * 2 + 1;
      radius = Math.min(width / 2, height / 2, depth / 2, radius);
      const geo = new THREE.BoxGeometry(1, 1, 1, segments, segments, segments).toNonIndexed();
      const position = geo.attributes.position;
      const normal = geo.attributes.normal;
      const box = new THREE.Vector3(width, height, depth).multiplyScalar(0.5).subScalar(radius);
      const p = new THREE.Vector3();
      const n = new THREE.Vector3();
      const halfSegmentSize = 0.5 / segments;
      for (let i = 0; i < position.count; i++) {
        p.fromBufferAttribute(position, i);
        n.copy(p);
        n.x -= Math.sign(n.x) * halfSegmentSize;
        n.y -= Math.sign(n.y) * halfSegmentSize;
        n.z -= Math.sign(n.z) * halfSegmentSize;
        if (n.lengthSq() < 1e-9) n.set(0, 1, 0);
        else n.normalize();
        position.setXYZ(i,
          box.x * Math.sign(p.x) + n.x * radius,
          box.y * Math.sign(p.y) + n.y * radius,
          box.z * Math.sign(p.z) + n.z * radius
        );
        normal.setXYZ(i, n.x, n.y, n.z);
      }
      geo.computeBoundingSphere();
      return geo;
    }

    const voxelGeo = createRoundedBoxGeometry(1, 1, 1, 1, 0.065);
    const bigVoxelGeo = createRoundedBoxGeometry(1, 1, 1, 2, 0.07);
    const beamGeo = new THREE.BoxGeometry(1, 1, 1);

    // Bake a soft contact/crevice ambient occlusion into every voxel. This
    // multiplies the instance colours and grounds all the tiny boxes.
    function bakeVoxelAO(geo) {
      const pos = geo.attributes.position;
      const nrm = geo.attributes.normal;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const ny = nrm.getY(i);
        const x = pos.getX(i), z = pos.getZ(i);
        const topLight = smooth((clamp(y + 0.5, 0, 1)));
        const corner = Math.abs(x) * Math.abs(y) * Math.abs(z) * 8.0;
        const downFace = ny < -0.25 ? 0.9 : 1.0;
        let f = 0.78 + 0.16 * topLight + 0.06 * (ny * 0.5 + 0.5) - 0.075 * clamp(corner, 0, 1);
        f *= downFace;
        f = clamp(f, 0.58, 1.0);
        colors[i * 3] = f; colors[i * 3 + 1] = f; colors[i * 3 + 2] = f;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    bakeVoxelAO(voxelGeo);
    bakeVoxelAO(bigVoxelGeo);

    function material(opts) {
      const m = new THREE.MeshStandardMaterial(Object.assign({
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0.0,
        envMapIntensity: 0.30,
      }, opts));
      return m;
    }

    const MATS = {
      stone: material({ roughness: 0.92, metalness: 0.02, envMapIntensity: 0.24 }),
      earth: material({ roughness: 0.98, metalness: 0.0, envMapIntensity: 0.18 }),
      rock: material({ roughness: 0.97, metalness: 0.0, envMapIntensity: 0.16 }),
      plaster: material({ roughness: 0.88, metalness: 0.0, envMapIntensity: 0.28 }),
      zinc: material({ roughness: 0.64, metalness: 0.30, envMapIntensity: 0.38 }),
      wood: material({ roughness: 0.8, metalness: 0.0, envMapIntensity: 0.2 }),
      darkwood: material({ roughness: 0.85, metalness: 0.0, envMapIntensity: 0.17 }),
      iron: material({ roughness: 0.64, metalness: 0.18, envMapIntensity: 0.16, color: C(0x8d6d5b) }),
      ironDull: material({ roughness: 0.78, metalness: 0.12, envMapIntensity: 0.16 }),
      foliage: material({ roughness: 0.95, metalness: 0.0, envMapIntensity: 0.12 }),
      glass: material({ roughness: 0.30, metalness: 0.24, envMapIntensity: 0.58 }),
      fabric: material({ roughness: 0.92, metalness: 0.0, envMapIntensity: 0.2 }),
      skin: material({ roughness: 0.82, metalness: 0.0, envMapIntensity: 0.22 }),
      cloud: material({ roughness: 1.0, metalness: 0.0, envMapIntensity: 0.22 }),
      brass: material({ roughness: 0.34, metalness: 0.78, envMapIntensity: 0.9 }),
      water: null,
      emissive: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    };

    class StaticBatch {
      constructor(name, mat, geo, cast, receive) {
        this.name = name;
        this.mat = mat;
        this.geo = geo;
        this.cast = cast !== false;
        this.receive = receive !== false;
        this.entries = [];
      }
      add(x, y, z, sx, sy, sz, col, quat) {
        this.entries.push({ x, y, z, sx, sy, sz, col: col.isColor ? col : C(col), q: quat || null });
      }
      build(parent) {
        const n = this.entries.length;
        if (!n) return null;
        const mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
        mesh.name = this.name;
        mesh.castShadow = this.cast;
        mesh.receiveShadow = this.receive;
        const p = new THREE.Vector3(), s = new THREE.Vector3(), m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        for (let i = 0; i < n; i++) {
          const e = this.entries[i];
          p.set(e.x, e.y, e.z);
          s.set(e.sx, e.sy, e.sz);
          if (e.q) q.copy(e.q); else q.identity();
          m.compose(p, q, s);
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, e.col);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.frustumCulled = false;
        parent.add(mesh);
        return mesh;
      }
    }

    const smokeSources = [];
    const _yAxis = new THREE.Vector3(0, 1, 0);
    const batches = {
      stone: new StaticBatch('stone', MATS.stone, voxelGeo),
      earth: new StaticBatch('earth', MATS.earth, voxelGeo),
      rock: new StaticBatch('rock', MATS.rock, voxelGeo),
      plaster: new StaticBatch('plaster', MATS.plaster, voxelGeo),
      zinc: new StaticBatch('zinc', MATS.zinc, voxelGeo),
      wood: new StaticBatch('wood', MATS.wood, voxelGeo),
      darkwood: new StaticBatch('darkwood', MATS.darkwood, voxelGeo),
      iron: new StaticBatch('iron', MATS.iron, beamGeo),
      ironDull: new StaticBatch('ironDull', MATS.ironDull, beamGeo),
      foliage: new StaticBatch('foliage', MATS.foliage, voxelGeo),
      glass: new StaticBatch('glass', MATS.glass, voxelGeo, false, true),
      fabric: new StaticBatch('fabric', MATS.fabric, voxelGeo, false, true),
      skin: new StaticBatch('skin', MATS.skin, voxelGeo, false, true),
      brass: new StaticBatch('brass', MATS.brass, voxelGeo, false, false),
      lamp: new StaticBatch('lamp', MATS.emissive, voxelGeo, false, false),
      cloud: new StaticBatch('cloud', MATS.cloud, bigVoxelGeo, false, false),
    };
    for (const key of Object.keys(MATS)) {
      if (key === 'iron' || key === 'ironDull' || key === 'water') continue;
      if (MATS[key] && MATS[key].isMaterial) MATS[key].vertexColors = true;
    }
    MATS.cloud.vertexColors = true;

    const _p = new THREE.Vector3();
    const _s = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _m = new THREE.Matrix4();
    const _up = new THREE.Vector3(0, 1, 0);
    const _dir = new THREE.Vector3();
    const _mid = new THREE.Vector3();

    function addBox(batch, x, y, z, sx, sy, sz, col) {
      batches[batch].add(x, y, z, sx, sy, sz, col);
    }

    function addBeam(batch, ax, ay, az, bx, by, bz, thickness, col, depth) {
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-5) return;
      _dir.set(dx / len, dy / len, dz / len);
      _q.setFromUnitVectors(_up, _dir);
      _mid.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      batches[batch].add(_mid.x, _mid.y, _mid.z, thickness, len, depth || thickness, col, _q.clone());
    }
    function addBar(batch, x, y, z, sx, sy, sz, col, rotY) {
      if (rotY) {
        const q = new THREE.Quaternion().setFromAxisAngle(_up, rotY);
        batches[batch].add(x, y, z, sx, sy, sz, col, q);
      } else {
        batches[batch].add(x, y, z, sx, sy, sz, col);
      }
    }
    function tint(hex, mul) { return C(hex, mul); }

    // ============================================================
    //  LA SEINE + ISLAND LOGIC
    // ============================================================
    const RIVER_HALF = 3.2;
    const CHAMP = { x0: -16.4, x1: 15.2, z0: -12.8, z1: 8.0 };

    function riverCenterZ(x) {
      return 10.5 - 0.0027 * x * x + 0.56 * Math.sin(x * 0.18 + 0.2);
    }
    function nearBankZ(x) { return riverCenterZ(x) + RIVER_HALF; }
    function farBankZ(x) { return riverCenterZ(x) - RIVER_HALF; }

    function islandEdgeNoise(x, z) {
      return 0.052 * Math.sin(x * 0.55 + 1.3) * Math.sin(z * 0.8 - 0.7)
        + 0.024 * Math.sin(x * 1.7 + z * 2.3 + 0.9)
        + 0.014 * Math.sin(x * 3.3 - z * 2.6);
    }
    function insideIsland(x, z, shrink) {
      shrink = shrink || 0;
      const nx = Math.abs(x) / (26.7 * (1 - shrink));
      const nz = Math.abs(z) / (17.4 * (1 - shrink));
      const v = Math.pow(nx, 7.2) + Math.pow(nz, 7.2);
      return v < 1.0 + islandEdgeNoise(x, z);
    }
    function inRiver(x, z, grow) {
      if (x < -27.2 || x > 27.2) return false;
      return Math.abs(z - riverCenterZ(x)) < RIVER_HALF + (grow || 0);
    }

    // ---------- water ribbon ----------
    function buildWater() {
      const x0 = -27.6, x1 = 27.6;
      const steps = 128;
      const pos = [], uv = [], idx = [];
      for (let i = 0; i <= steps; i++) {
        const x = lerp(x0, x1, i / steps);
        const zc = riverCenterZ(x);
        const zN = zc + RIVER_HALF - 0.02;
        const zF = zc - RIVER_HALF + 0.02;
        pos.push(x, -0.82, zN, x, -0.82, zF);
        uv.push(i / steps * 1.0, 0, i / steps * 1.0, 1);
        if (i < steps) {
          const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
          // upward-facing winding (the camera looks down at the Seine)
          idx.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const normalMap = makeWaterNormalTexture();
      const mat = new THREE.MeshStandardMaterial({
        color: C(0x173a40),
        roughness: 0.4,
        metalness: 0.04,
        envMapIntensity: 0.68,
        normalMap,
        normalScale: new THREE.Vector2(0.095, 0.095),
        transparent: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      scene.add(mesh);
      waterNormalMap = normalMap;
      return mesh;
    }
    let waterNormalMap = null;
    const waterMesh = buildWater();
    waterMesh.name = 'seine-water';

    // ---------- island top, cliffs, rock underside ----------
    function landZone(x, z) {
      const zc = riverCenterZ(x);
      const near = zc + RIVER_HALF;
      const far = zc - RIVER_HALF;
      if (z > near - 0.7) {
        // near-bank promenade, then the city edge
        return z > near + 3.3 ? 'promenade' : 'quay';
      }
      if (z > far - 1.0 && z <= near) return 'quay';
      if (x > CHAMP.x0 && x < CHAMP.x1 && z > CHAMP.z0 && z < far) return 'champ';
      // broad streets / block ground
      return 'stone';
    }

    function topColor(x, z, zone, h) {
      const ix = Math.floor(x + 1000), iz = Math.floor(z + 1000);
      const n = cellHash(ix, iz);
      const patch = fbm2(x * 0.22 + 4.2, z * 0.22 - 1.7);
      if (zone === 'champ') {
        const nearEdge = Math.abs(x - CHAMP.x0) < 2.4 || Math.abs(x - CHAMP.x1) < 2.4 ||
          Math.abs(z - farBankZ(x)) < 1.4 || Math.abs(z - CHAMP.z0) < 1.6;
        if (nearEdge && patch > 0.56 && n > 0.35) {
          return C(n > 0.5 ? 0x626b3e : 0x596338, 0.78 + n * 0.3);
        }
        const dirt = [0x8a6742, 0x926d47, 0x81603d, 0x9b7550, 0x7c5a38, 0x957048];
        let c = C(dirt[Math.floor(n * dirt.length) % dirt.length], 0.84 + n * 0.26);
        if (patch > 0.72) c = C(0xa9875b, 0.9 + n * 0.12);
        if (n > 0.952) c = C(0xb49267, 0.9);
        return c;
      }
      if (zone === 'quay') {
        return C(n > 0.5 ? 0x93866f : 0x887d69, 0.9 + n * 0.16);
      }
      if (zone === 'promenade') {
        const green = patch > 0.60 && Math.sin(z * 0.4) > 0.1;
        if (green) return C(n > 0.5 ? 0x58653c : 0x4f5d36, 0.82 + n * 0.28);
        return C(n > 0.5 ? 0x9b8f78 : 0x928670, 0.88 + n * 0.18);
      }
      // stone city ground
      if (patch < 0.3) return C(0x8a7f6c, 0.9 + n * 0.16);
      return C(n > 0.5 ? 0x998d76 : 0x918570, 0.88 + n * 0.17);
    }

    const G = 1.0;
    for (let ix = -27; ix <= 27; ix++) {
      for (let iz = -17; iz <= 17; iz++) {
        const x = ix + 0.5;
        const z = iz + 0.5;
        if (!insideIsland(x, z, 0.005)) continue;
        if (inRiver(x, z, 0.06)) continue;
        const zone = landZone(x, z);
        const n = hash2(x * 2.11, z * 2.31);
        const h = 0.022 * n;
        addBox(zone === 'champ' ? 'earth' : 'stone', x, -0.28 + h, z, 0.992, 0.56, 0.992, topColor(x, z, zone, h));
        // low curb / edge trim on the quays
        if (zone === 'quay' && n > 0.55) {
          addBox('stone', x, 0.018, z, 0.96, 0.085, 0.96, C(0x8f836f, 0.9 + n * 0.18));
        }
      }
    }

    // Riverbed (visible only at the very edge / under arches)
    for (let ix = -27; ix <= 27; ix++) {
      for (let iz = -17; iz <= 17; iz += 1) {
        const x = ix + 0.5, z = iz + 0.5;
        if (!insideIsland(x, z, 0.0)) continue;
        if (!inRiver(x, z, 0.2)) continue;
        addBox('earth', x, -2.1, z, 1.01, 0.5, 1.01, C(0x303a31, 0.8 + hash2(x, z) * 0.25));
      }
    }

    // Quay walls follow both banks.
    function buildQuayWall(side) {
      const isNear = side > 0;
      const cols = [0x817662, 0x91846d, 0x766d5c, 0x9b8d73, 0x6f6758];
      for (let x = -27; x <= 27; x += 0.92) {
        const zc = riverCenterZ(x);
        const zBase = zc + side * RIVER_HALF;
        const z = zBase + side * 0.20;
        const n = hash2(x * 3.2, side * 3.1);
        // rough stone stack down to the river
        for (let k = 0; k < 4; k++) {
          const y = -0.12 - k * 0.42;
          const off = (k % 2 === 0 ? 0.13 : -0.13);
          addBox('stone', x + off * 0.18, y, z, 0.94, 0.4, 0.64,
            C(cols[(Math.floor(n * 7) + k) % cols.length], 0.9 + n * 0.14));
        }
        // waterline algae
        if (n > 0.72) {
          addBox('foliage', x, -1.15, z - side * 0.22, 0.78, 0.16, 0.2, C(0x42503a, 0.8));
        }
        // coping stone
        addBox('stone', x, 0.035, z - side * 0.06, 0.98, 0.15, 0.86,
          C(0x9e8f75, 0.92 + n * 0.14));
        if (!isNear && x > -26 && hash2(x, 2.39) > 0.82) {
          addBox('stone', x, 0.08, zBase - side * 0.15, 1.0, 0.22, 0.9, C(0x8f856f));
        }
      }
      // stone stairs down to the water at one point
      if (isNear) {
        const sx = 17.5;
        for (let k = 0; k < 4; k++) {
          for (let j = -1; j <= 1; j++) {
            addBox('stone', sx + j * 0.52, -0.08 - k * 0.3, nearBankZ(sx) + 0.95 + k * 0.46,
              0.48, 0.28, 0.42, C(0xa89b82, 0.9 + k * 0.03));
          }
        }
      }
    }
    buildQuayWall(-1);
    buildQuayWall(1);

    // tiny mooring posts
    for (let x = -22; x < 25; x += 7.3) {
      const z = nearBankZ(x) + 0.72;
      addBox('ironDull', x, 0.13, z, 0.14, 0.3, 0.14, C(0x2f322e));
      addBox('ironDull', x, 0.3, z, 0.22, 0.08, 0.22, C(0x363a34));
    }

    // Street lamps along the near quay and bridge ends.
    function addLamp(x, z, y, scale, withLight) {
      scale = scale || 1;
      addBox('ironDull', x, y + 0.75 * scale, z, 0.075 * scale, 1.5 * scale, 0.075 * scale, C(0x22251f));
      addBox('ironDull', x, y + 1.48 * scale, z, 0.3 * scale, 0.06 * scale, 0.3 * scale, C(0x252820));
      addBox('lamp', x, y + 1.64 * scale, z, 0.21 * scale, 0.3 * scale, 0.21 * scale, new THREE.Color(1.0, 0.66, 0.26));
      if (withLight) {
        const gl = new THREE.PointLight(C(0xffb35b), 0.9, 7, 2);
        gl.position.set(x, y + 1.65 * scale, z);
        scene.add(gl);
      }
    }
    for (let x = -23; x <= 23; x += 7.5) {
      addLamp(x, nearBankZ(x) + 1.15, 0.05, 0.9, false);
    }

    // ---------- bridge ----------
    const BRIDGE = { x: -4.8, width: 4.6, z0: 0, z1: 0, deckY: 0.64 };
    BRIDGE.zCenter = riverCenterZ(BRIDGE.x);
    BRIDGE.z0 = farBankZ(BRIDGE.x) - 0.55;
    BRIDGE.z1 = nearBankZ(BRIDGE.x) + 0.55;
    BRIDGE.halfLen = (BRIDGE.z1 - BRIDGE.z0) / 2;
    BRIDGE.deckTopAt = function (z) {
      const u = clamp((z - BRIDGE.zCenter) / BRIDGE.halfLen, -1, 1);
      return 1.02 + 1.46 * (1 - u * u);
    };
    BRIDGE.deckY = BRIDGE.deckTopAt(BRIDGE.zCenter);

    function buildBridge() {
      const cx = BRIDGE.x;
      const hw = BRIDGE.width / 2;
      const z0 = BRIDGE.z0;
      const z1 = BRIDGE.z1;
      const len = z1 - z0;
      const deckY = BRIDGE.deckY;
      const stoneCols = [0x92866f, 0xa09278, 0x887d68, 0xaa9a80, 0x7e745f];
      // two arches
      const archCenters = [z0 + len * 0.27, z0 + len * 0.73];
      const archHalf = len * 0.195;
      const rise = 2.05;
      const springY = -0.8;

      // side walls with arch voids
      for (const side of [-1, 1]) {
        const wallX = cx + side * (hw - 0.16);
        const cell = 0.3;
        for (let z = z0; z < z1; z += cell) {
          const zz = z + cell / 2;
          const wallTop = BRIDGE.deckTopAt(zz) - 0.16;
          for (let y = -1.5; y < wallTop; y += cell) {
            const yy = y + cell / 2;
            let voidArch = false;
            for (const ac of archCenters) {
              if (yy <= springY) {
                if (Math.abs(zz - ac) < archHalf) voidArch = true;
              } else {
                const dz = (zz - ac) / archHalf;
                const dy = (yy - springY) / rise;
                if (dz * dz + dy * dy < 1.0) voidArch = true;
              }
            }
            if (voidArch) continue;
            const n = hash3(zz * 2.1, yy * 3.4, side);
            addBox('stone', wallX, yy, zz, 0.42, cell * 0.98, cell * 0.98,
              C(stoneCols[Math.floor(n * stoneCols.length) % stoneCols.length], 0.82 + n * 0.22));
          }
        }
        // decorative arch voussoirs on the visible faces
        for (const ac of archCenters) {
          for (let i = 0; i <= 13; i++) {
            const a = Math.PI * (i / 13);
            const zz = ac + Math.cos(a) * (archHalf + 0.12);
            const yy = springY + Math.sin(a) * (rise + 0.12);
            addBox('stone', cx + side * (hw + 0.01), yy, zz, 0.32, 0.27, 0.3,
              C(0x7e6a52, 0.9 + 0.12 * Math.sin(i)));
            if (i === 6) {
              addBox('stone', cx + side * (hw + 0.07), yy + 0.12, zz, 0.38, 0.36, 0.34,
                C(0xb1a086));
            }
          }
        }
      }

      // central pier face, visible under the deck between arches
      for (let y = -1.3; y < deckY - 0.14; y += 0.3) {
        for (const side of [-1, 1]) {
          addBox('stone', cx + side * (hw - 0.16), y, BRIDGE.zCenter, 0.44, 0.28, 0.48, C(0x8b7f6a, 0.88));
        }
      }
      // deep shadow inside the arches
      for (const ac of archCenters) {
        addBox('ironDull', cx, 0.38, ac, hw * 1.45, 2.25, archHalf * 1.75, C(0x101512));
      }

      // deck: follows a shallow hump, so the bridge silhouette rises over the Seine
      const deckBlocks = Math.ceil(len / 0.55);
      for (let i = 0; i < deckBlocks; i++) {
        const z = z0 + (i + 0.5) * len / deckBlocks;
        const top = BRIDGE.deckTopAt(z);
        const n = hash2(z * 2.1, 2.4);
        addBox('stone', cx, top - 0.14, z, BRIDGE.width, 0.28, len / deckBlocks + 0.04,
          C(n > 0.5 ? 0x978b74 : 0xa2957e, 0.88 + n * 0.16));
        // paving strip down the centre
        addBox('stone', cx, top - 0.005, z, BRIDGE.width - 0.5, 0.035, len / deckBlocks + 0.01,
          C(0x897d68, 0.9 + n * 0.16));
      }

      // parapets follow the hump, with little balusters
      for (const side of [-1, 1]) {
        const px = cx + side * (hw - 0.12);
        let z = z0 + 0.16;
        while (z < z1 - 0.08) {
          const top = BRIDGE.deckTopAt(z);
          addBox('stone', px, top + 0.1, z, 0.3, 0.26, 0.42, C(0xa89a82));
          addBox('stone', px, top + 0.46, z, 0.15, 0.5, 0.15, C(0xb7a78d));
          addBox('stone', px, top + 0.76, z, 0.22, 0.1, 0.42, C(0x9e9178));
          z += 0.48;
        }
        for (const zEnd of [z0 + 0.28, z1 - 0.28]) {
          const top = BRIDGE.deckTopAt(zEnd);
          addBox('stone', px, top + 0.4, zEnd, 0.42, 1.02, 0.42, C(0xb4a48a));
          addBox('stone', px, top + 0.95, zEnd, 0.54, 0.13, 0.54, C(0xaa9b82));
        }
      }

      // long sloped ramps down to both quays
      const rampAxis = new THREE.Vector3(1, 0, 0);
      for (const end of [z0, z1]) {
        const dir = end === z0 ? -1 : 1;
        const topAtBridge = BRIDGE.deckTopAt(end);
        const topAtQuay = 0.14;
        const run = 2.25;
        const rise = topAtBridge - topAtQuay;
        const angle = Math.atan2(rise, run);
        const slopeLen = Math.hypot(run, rise);
        const qRamp = new THREE.Quaternion().setFromAxisAngle(rampAxis, dir * angle);
        const centerZ = end + dir * (run / 2);
        const centerY = (topAtBridge + topAtQuay) / 2;
        // stone ramp deck
        batches.stone.add(cx, centerY - 0.12, centerZ, BRIDGE.width - 0.1, 0.24, slopeLen + 0.12,
          C(0x8f826b, 0.94), qRamp);
        // paving centre strip
        batches.stone.add(cx, centerY + 0.01, centerZ, BRIDGE.width - 0.48, 0.035, slopeLen,
          C(0x877a65, 0.94), qRamp);
        // parapet walls follow the slope
        for (const side of [-1, 1]) {
          batches.stone.add(cx + side * (hw - 0.18), centerY + 0.46, centerZ,
            0.3, 0.42, slopeLen + 0.1, C(0xa6977f, 0.94), qRamp);
          batches.stone.add(cx + side * (hw - 0.18), centerY + 0.72, centerZ,
            0.2, 0.13, slopeLen + 0.2, C(0x94866f, 0.94), qRamp);
        }
        // small terminal bollards / pedestal bases
        for (const side of [-1, 1]) {
          addBox('stone', cx + side * (hw - 0.18), 0.44, end + dir * (run - 0.05),
            0.34, 0.8, 0.34, C(0xb0a086));
          addBox('stone', cx + side * (hw - 0.18), 0.9, end + dir * (run - 0.05),
            0.43, 0.13, 0.43, C(0xa4947a));
        }
      }

      // arch shadow under the deck
      for (const ac of archCenters) {
        const shade = new THREE.Mesh(
          new THREE.PlaneGeometry(BRIDGE.width - 0.15, archHalf * 1.85),
          new THREE.MeshBasicMaterial({ color: C(0x17201b), transparent: true, opacity: 0.4, depthWrite: false })
        );
        shade.rotation.x = -Math.PI / 2;
        shade.position.set(cx, -0.81, ac);
        scene.add(shade);
      }

      // lamps at the bridge ends
      for (const side of [-1, 1]) {
        for (const end of [z0 + 0.2, z1 - 0.2]) {
          const top = BRIDGE.deckTopAt(end);
          addLamp(cx + side * (hw - 0.22), end, top + 0.08, 0.82, false);
        }
      }

      // tricolor banners on the bridge pylons
      for (const side of [-1, 1]) {
        for (const end of [z0 + 0.32, z1 - 0.32]) {
          const px = cx + side * (hw - 0.05);
          const top = BRIDGE.deckTopAt(end) + 1.05;
          addBox('ironDull', px, top + 0.85, end, 0.045, 1.7, 0.045, C(0x302d28));
          const colors = [0x274576, 0xeee6d4, 0x923c3f];
          for (let i = 0; i < 3; i++) {
            addBox('fabric', px + 0.16 + i * 0.16, top + 1.32, end, 0.16, 0.45, 0.035,
              C(colors[i], 0.96));
          }
        }
      }
    }
    buildBridge();

    // ---------- rock underside ----------
    function buildUnderRock() {
      const rockPalettes = [
        [0x6e5a46, 0x7f6851, 0x90765b, 0x625043],
        [0x816b54, 0x927b61, 0x9f876b, 0x705f4c],
        [0x5f635c, 0x707368, 0x848174, 0x555a53],
        [0x7c6953, 0x8e795f, 0x9c866a, 0x6b5e4b],
      ];
      function rockInside(x, z, k) {
        const shrink = 0.017 + k * 0.046;
        const wobble = 0.06 * Math.sin(k * 1.13 + x * 0.23) + 0.035 * Math.sin(k * 2.1 - z * 0.31);
        const nx = Math.abs(x) / (26.7 * (1 - shrink) + wobble * 6);
        const nz = Math.abs(z) / (17.4 * (1 - shrink) + wobble * 3);
        return Math.pow(nx, 3.9) + Math.pow(nz, 3.9) < 1.0 + islandEdgeNoise(x * 0.9, z * 0.9);
      }
      const step = 1.16;
      for (let k = 0; k < 8; k++) {
        const y = -0.62 - k * 1.02;
        for (let x = -27; x <= 27; x += step) {
          for (let z = -18; z <= 18; z += step) {
            if (!rockInside(x, z, k)) continue;
            let edge = false;
            if (k >= 6) edge = true;
            else {
              for (const d of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
                if (!rockInside(x + d[0], z + d[1], k)) { edge = true; break; }
              }
            }
            if (!edge) continue;
            const n = hash3(x * 0.71, k * 2.11, z * 0.63);
            const pal = rockPalettes[k % rockPalettes.length];
            const c = C(pal[Math.floor(n * pal.length) % pal.length], 0.92 + n * 0.16);
            const scale = step * (0.94 + n * 0.1);
            addBox('rock', x, y, z, scale, 1.06, scale, c);
            // moss / earth trapped on ledges
            if (k < 2 && edge && n > 0.78) {
              addBox('foliage', x, y + 0.54, z, scale * 0.72, 0.16, scale * 0.72,
                C(n > 0.87 ? 0x626b45 : 0x4e5939, 0.78 + n * 0.18));
            }
          }
        }
      }
      // bottom cap, so the chunk never looks hollow from below
      for (let x = -15; x <= 15; x += step) {
        for (let z = -10; z <= 10; z += step) {
          if (!rockInside(x, z, 7.7)) continue;
          const n = hash3(x, 19.1, z);
          addBox('rock', x, -8.35, z, step, 1.0, step, C(0x6a5746, 0.85 + n * 0.15));
        }
      }
      // hanging stone teeth
      const teeth = [
        [-17, 6.5, 2], [-7, 9.5, 3], [9, 7.8, 2], [19, 4.6, 2],
        [-22, -4.2, 2], [3, 2.5, 3], [14, -8.0, 2], [-10, -10.5, 2],
      ];
      for (let i = 0; i < teeth.length; i++) {
        const [x, z, len] = teeth[i];
        const layers = len;
        for (let j = 0; j < layers; j++) {
          const n = hash3(x, j, z);
          const yy = -6.75 - j * 0.78;
          const sz = (1.8 - j * 0.25) * (0.85 + n * 0.2);
          addBox('rock', x + Math.sin(j * 1.7 + i) * 0.22, yy, z + Math.cos(j * 1.3 + i) * 0.18,
            sz, 0.88, sz * 0.92, C(i % 2 ? 0x6b5847 : 0x7a6450, 0.9 + n * 0.16));
        }
      }
    }
    buildUnderRock();

    // ============================================================
    //  THE EIFFEL TOWER
    // ============================================================
    const TOWER = {
      cx: -3.4,
      cz: -5.0,
      topY: 25.8,
      spread0: 6.55,
      topSpread: 0.54,
      platform1: 8.35,
      platform2: 14.15,
    };
    const IRON_COLORS = [0x30170f, 0x3a1c11, 0x27120b, 0x442416, 0x22100a, 0x361a0f];
    const IRON_LIGHT = [0x5c301d, 0x51291a, 0x683722];
    function ironColor(y, n) {
      const pal = y > TOWER.platform2 + 2.6 && n > 0.7 ? IRON_LIGHT : IRON_COLORS;
      return C(pal[Math.floor(n * pal.length) % pal.length], 0.86 + n * 0.25);
    }
    function spreadAt(y) {
      const t = clamp((y - 0.4) / (TOWER.topY - 0.4), 0, 1);
      return TOWER.topSpread + (TOWER.spread0 - TOWER.topSpread) * Math.pow(1 - t, 1.82);
    }
    function legHalfAt(y) {
      const t = clamp((y - 0.4) / (TOWER.topY - 0.4), 0, 1);
      return 0.26 + 0.82 * Math.pow(1 - t, 0.72);
    }
    function legCenterAt(sx, sz, y) {
      const s = spreadAt(y);
      return new THREE.Vector3(TOWER.cx + sx * s, y, TOWER.cz + sz * s);
    }
    function legCornersAt(sx, sz, y) {
      const c = legCenterAt(sx, sz, y);
      const w = legHalfAt(y);
      return [
        new THREE.Vector3(c.x - w, y, c.z - w),
        new THREE.Vector3(c.x + w, y, c.z - w),
        new THREE.Vector3(c.x + w, y, c.z + w),
        new THREE.Vector3(c.x - w, y, c.z + w),
      ];
    }
    const TOWER_LEGS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

    // iron pieces for the pier / foundation pockets
    function buildTowerBase() {
      for (const [sx, sz] of TOWER_LEGS) {
        const c = legCenterAt(sx, sz, 0.2);
        // masonry foundation
        addBox('stone', c.x, -0.22, c.z, 2.7, 0.55, 2.7, C(0x9f927b, 0.96));
        addBox('stone', c.x, 0.08, c.z, 2.35, 0.25, 2.35, C(0xb3a48a, 0.96));
        addBox('stone', c.x, 0.26, c.z, 2.0, 0.18, 2.0, C(0x8f826c, 0.9));
        // dark iron anchor block
        addBox('iron', c.x, 0.42, c.z, 1.9, 0.2, 1.9, C(0x3f2a20, 0.95));
      }
    }

    function buildTowerLattice() {
      const yStart = 0.6;
      const steps = 29;
      const ys = [];
      for (let i = 0; i <= steps; i++) {
        // denser near the base where curvature is strong
        const t = i / steps;
        ys.push(yStart + (TOWER.topY - yStart) * Math.pow(t, 0.92));
      }
      for (let li = 0; li < ys.length - 1; li++) {
        const y0 = ys[li], y1 = ys[li + 1];
        const midY = (y0 + y1) / 2;
        const t = midY / TOWER.topY;
        const braced = t < 0.54 ? true : (hash2(li * 1.37, midY * 0.91) > (t - 0.54) * 1.18);
        const railT = lerp(0.165, 0.075, clamp(t * 1.1, 0, 1));
        const braceT = lerp(0.085, 0.045, t);
        for (const [sx, sz] of TOWER_LEGS) {
          const c0 = legCornersAt(sx, sz, y0);
          const c1 = legCornersAt(sx, sz, y1);
          for (let i = 0; i < 4; i++) {
            addBeam('iron', c0[i].x, c0[i].y, c0[i].z, c1[i].x, c1[i].y, c1[i].z,
              railT, ironColor(midY, hash3(sx, li, i)));
          }
          for (let f = 0; f < 4; f++) {
            const a0 = c0[f], b0 = c0[(f + 1) % 4];
            const a1 = c1[f], b1 = c1[(f + 1) % 4];
            // horizontal ring, but leave little gaps above the second platform
            const keepRing = t < 0.54 || hash3(li, f, 8.1) > 0.34;
            if (keepRing) {
              addBeam('iron', a1.x, a1.y, a1.z, b1.x, b1.y, b1.z, braceT * 0.86,
                ironColor(midY, hash3(li, f, 3.4)));
            }
            if (braced || f < 2) {
              addBeam('iron', a0.x, a0.y, a0.z, b1.x, b1.y, b1.z, braceT,
                ironColor(midY, hash3(li, f, 12.9)));
              addBeam('iron', b0.x, b0.y, b0.z, a1.x, a1.y, a1.z, braceT,
                ironColor(midY, hash3(li, f, 17.2)));
            }
          }
          // joint plates, just enough to read as riveted ironwork
          if (li % 3 === 0 && t < 0.72) {
            const cc = legCenterAt(sx, sz, y1);
            const w = legHalfAt(y1);
            for (let i = 0; i < 4; i++) {
              const p = c1[i];
              addBox('ironDull', p.x, p.y, p.z, 0.22, 0.19, 0.22, C(0x4a2c20));
            }
          }
        }
      }

      // high level cross-ties make the top read as a single skeleton
      const tieLevels = [16.5, 18.6, 20.7, 22.7, 24.3, 25.45];
      for (let i = 0; i < tieLevels.length; i++) {
        const y = tieLevels[i];
        const t = y / TOWER.topY;
        const railT = lerp(0.11, 0.055, t);
        for (const [sx, sz] of TOWER_LEGS) {
          const c = legCornersAt(sx, sz, y);
          for (let j = 0; j < 4; j++) {
            const a = c[j], b = c[(j + 1) % 4];
            addBeam('iron', a.x, a.y, a.z, b.x, b.y, b.z, railT, ironColor(y, hash2(i, j)));
          }
        }
        // ties between adjacent legs on each face
        const pairs = [
          [[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]], [[-1, 1], [1, 1]],
        ];
        for (let f = 0; f < 4; f++) {
          if (hash2(i * 3.1, f * 1.7) < 0.16 && y > 18) continue;
          const [l1, l2] = pairs[f];
          const c1 = legCenterAt(l1[0], l1[1], y);
          const c2 = legCenterAt(l2[0], l2[1], y);
          addBeam('iron', c1.x, y, c1.z, c2.x, y, c2.z, railT * 1.2, ironColor(y, hash2(i, f + 10)));
        }
      }
    }

    function buildTowerArches() {
      const archSpring = 5.15;
      const zFaceFront = TOWER.cz + spreadAt(archSpring) + 0.35;
      const zFaceBack = TOWER.cz - spreadAt(archSpring) - 0.35;
      const xFaceRight = TOWER.cx + spreadAt(archSpring) + 0.35;
      const xFaceLeft = TOWER.cx - spreadAt(archSpring) - 0.35;
      const span = spreadAt(archSpring) + 0.1;
      const apexY = TOWER.platform1 - 0.55;
      const springY = archSpring;
      const arches = [
        { a: [TOWER.cx - span, springY, zFaceFront], b: [TOWER.cx, apexY, zFaceFront + 0.35], c: [TOWER.cx + span, springY, zFaceFront], color: 0 },
        { a: [TOWER.cx - span, springY, zFaceBack], b: [TOWER.cx, apexY, zFaceBack - 0.35], c: [TOWER.cx + span, springY, zFaceBack], color: 0 },
        { a: [xFaceRight, springY, TOWER.cz - span], b: [xFaceRight + 0.35, apexY, TOWER.cz], c: [xFaceRight, springY, TOWER.cz + span], color: 1 },
        { a: [xFaceLeft, springY, TOWER.cz - span], b: [xFaceLeft - 0.35, apexY, TOWER.cz], c: [xFaceLeft, springY, TOWER.cz + span], color: 1 },
      ];
      for (let ai = 0; ai < arches.length; ai++) {
        const arch = arches[ai];
        const A = new THREE.Vector3(...arch.a);
        const B = new THREE.Vector3(...arch.b);
        const D = new THREE.Vector3(...arch.c);
        const curve = new THREE.QuadraticBezierCurve3(A, B, D);
        const pts = curve.getPoints(18);
        const nSeg = pts.length - 1;
        for (let i = 0; i < nSeg; i++) {
          addBeam('iron', pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z,
            0.13, ironColor(pts[i].y, hash3(ai, i, 1.2)));
        }
        // upper chord, offset upward along the normal-ish vertical
        for (let i = 0; i < nSeg; i++) {
          const a = pts[i], b = pts[i + 1];
          const lift = 0.47;
          addBeam('iron', a.x, a.y + lift, a.z, b.x, b.y + lift, b.z,
            0.105, ironColor(a.y, hash3(ai, i, 4.2)));
          // web
          const c = new THREE.Vector3().lerpVectors(a, b, 0.5);
          addBeam('iron', a.x, a.y, a.z, b.x, b.y + lift, b.z, 0.065,
            ironColor(a.y, hash3(ai, i, 8.4)));
          if (i % 2 === 0) {
            addBeam('iron', b.x, b.y, b.z, a.x, a.y + lift, a.z, 0.065,
              ironColor(a.y, hash3(ai, i, 9.1)));
          }
        }
        // hangers to the platform
        for (let i = 2; i < nSeg; i += 5) {
          const p = pts[i];
          addBeam('iron', p.x, p.y + 0.47, p.z, p.x, TOWER.platform1 - 0.2, p.z, 0.06,
            ironColor(p.y, hash3(ai, i, 5.7)));
        }
      }
    }

    function addPlatformRailing(y, half, color) {
      const top = y + 1.03;
      const sides = [
        [TOWER.cx - half, TOWER.cz - half, TOWER.cx + half, TOWER.cz - half, 0],
        [TOWER.cx - half, TOWER.cz + half, TOWER.cx + half, TOWER.cz + half, 0],
        [TOWER.cx - half, TOWER.cz - half, TOWER.cx - half, TOWER.cz + half, 1],
        [TOWER.cx + half, TOWER.cz - half, TOWER.cx + half, TOWER.cz + half, 1],
      ];
      for (const s of sides) {
        const x0 = s[0], z0 = s[1], x1 = s[2], z1 = s[3];
        const horizontal = s[4] === 0;
        const len = horizontal ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
        const n = Math.max(2, Math.round(len / 1.0));
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          const x = lerp(x0, x1, f), z = lerp(z0, z1, f);
          addBox('iron', x, y + 0.53, z, 0.075, 1.04, 0.075, color);
        }
        addBeam('iron', x0, top, z0, x1, top, z1, 0.065, color);
        addBeam('iron', x0, y + 0.55, z0, x1, y + 0.55, z1, 0.05, color);
      }
    }

    function buildPlatform1() {
      const y = TOWER.platform1;
      const half = 4.85;
      const woodCols = [0x8c603f, 0x9b6e49, 0x7c5438, 0xa27650];
      // heavy iron slab / platform structure
      addBox('ironDull', TOWER.cx, y - 0.09, TOWER.cz, half * 2, 0.24, half * 2, C(0x402a20, 0.96));
      // wooden decking laid in strips
      for (let i = 0; i < 18; i++) {
        const z = TOWER.cz - half + (i + 0.5) * (half * 2 / 18);
        const n = hash2(i * 4.1, 8.2);
        addBox('wood', TOWER.cx, y + 0.11, z, half * 2 - 0.1, 0.14, (half * 2 / 18) - 0.025,
          C(woodCols[(i + 1) % woodCols.length], 0.86 + n * 0.22));
      }
      // iron rim
      const rimT = 0.22;
      addBox('iron', TOWER.cx, y - 0.14, TOWER.cz - half, half * 2 + 0.35, rimT, 0.24, C(0x502f21));
      addBox('iron', TOWER.cx, y - 0.14, TOWER.cz + half, half * 2 + 0.35, rimT, 0.24, C(0x502f21));
      addBox('iron', TOWER.cx - half, y - 0.14, TOWER.cz, 0.24, rimT, half * 2, C(0x502f21));
      addBox('iron', TOWER.cx + half, y - 0.14, TOWER.cz, 0.24, rimT, half * 2, C(0x502f21));
      // under-deck lattice frieze
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2;
        const x0 = TOWER.cx + Math.cos(angle) * half;
        const z0 = TOWER.cz + Math.sin(angle) * half;
        const x1 = TOWER.cx + Math.cos(angle + Math.PI / 2) * half;
        const z1 = TOWER.cz + Math.sin(angle + Math.PI / 2) * half;
        const segs = 9;
        for (let j = 0; j < segs; j++) {
          const f0 = j / segs, f1 = (j + 1) / segs;
          const ax = lerp(x0, x1, f0), az = lerp(z0, z1, f0);
          const bx = lerp(x0, x1, f1), bz = lerp(z0, z1, f1);
          addBeam('iron', ax, y - 0.38, az, ax, y + 0.0, az, 0.11, C(0x5b3525));
          addBeam('iron', ax, y - 0.3, az, bx, y - 0.02, bz, 0.08, C(0x653b28));
          addBeam('iron', bx, y - 0.3, bz, ax, y - 0.02, az, 0.08, C(0x5d3524));
        }
      }
      addPlatformRailing(y + 0.18, half - 0.18, C(0x4b2c20));
      // entrance pavilion on the back side
      addBox('wood', TOWER.cx - 2.4, y + 0.8, TOWER.cz - half + 1.0, 2.5, 1.4, 1.5, C(0x7a5137));
      addBox('zinc', TOWER.cx - 2.4, y + 1.58, TOWER.cz - half + 1.0, 2.9, 0.18, 1.9, C(0x4b5d62));
      addBox('glass', TOWER.cx - 2.4, y + 0.9, TOWER.cz - half + 1.77, 1.6, 0.55, 0.05, C(0x354e56));
      // construction stores / crates
      addBox('wood', TOWER.cx + 2.0, y + 0.46, TOWER.cz - 2.2, 1.0, 0.65, 0.7, C(0x8f6743));
      addBox('wood', TOWER.cx + 2.7, y + 0.35, TOWER.cz - 1.6, 0.7, 0.44, 0.7, C(0x9a724c));
      addBox('ironDull', TOWER.cx + 1.8, y + 0.5, TOWER.cz + 2.1, 1.5, 0.18, 0.5, C(0x563024));
    }

    function buildPlatform2() {
      const y = TOWER.platform2;
      const half = 3.25;
      // primary ring / joists are in place, but the deck plating is incomplete
      addBox('iron', TOWER.cx, y - 0.12, TOWER.cz, half * 2 + 0.5, 0.22, 0.2, C(0x543023));
      addBox('iron', TOWER.cx, y - 0.12, TOWER.cz, 0.2, 0.22, half * 2 + 0.5, C(0x543023));
      addBox('iron', TOWER.cx, y - 0.12, TOWER.cz - half, half * 2, 0.2, 0.18, C(0x543023));
      addBox('iron', TOWER.cx, y - 0.12, TOWER.cz + half, half * 2, 0.2, 0.18, C(0x543023));
      const cells = 8;
      for (let i = 0; i < cells; i++) {
        for (let j = 0; j < cells; j++) {
          const lx = -half + (i + 0.5) * (half * 2 / cells);
          const lz = -half + (j + 0.5) * (half * 2 / cells);
          const missing = (lx > 0.25 && lz > 0.25) || (hash3(i * 2.3, j * 1.7, 2.2) > 0.86);
          addBeam('iron', TOWER.cx - half + i * half * 2 / cells, y - 0.04, TOWER.cz - half,
            TOWER.cx - half + i * half * 2 / cells, y - 0.04, TOWER.cz + half, 0.075, C(0x623928));
          if (missing) {
            // a few dangling loose beams at the unfinished edge
            if (hash3(i, j, 8.1) > 0.62) {
              addBeam('iron', TOWER.cx + lx, y - 0.11, TOWER.cz + lz,
                TOWER.cx + lx + 0.45, y - 0.95, TOWER.cz + lz + 0.2, 0.075, C(0x75452f));
            }
            continue;
          }
          addBox('wood', TOWER.cx + lx, y + 0.04, TOWER.cz + lz, half * 2 / cells - 0.05, 0.15, half * 2 / cells - 0.05,
            C(hash3(i, j, 4.4) > 0.5 ? 0x8a6041 : 0x966c48, 0.9));
        }
      }
      addBeam('iron', TOWER.cx, y - 0.02, TOWER.cz - half, TOWER.cx, y - 0.02, TOWER.cz + half, 0.1, C(0x583325));
      addBeam('iron', TOWER.cx - half, y - 0.02, TOWER.cz, TOWER.cx + half, y - 0.02, TOWER.cz, 0.1, C(0x583325));
      // partial railings on the two completed sides
      const top = y + 1.0;
      for (let i = 0; i <= 7; i++) {
        const f = i / 7;
        const x = TOWER.cx - half + 0.2 + f * (half * 2 - 0.4);
        addBox('iron', x, y + 0.5, TOWER.cz - half + 0.15, 0.07, 0.95, 0.07, C(0x4d2d21));
        addBox('iron', TOWER.cx - half + 0.15, y + 0.5, x, 0.07, 0.95, 0.07, C(0x4d2d21));
      }
      addBeam('iron', TOWER.cx - half + 0.2, top, TOWER.cz - half + 0.15, TOWER.cx + half - 0.2, top, TOWER.cz - half + 0.15, 0.06, C(0x4b2b1f));
      addBeam('iron', TOWER.cx - half + 0.15, top, TOWER.cz - half + 0.2, TOWER.cx - half + 0.15, top, TOWER.cz + half - 0.2, 0.06, C(0x4b2b1f));
    }

    // ---------- wooden scaffolding around the four legs ----------
    function buildScaffolding() {
      const woodCols = [0x65482f, 0x735237, 0x583e29, 0x6d4e35];
      for (const [sx, sz] of TOWER_LEGS) {
        const c = legCenterAt(sx, sz, 0);
        const outward = new THREE.Vector3(sx, 0, sz).normalize();
        const center = new THREE.Vector3(c.x + outward.x * 0.55, 0, c.z + outward.z * 0.55);
        const size = 3.15;
        const levels = 4;
        const postH = TOWER.platform1 - 0.55;
        const posts = [
          [-size / 2, -size / 2], [size / 2, -size / 2], [size / 2, size / 2], [-size / 2, size / 2],
        ];
        // four uprights
        for (const [px, pz] of posts) {
          addBox('wood', center.x + px, postH / 2, center.z + pz, 0.14, postH, 0.14,
            C(woodCols[Math.floor(hash2(px + sx, pz + sz) * 4)], 0.95));
        }
        // ledgers, braces and deck planks
        for (let l = 1; l <= levels; l++) {
          const y = l * postH / (levels + 1);
          for (let i = 0; i < 4; i++) {
            const a = posts[i], b = posts[(i + 1) % 4];
            addBeam('wood', center.x + a[0], y, center.z + a[1], center.x + b[0], y, center.z + b[1],
              0.1, C(woodCols[(i + l) % woodCols.length]));
            // X braces on the outward faces, only on some bays to keep it readable
            if ((l + i) % 2 === 0) {
              addBeam('wood', center.x + a[0], y - postH / (levels + 1), center.z + a[1],
                center.x + b[0], y, center.z + b[1], 0.065, C(0x7a583b));
              addBeam('wood', center.x + b[0], y - postH / (levels + 1), center.z + b[1],
                center.x + a[0], y, center.z + a[1], 0.065, C(0x866143));
            }
          }
          if (l % 2 === 0) {
            addBox('wood', center.x, y + 0.06, center.z, size - 0.2, 0.1, size - 0.2, C(0x9c744c));
          }
        }
        // diagonal external bracing
        for (const [px, pz] of posts) {
          addBeam('wood', center.x + px, 0.4, center.z + pz,
            center.x + px * 0.72, postH - 1.2, center.z + pz * 0.72, 0.075, C(0x805c3e));
        }
      }
    }

    buildTowerBase();
    buildTowerLattice();
    buildTowerArches();
    buildPlatform1();
    buildPlatform2();
    buildScaffolding();

    // ============================================================
    //  CHAMP DE MARS — CONSTRUCTION YARD
    // ============================================================
    function addShed(x, z, w, d, h, seed, facing) {
      const rr = mulberry32(seed);
      const bodyCols = [0x6f5137, 0x7a5a3d, 0x654a33, 0x826143];
      const body = C(bodyCols[Math.floor(rr() * bodyCols.length)]);
      addBox('wood', x, h / 2 + 0.02, z, w, h, d, body);
      // plank seams on the visible front
      const nPlanks = Math.max(3, Math.round(w / 0.34));
      for (let i = 0; i < nPlanks; i++) {
        const px = x - w / 2 + (i + 0.5) * w / nPlanks;
        addBox('darkwood', px, h / 2 + 0.02, z + d / 2 + 0.025, w / nPlanks - 0.045, h - 0.08, 0.04,
          body.clone().multiplyScalar(0.7 + rr() * 0.2));
      }
      // door opening
      addBox('darkwood', x - w * 0.24, h * 0.36, z + d / 2 + 0.06, w * 0.27, h * 0.68, 0.08, C(0x352619));
      addBox('wood', x - w * 0.24, h * 0.7, z + d / 2 + 0.12, w * 0.33, 0.1, 0.5, C(0x8a6542));
      // little window
      addBox('glass', x + w * 0.22, h * 0.63, z + d / 2 + 0.06, 0.42, 0.32, 0.05, C(0x2c3f43));
      addBox('stone', x + w * 0.22, h * 0.81, z + d / 2 + 0.08, 0.52, 0.07, 0.12, C(0x7d705b));
      // stepped pitched roof
      const roofCols = [0x646b66, 0x737973, 0x555f5b, 0x7b8078];
      for (let i = 0; i < 3; i++) {
        addBox('zinc', x, h + 0.14 + i * 0.22, z, w + 0.38 - i * 0.18,
          0.16, d + 0.42 - i * 0.38, C(roofCols[(i + seed) % roofCols.length], 0.9));
      }
      addBox('wood', x, h + 0.03, z + d / 2 + 0.18, w + 0.22, 0.12, 0.12, C(0x8b6845));
      // stovepipe
      addBox('ironDull', x + w * 0.28, h + 0.75, z - d * 0.18, 0.12, 1.2, 0.12, C(0x2f2d29));
      addBox('ironDull', x + w * 0.28, h + 1.36, z - d * 0.18, 0.2, 0.08, 0.2, C(0x242320));
      smokeSources.push(new THREE.Vector3(x + w * 0.28, h + 1.45, z - d * 0.18));
      // timber props leaning against the wall
      for (let i = 0; i < 3; i++) {
        addBox('wood', x - w / 2 - 0.35, 0.46, z - d / 2 + 0.3 + i * 0.24, 0.22, 0.9, 0.08,
          C(0x8a6847, 0.9 - i * 0.06));
      }
    }

    const YARD = {
      sheds: [
        [-12.7, 4.5, 3.7, 2.0, 1.65, 71],
        [12.4, 4.8, 3.2, 1.9, 1.5, 93],
        [-13.6, 1.2, 2.5, 1.6, 1.25, 117],
      ],
    };
    for (let i = 0; i < YARD.sheds.length; i++) {
      const [x, z, w, d, h, seed] = YARD.sheds[i];
      addShed(x, z, w, d, h, seed, 0);
    }

    function girderColor(seed) {
      const pal = [0x4c2b1d, 0x59331f, 0x42251a, 0x613a24, 0x352018];
      return C(pal[seed % pal.length], 0.92 + (seed % 7) * 0.025);
    }
    function addGirder(x, y, z, len, rotY, seed) {
      const q = new THREE.Quaternion().setFromAxisAngle(_yAxis, rotY || 0);
      const col = girderColor(seed);
      const cos = Math.cos(rotY || 0), sin = Math.sin(rotY || 0);
      const part = (lx, ly, lz, sx, sy, sz, batch, color) => {
        batches[batch].add(x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos,
          sx, sy, sz, color, q);
      };
      part(0, 0.17, 0, len, 0.075, 0.42, 'ironDull', col);
      part(0, 0, 0, len, 0.3, 0.11, 'ironDull', col.clone().multiplyScalar(0.84));
      part(0, -0.17, 0, len, 0.075, 0.42, 'ironDull', col.clone().multiplyScalar(1.05));
      // rivet line / top highlight
      for (let i = -1; i <= 1; i += 2) {
        part(i * len * 0.35, 0.22, 0.12, 0.08, 0.04, 0.12, 'iron', C(0x8b6044, 0.9));
      }
    }

    function addGirderStack(x, z, len, layers, rotY, seed) {
      const rr = mulberry32(seed);
      for (let i = 0; i < 2; i++) {
        addBox('wood', x, 0.08, z + (i - 0.5) * 0.75, len + 0.4, 0.14, 0.22, C(0x6f5135));
      }
      for (let l = 0; l < layers; l++) {
        const count = Math.max(2, 4 - Math.floor(l / 2));
        for (let i = 0; i < count; i++) {
          const off = (i - (count - 1) / 2) * 0.44;
          addGirder(x + off * Math.cos(rotY) + (l % 2) * 0.1, 0.3 + l * 0.33, z - off * Math.sin(rotY),
            len * (0.92 + rr() * 0.14), rotY, seed + l * 3 + i);
        }
      }
    }

    const stacks = [
      [-8.6, 4.6, 2.8, 4, 0.08, 21],
      [-6.8, 5.1, 2.2, 3, -0.04, 27],
      [4.4, 5.1, 3.0, 4, 0.11, 33],
      [14.1, 0.9, 2.4, 4, 0.02, 39],
      [13.6, 3.0, 1.9, 2, -0.08, 45],
      [-12.4, -0.5, 2.3, 3, 0.42, 51],
    ];
    for (const st of stacks) addGirderStack(...st);

    function addCrate(x, y, z, s, seed) {
      const col = C(0x7c5b3d, 0.88 + (seed % 5) * 0.03);
      addBox('wood', x, y + s / 2, z, s, s, s, col);
      addBox('darkwood', x, y + s / 2, z + s / 2 + 0.02, s * 0.88, s * 0.08, 0.04, C(0x57402b));
      addBox('darkwood', x - s / 2 - 0.02, y + s / 2, z, 0.04, s * 0.08, s * 0.88, C(0x57402b));
    }
    function addBarrel(x, z, seed) {
      const col = C(0x6b4b32, 0.9 + (seed % 3) * 0.04);
      addBox('wood', x, 0.3, z, 0.42, 0.6, 0.42, col);
      addBox('ironDull', x, 0.17, z, 0.46, 0.06, 0.46, C(0x33322c));
      addBox('ironDull', x, 0.44, z, 0.46, 0.06, 0.46, C(0x33322c));
    }
    for (let i = 0; i < 7; i++) {
      addCrate(-14.7 + (i % 3) * 0.65, Math.floor(i / 3) * 0.55, 3.2 + (i % 2) * 0.6,
        0.5 + (i % 2) * 0.14, 100 + i);
    }
    for (let i = 0; i < 6; i++) {
      addCrate(10.0 + (i % 2) * 0.62, Math.floor(i / 2) * 0.52, 6.2 + (i % 3) * 0.5, 0.55, 130 + i);
    }
    for (let i = 0; i < 5; i++) addBarrel(-14.2 + i * 0.55, 0.7, 200 + i);
    for (let i = 0; i < 4; i++) addBarrel(11.3 + i * 0.5, 6.3, 220 + i);

    // masonry pile by the tower foot
    for (let i = 0; i < 16; i++) {
      const px = -10.6 + (i % 4) * 0.55 + (i % 2) * 0.1;
      const pz = 2.0 + Math.floor(i / 4) * 0.48 + (i % 2) * 0.08;
      addBox('stone', px, 0.11 + Math.floor(i / 8) * 0.22, pz, 0.44, 0.22, 0.36, C(0x998b73, 0.9));
    }

    // little construction railway
    for (let x = -9.4; x < 10.5; x += 0.82) {
      addBox('darkwood', x, 0.045, 3.7, 0.26, 0.08, 1.28, C(0x543b27));
    }
    addBox('iron', -0.1, 0.12, 3.42, 20.2, 0.06, 0.08, C(0x403b34));
    addBox('iron', -0.1, 0.12, 4.0, 20.2, 0.06, 0.08, C(0x403b34));

    // dirt roads / wheel ruts across the yard
    for (let i = 0; i < 2; i++) {
      for (let x = -13; x < 14; x += 0.72) {
        const z = 3.3 + i * 0.55;
        addBox('earth', x + 0.36, 0.044, z, 0.62, 0.026, 0.13, C(0x5a452f, 0.85 + i * 0.08));
      }
      for (let z = -11; z < 7; z += 0.75) {
        addBox('earth', 1.5 + i * 0.55, 0.045, z + 0.37, 0.12, 0.026, 0.63, C(0x5d4832, 0.86));
      }
    }

    // a few blocks of pale stone staged for the tower foundations
    for (let i = 0; i < 8; i++) {
      addBox('stone', -7.8 + i * 0.55, 0.2, 2.9, 0.48, 0.35, 0.44, C(0x9f9076, 0.9 + i * 0.01));
    }

    // ============================================================
    //  HAUSSMANN PARIS
    // ============================================================
    const WALL_PALETTE = [0xe3d1b2, 0xdac5a5, 0xe8d9be, 0xd5c2a5, 0xcfbea1, 0xe0cdae, 0xd8c8af];
    const TRIM_PALETTE = [0xeee2cc, 0xe6d7bd, 0xf0e6d3, 0xd9cbb3];
    const ROOF_PALETTE = [0x5e6c73, 0x55656d, 0x69787f, 0x4f6069, 0x728087, 0x5a6a72];
    const AWNING_PALETTE = [0x873f35, 0x3f5947, 0x3d4d67, 0x7c5e39, 0x6d3d3b, 0x4b5a4b];

    function addHaussmann(cx, cz, w, d, h, rot, seed) {
      const rr = mulberry32(seed);
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const q = new THREE.Quaternion().setFromAxisAngle(_yAxis, rot);
      const wall = C(WALL_PALETTE[Math.floor(rr() * WALL_PALETTE.length)]);
      const trim = C(TRIM_PALETTE[Math.floor(rr() * TRIM_PALETTE.length)]);
      const roof = C(ROOF_PALETTE[Math.floor(rr() * ROOF_PALETTE.length)]);
      function add(batch, lx, ly, lz, sx, sy, sz, col) {
        const wx = cx + lx * cos + lz * sin;
        const wz = cz - lx * sin + lz * cos;
        batches[batch].add(wx, ly, wz, sx, sy, sz, col, q);
      }
      const _roofEuler = new THREE.Euler();
      const _localQ = new THREE.Quaternion();
      function addRot(batch, lx, ly, lz, sx, sy, sz, col, rx, rz) {
        _roofEuler.set(rx || 0, 0, rz || 0, 'XYZ');
        _localQ.setFromEuler(_roofEuler);
        const qq = q.clone().multiply(_localQ);
        const wx = cx + lx * cos + lz * sin;
        const wz = cz - lx * sin + lz * cos;
        batches[batch].add(wx, ly, wz, sx, sy, sz, col, qq);
      }

      // main mass + rusticated base
      add('plaster', 0, 0.12 + h / 2, 0, w, h, d, wall);
      add('stone', 0, 0.42, 0, w + 0.18, 0.82, d + 0.18, trim.clone().multiplyScalar(0.82));
      for (let i = 0; i < 3; i++) {
        add('stone', 0, 0.25 + i * 0.29, d / 2 + 0.055, w + 0.14, 0.07, 0.1, trim.clone().multiplyScalar(0.75));
      }
      // horizontal string courses
      for (let i = 1; i < 4; i++) {
        add('plaster', 0, 0.58 + i * 1.28, d / 2 + 0.035, w + 0.03, 0.06, 0.1, trim.clone().multiplyScalar(0.92));
      }
      // cornice
      add('stone', 0, h + 0.02, 0, w + 0.26, 0.19, d + 0.26, trim);
      add('stone', 0, h - 0.18, 0, w + 0.13, 0.13, d + 0.13, trim.clone().multiplyScalar(0.95));

      // windows -- front and both visible sides
      const floors = Math.max(2, Math.floor((h - 2.2) / 1.28));
      const winH = 0.7, winW = 0.42;
      const glassCol = C(0x2d3d43);
      const glassWarm = C(0x4d4b3e);
      function windowZ(face, localX, wy, balcony) {
        const zf = face * (d / 2 + 0.01);
        add('plaster', localX, wy, zf, 0.59, winH + 0.2, 0.08, trim);
        if (rr() < 0.055) {
          add('lamp', localX, wy, zf + face * 0.058, 0.43, winH, 0.035,
            new THREE.Color(1.8, 0.9, 0.32));
        } else {
          add('glass', localX, wy, zf + face * 0.058, 0.43, winH, 0.035,
            rr() > 0.88 ? glassWarm : glassCol);
        }
        add('stone', localX, wy - winH / 2 - 0.065, zf + face * 0.09, 0.68, 0.09, 0.2, trim.clone().multiplyScalar(0.86));
        if (balcony) {
          add('ironDull', localX, wy - winH / 2 - 0.14, zf + face * 0.24, 0.72, 0.055, 0.42, C(0x2b2d2b));
          for (let b = -1; b <= 1; b++) {
            add('ironDull', localX + b * 0.28, wy - winH / 2 + 0.08, zf + face * 0.42, 0.035, 0.36, 0.035, C(0x30322f));
          }
          add('ironDull', localX, wy + 0.25, zf + face * 0.42, 0.68, 0.035, 0.035, C(0x30322f));
        }
      }
      function windowX(face, localZ, wy, balcony) {
        const xf = face * (w / 2 + 0.01);
        add('plaster', xf, wy, localZ, 0.08, winH + 0.2, 0.59, trim);
        if (rr() < 0.045) {
          add('lamp', xf + face * 0.058, wy, localZ, 0.035, winH, 0.43, new THREE.Color(1.5, 0.75, 0.28));
        } else {
          add('glass', xf + face * 0.058, wy, localZ, 0.035, winH, 0.43, rr() > 0.9 ? glassWarm : glassCol);
        }
        add('stone', xf + face * 0.09, wy - winH / 2 - 0.065, localZ, 0.2, 0.09, 0.68, trim.clone().multiplyScalar(0.86));
        if (balcony) {
          add('ironDull', xf + face * 0.24, wy - winH / 2 - 0.14, localZ, 0.42, 0.055, 0.72, C(0x2b2d2b));
          for (let b = -1; b <= 1; b++) {
            add('ironDull', xf + face * 0.42, wy - winH / 2 + 0.08, localZ + b * 0.28, 0.035, 0.36, 0.035, C(0x30322f));
          }
          add('ironDull', xf + face * 0.42, wy + 0.25, localZ, 0.035, 0.035, 0.68, C(0x30322f));
        }
      }
      const winXs = [];
      const nWin = Math.max(2, Math.round((w - 1.1) / 0.98));
      for (let i = 0; i < nWin; i++) {
        winXs.push(nWin === 1 ? 0 : lerp(-w / 2 + 0.7, w / 2 - 0.7, i / (nWin - 1)));
      }
      const sideZs = [];
      const nSide = Math.max(1, Math.round((d - 0.9) / 1.0));
      for (let i = 0; i < nSide; i++) {
        sideZs.push(nSide === 1 ? 0 : lerp(-d / 2 + 0.55, d / 2 - 0.55, i / (nSide - 1)));
      }
      for (let f = 0; f < floors; f++) {
        const wy = 1.92 + f * 1.28;
        const balcony = (f === 0 || f === 2) && rr() > 0.2;
        for (const wx of winXs) windowZ(1, wx, wy, balcony);
        // rear facade keeps the silhouette believable from an orbiting camera
        for (const wx of winXs) windowZ(-1, wx, wy, false);
        for (const wz of sideZs) {
          windowX(1, wz, wy, balcony && rr() > 0.4);
          windowX(-1, wz, wy, false);
        }
      }

      // ground-floor shops and awnings
      const shopN = Math.max(2, Math.round(w / 2.1));
      for (let i = 0; i < shopN; i++) {
        const lx = shopN === 1 ? 0 : lerp(-w / 2 + 0.75, w / 2 - 0.75, i / (shopN - 1));
        const shopW = Math.min(1.15, (w - 1.1) / shopN - 0.15);
        add('darkwood', lx, 0.88, d / 2 + 0.03, shopW + 0.09, 1.18, 0.08, C(0x4f3a28));
        if (rr() < 0.3) add('lamp', lx, 0.91, d / 2 + 0.075, shopW, 1.02, 0.03, new THREE.Color(1.5, 0.73, 0.27));
        else add('glass', lx, 0.91, d / 2 + 0.075, shopW, 1.02, 0.03, C(0x27373c));
        // striped awning
        const awningCol = C(AWNING_PALETTE[Math.floor(rr() * AWNING_PALETTE.length)]);
        const stripeW = shopW / 3;
        for (let s = 0; s < 3; s++) {
          add('fabric', lx - shopW / 2 + stripeW * (s + 0.5), 1.48, d / 2 + 0.31,
            stripeW - 0.015, 0.07, 0.55, s % 2 === 0 ? awningCol : C(0xeee1c7));
        }
        add('wood', lx, 1.42, d / 2 + 0.03, shopW + 0.12, 0.09, 0.12, C(0x5b432d));
      }
      // front door and lamp over the entrance
      add('darkwood', winXs[Math.floor(winXs.length / 2)], 1.0, d / 2 + 0.025, 0.5, 1.5, 0.08, C(0x403021));
      add('ironDull', winXs[Math.floor(winXs.length / 2)] + 0.4, 2.15, d / 2 + 0.18, 0.05, 0.35, 0.05, C(0x25261f));
      add('lamp', winXs[Math.floor(winXs.length / 2)] + 0.4, 2.06, d / 2 + 0.2, 0.14, 0.2, 0.14, new THREE.Color(1.1, 0.72, 0.33));

      // mansard roof, stepped like layered zinc
      // mansard roof with four real sloped zinc faces
      const roofRise = 1.15 + rr() * 0.22;
      const runZ = Math.min(d * 0.34, 1.05);
      const runX = Math.min(w * 0.17, 0.9);
      const slopeZ = Math.hypot(runZ, roofRise);
      const slopeX = Math.hypot(runX, roofRise);
      const angleZ = Math.atan2(roofRise, runZ);
      const angleX = Math.atan2(roofRise, runX);
      const eaveY = h + 0.16;
      const roofShade = roof.clone().multiplyScalar(0.95);
      add('stone', 0, h + 0.07, 0, w + 0.36, 0.16, d + 0.36, trim.clone().multiplyScalar(0.86));
      add('zinc', 0, eaveY + 0.02, 0, w + 0.28, 0.18, d + 0.28, roofShade);
      // front / back
      addRot('zinc', 0, eaveY + roofRise / 2, d / 2 - runZ / 2, w + 0.16, 0.13, slopeZ,
        roof.clone().multiplyScalar(1.03), angleZ, 0);
      addRot('zinc', 0, eaveY + roofRise / 2, -d / 2 + runZ / 2, w + 0.16, 0.13, slopeZ,
        roof.clone().multiplyScalar(0.84), -angleZ, 0);
      // side slopes
      addRot('zinc', w / 2 - runX / 2, eaveY + roofRise / 2, 0, slopeX, 0.13, d - 0.05,
        roof.clone().multiplyScalar(0.94), 0, angleX);
      addRot('zinc', -w / 2 + runX / 2, eaveY + roofRise / 2, 0, slopeX, 0.13, d - 0.05,
        roof.clone().multiplyScalar(0.78), 0, -angleX);
      // flat cap / ridge
      add('zinc', 0, eaveY + roofRise + 0.01, 0, Math.max(0.6, w - runX * 2), 0.15,
        Math.max(0.6, d - runZ * 2), roof.clone().multiplyScalar(1.06));
      add('ironDull', 0, eaveY + roofRise + 0.11, 0, Math.max(0.3, w - runX * 2 - 0.25), 0.05,
        0.12, C(0x2b2b28));
      // zinc seams down the lit front slope
      for (let i = 0; i < 4; i++) {
        const lx = lerp(-w / 2 + 0.6, w / 2 - 0.6, i / 3);
        addRot('zinc', lx, eaveY + roofRise / 2, d / 2 - runZ / 2 + 0.025,
          0.035, 0.16, slopeZ * 0.97, roof.clone().multiplyScalar(0.7), angleZ, 0);
      }
      // roof dormers
      const dormN = Math.max(1, Math.round(w / 2.4));
      for (let i = 0; i < dormN; i++) {
        const lx = dormN === 1 ? 0 : lerp(-w / 2 + 1.1, w / 2 - 1.1, i / (dormN - 1));
        const dz = d / 2 - runZ * 0.45;
        const dy = eaveY + roofRise * 0.45;
        add('zinc', lx, dy + 0.08, dz, 0.52, 0.66, 0.42, roof.clone().multiplyScalar(1.18));
        add('glass', lx, dy + 0.08, dz + 0.23, 0.26, 0.31, 0.04, C(0x26373c));
        add('zinc', lx, dy + 0.43, dz, 0.62, 0.1, 0.52, roof.clone().multiplyScalar(0.76));
        add('stone', lx, dy - 0.19, dz + 0.17, 0.48, 0.08, 0.2, trim);
      }
      // chimney stacks and pots
      const chimN = 2 + Math.floor(rr() * 2);
      for (let i = 0; i < chimN; i++) {
        const lx = lerp(-w / 2 + 0.65, w / 2 - 0.65, (i + 0.3 + rr() * 0.4) / chimN);
        const lz = -d / 2 + 0.5 + rr() * (d - 1.0);
        const chH = 0.75 + rr() * 0.55;
        const baseY = eaveY + roofRise + 0.05;
        add('stone', lx, baseY + chH / 2, lz, 0.36, chH, 0.52, trim.clone().multiplyScalar(0.9));
        add('stone', lx, baseY + chH, lz, 0.46, 0.09, 0.62, trim.clone().multiplyScalar(0.75));
        add('earth', lx - 0.1, baseY + chH + 0.13, lz, 0.11, 0.24, 0.11, C(0x8b5e48));
        add('earth', lx + 0.1, baseY + chH + 0.1, lz + 0.08, 0.1, 0.2, 0.1, C(0x956951));
        if (i === 0) {
          const smokeX = cx + lx * cos + lz * sin;
          const smokeZ = cz - lx * sin + lz * cos;
          smokeSources.push(new THREE.Vector3(smokeX, baseY + chH + 0.2, smokeZ));
        }
      }
      // occasional tricolour over a door
      if (rr() > 0.74) {
        const flagX = -w / 2 + 0.85;
        const fz = d / 2 + 0.44;
        add('ironDull', flagX, 2.7, fz, 0.045, 1.6, 0.045, C(0x2f302a));
        const flagCols = [0x2c4a78, 0xeee7d7, 0x9a3c3d];
        for (let k = 0; k < 3; k++) {
          add('fabric', flagX + 0.2 + k * 0.15, 3.05, fz, 0.15, 0.62, 0.035, C(flagCols[k]));
        }
      }
    }

    // back row
    (() => {
      let x = -24.4;
      let i = 0;
      while (x < 24.2) {
        const w = rand(4.3, 6.6);
        if (x + w > 24.5) break;
        const height = rand(6.3, 8.25);
        addHaussmann(x + w / 2, -15.15, w, 3.25, height, 0, 500 + i * 17);
        x += w + rand(0.16, 0.48);
        i++;
      }
    })();
    // left and right rows facing the Champ de Mars
    (() => {
      let z = -10.2;
      let i = 0;
      while (z < 6.1) {
        const w = rand(4.7, 6.5);
        if (z + w > 7.5) break;
        const h = rand(5.7, 7.4);
        addHaussmann(-22.9, z + w / 2, w, 3.15, h, Math.PI / 2, 900 + i * 23);
        addHaussmann(22.9, z + w / 2, w, 3.15, rand(5.8, 7.6), -Math.PI / 2, 1300 + i * 29);
        z += w + rand(0.2, 0.55);
        i++;
      }
    })();

    // ============================================================
    //  TREES, LAMPS, LITTLE STREET THINGS
    // ============================================================
    function addTree(x, z, s, seed) {
      s = s || 1;
      const rr = mulberry32(seed || Math.floor(hash2(x, z) * 100000) + 1);
      const trunkH = (1.05 + rr() * 0.5) * s;
      addBox('darkwood', x, trunkH / 2 + 0.02, z, 0.15 * s, trunkH, 0.15 * s, C(0x4d3b29));
      // ground saucer
      addBox('foliage', x, 0.03, z, 1.45 * s, 0.05, 1.45 * s, C(0x5f6b42, 0.7));
      const greenPal = [0x505a37, 0x5b6541, 0x46512f, 0x616a48, 0x4a5536, 0x68704c];
      const blobs = 4 + Math.floor(rr() * 3);
      for (let i = 0; i < blobs; i++) {
        const a = rr() * TAU;
        const r = rr() * 0.52 * s;
        const bx = x + Math.cos(a) * r;
        const bz = z + Math.sin(a) * r;
        const by = trunkH + (0.35 + rr() * 0.75) * s;
        const sz = (0.55 + rr() * 0.5) * s;
        addBox('foliage', bx, by, bz, sz, sz * (0.78 + rr() * 0.25), sz,
          C(greenPal[Math.floor(rr() * greenPal.length)], 0.85 + rr() * 0.25));
      }
      // a bright sun-caught crown
      addBox('foliage', x + 0.2 * s, trunkH + 1.2 * s, z - 0.15 * s, 0.6 * s, 0.5 * s, 0.6 * s,
        C(0x70794f, 0.98));
    }

    const treeRows = [];
    for (let x = -21.5; x <= 23; x += 4.1) {
      const z = nearBankZ(x) + 3.0;
      if (Math.abs(x - BRIDGE.x) < BRIDGE.width / 2 + 3.2) continue;
      if (x > 0.8 && x < 10.8) continue;
      treeRows.push([x, z, 0.82]);
    }
    for (let z = -9.4; z <= 6.0; z += 3.3) {
      treeRows.push([-18.2, z, 0.9]);
      treeRows.push([17.4, z, 0.9]);
    }
    for (let x = -24; x <= 24; x += 3.8) {
      if (x > -12.8 && x < 8.2) continue;
      treeRows.push([x, -12.75, 0.85]);
    }
    for (let z = -8.8; z <= 5.5; z += 4.5) {
      treeRows.push([-24.8, z, 0.8]);
      treeRows.push([24.8, z, 0.8]);
    }
    for (const [x, z, s] of treeRows) {
      if (z > 6.4 && Math.abs(x - BRIDGE.x) < BRIDGE.width / 2 + 3.2) continue;
      addTree(x, z, s, Math.floor((x + 40) * 173 + (z + 30) * 331));
    }

    // benches & bollards on the quay
    function addBench(x, z, angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      for (let i = -1; i <= 1; i++) {
        addBox('wood', x + s * i * 0.32, 0.36, z - c * i * 0.32, 1.35, 0.09, 0.16, C(0x765637));
      }
      addBox('ironDull', x - c * 0.5, 0.18, z - s * 0.5, 0.1, 0.36, 0.1, C(0x2a2b26));
      addBox('ironDull', x + c * 0.5, 0.18, z + s * 0.5, 0.1, 0.36, 0.1, C(0x2a2b26));
      addBox('wood', x + s * 0.7, 0.7, z - c * 0.7, 1.35, 0.1, 0.2, C(0x6e5134));
    }
    for (let x = -19; x < 22; x += 8.8) {
      if (Math.abs(x - BRIDGE.x) < BRIDGE.width / 2 + 2.4) continue;
      if (x > 0.5 && x < 11.0) continue;
      addBench(x, nearBankZ(x) + 2.7, 0.06 * x);
    }

    // street bollards / tree guards
    for (let x = -20; x <= 20; x += 4.2) {
      for (const side of [-1, 1]) {
        const z = nearBankZ(x) + side * 0.85;
        addBox('ironDull', x, 0.15, z, 0.08, 0.26, 0.08, C(0x30302b));
      }
    }

    // distant kiosks and a little café on the promenade
    function addKiosk(x, z, seed, color) {
      const rr = mulberry32(seed);
      addBox('wood', x, 0.7, z, 1.1, 1.3, 1.0, C(0x6f5035));
      addBox('wood', x, 1.42, z, 1.5, 0.25, 1.4, C(color || 0x4f5b48));
      addBox('glass', x, 0.9, z + 0.52, 0.7, 0.65, 0.05, C(0x3d4c49));
      addBox('ironDull', x, 1.72, z, 0.06, 0.45, 0.06, C(0x2c2d28));
      addBox('fabric', x + 0.2, 1.84, z, 0.5, 0.18, 0.04, C(0xd8c79f));
    }
    addKiosk(-15.2, nearBankZ(-15.2) + 1.4, 88, 0x5d4b39);
    addKiosk(16.4, nearBankZ(16.4) + 2.1, 121, 0x394c46);

    // ============================================================
    //  TINY VOXEL PEOPLE — STATIC CROWDS
    // ============================================================
    const COAT_COLS = [0x39424c, 0x4b4339, 0x574033, 0x3e4a42, 0x68513c, 0x333842,
      0x7a6a54, 0x554a5a, 0x46504d, 0x8a7b64, 0x60544a, 0x4a5661];
    const DRESS_COLS = [0x7c5360, 0x516274, 0x76664f, 0x5d6953, 0x886a57, 0x685c74,
      0x916c68, 0x6a7c70, 0x866151, 0x6e5a50, 0x8b7460];
    const TROUSER_COLS = [0x24262a, 0x342d25, 0x2b3036, 0x3b3530];
    const SKIN_COLS = [0xe6b58f, 0xcf946d, 0xb67d59, 0xf0c6a2, 0x9f6b4c, 0xdca27a];
    const HAT_COLS = [0x16171a, 0x1d1915, 0x24242a, 0x2c241c, 0x302c28];
    const PARASOL_COLS = [0xf1e2c6, 0xd9b7b0, 0xc3d1d0, 0xe9cf9e, 0xe2c4b3, 0xc9c1d2];
    const APRON_COLS = [0xd8cfbc, 0xc8bda8, 0xefe6d5];
    const CAP_COLS = [0x293548, 0x3b3f3e, 0x6d5940, 0x31423b];

    function addStaticPerson(x, z, baseY, facing, scale, seed, worker) {
      const rr = mulberry32(seed);
      scale = (scale || 1) * (0.92 + rr() * 0.16);
      const q = new THREE.Quaternion().setFromAxisAngle(_yAxis, facing || 0);
      const cos = Math.cos(facing || 0), sin = Math.sin(facing || 0);
      function part(batch, lx, ly, lz, sx, sy, sz, col) {
        const wx = x + lx * cos + lz * sin;
        const wz = z - lx * sin + lz * cos;
        batches[batch].add(wx, baseY + ly * scale, wz, sx * scale, sy * scale, sz * scale, col, q);
      }
      const female = !worker && rr() < 0.38;
      const skin = C(SKIN_COLS[Math.floor(rr() * SKIN_COLS.length)]);
      if (worker) {
        const coat = C(CAP_COLS[Math.floor(rr() * CAP_COLS.length)]);
        const apron = C(APRON_COLS[Math.floor(rr() * APRON_COLS.length)]);
        part('fabric', -0.075, 0.17, 0, 0.11, 0.34, 0.15, C(0x2b3033));
        part('fabric', 0.075, 0.17, 0, 0.11, 0.34, 0.15, C(0x2b3033));
        part('fabric', 0, 0.57, 0, 0.4, 0.42, 0.25, apron);
        part('fabric', 0, 0.56, 0.09, 0.34, 0.35, 0.12, coat);
        part('skin', 0, 0.94, 0, 0.24, 0.24, 0.24, skin);
        part('fabric', 0, 1.1, 0, 0.27, 0.1, 0.27, coat);
        part('fabric', 0, 1.17, 0, 0.17, 0.08, 0.17, coat.clone().multiplyScalar(0.8));
        return;
      }
      if (female) {
        const dress = C(DRESS_COLS[Math.floor(rr() * DRESS_COLS.length)]);
        part('fabric', 0, 0.24, 0, 0.42, 0.38, 0.3, dress);
        part('fabric', 0, 0.47, 0, 0.5, 0.12, 0.36, dress.clone().multiplyScalar(0.88));
        part('fabric', 0, 0.67, 0, 0.32, 0.36, 0.23, dress.clone().multiplyScalar(1.06));
        part('fabric', 0, 0.77, 0.14, 0.28, 0.15, 0.06, C(0xeee5d3));
        part('skin', 0, 0.95, 0, 0.22, 0.23, 0.22, skin);
        // bonnet / small hat
        part('fabric', 0, 1.1, -0.02, 0.31, 0.13, 0.3, C(HAT_COLS[Math.floor(rr() * HAT_COLS.length)]));
        if (rr() < 0.52) {
          const pc = C(PARASOL_COLS[Math.floor(rr() * PARASOL_COLS.length)]);
          part('darkwood', 0.3, 0.84, 0.02, 0.025, 0.95, 0.025, C(0x3b2a1d));
          part('fabric', 0.3, 1.34, 0.02, 0.74, 0.055, 0.74, pc);
          part('fabric', 0.3, 1.31, 0.02, 0.64, 0.06, 0.64, pc.clone().multiplyScalar(0.84));
          part('fabric', 0.3, 1.2, 0.02, 0.06, 0.22, 0.06, pc);
        }
      } else {
        const coat = C(COAT_COLS[Math.floor(rr() * COAT_COLS.length)]);
        const trousers = C(TROUSER_COLS[Math.floor(rr() * TROUSER_COLS.length)]);
        part('fabric', -0.075, 0.18, 0, 0.12, 0.36, 0.15, trousers);
        part('fabric', 0.075, 0.18, 0, 0.12, 0.36, 0.15, trousers);
        part('fabric', 0, 0.58, 0, 0.4, 0.42, 0.25, coat);
        part('fabric', 0, 0.55, 0.08, 0.31, 0.34, 0.13, coat.clone().multiplyScalar(0.83));
        part('fabric', -0.23, 0.58, 0, 0.09, 0.3, 0.12, coat.clone().multiplyScalar(0.9));
        part('fabric', 0.23, 0.58, 0, 0.09, 0.3, 0.12, coat.clone().multiplyScalar(0.9));
        part('skin', 0, 0.94, 0, 0.23, 0.24, 0.23, skin);
        const hat = C(HAT_COLS[Math.floor(rr() * HAT_COLS.length)]);
        if (rr() < 0.5) {
          part('fabric', 0, 1.1, 0, 0.3, 0.055, 0.3, hat);
          part('fabric', 0, 1.22, 0, 0.19, 0.21, 0.19, hat);
        } else {
          part('fabric', 0, 1.09, 0, 0.26, 0.08, 0.28, hat);
          part('fabric', 0, 1.13, 0.08, 0.2, 0.03, 0.12, hat.clone().multiplyScalar(1.3));
        }
      }
    }

    // Fill the quays, bridge and boulevard with onlookers.
    (() => {
      let placed = 0;
      let guard = 0;
      const targetNear = 136;
      while (placed < targetNear && guard < 1700) {
        guard++;
        const x = rand(-23.5, 23.5);
        if (Math.abs(x - BRIDGE.x) < BRIDGE.width / 2 + 2.6) continue;
        const nz = nearBankZ(x);
        // keep a lower, back-of-quay window open so the river traffic is visible
        const openView = x > 0.5 && x < 10.8;
        const z = openView ? rand(nz + 2.9, 16.8) : rand(nz + 1.55, 16.8);
        if (!insideIsland(x, z, 0.03)) continue;
        addStaticPerson(x, z, 0.08, rand(0, TAU), rand(0.9, 1.1), 10000 + placed * 13, false);
        placed++;
      }
      placed = 0; guard = 0;
      while (placed < 82 && guard < 1200) {
        guard++;
        const x = rand(-22, 22);
        if (Math.abs(x - BRIDGE.x) < BRIDGE.width / 2 + 2.6) continue;
        const fz = farBankZ(x);
        const z = rand(fz - 1.35, fz - 0.2);
        if (!insideIsland(x, z, 0.03)) continue;
        addStaticPerson(x, z, 0.08, rand(0, TAU), rand(0.9, 1.1), 20000 + placed * 17, false);
        placed++;
      }
      // bridge onlookers
      for (let i = 0; i < 4; i++) {
        const x = BRIDGE.x + (i % 2 === 0 ? -1.6 : 1.6) + rand(-0.15, 0.15);
        const z = rand(BRIDGE.z0 + 1.1, BRIDGE.z1 - 1.1);
        addStaticPerson(x, z, BRIDGE.deckTopAt(z) + 0.05, rand(0, TAU), rand(0.86, 1.0), 30000 + i * 31, false);
      }
      // workers in the Champ de Mars yard
      placed = 0; guard = 0;
      while (placed < 32 && guard < 600) {
        guard++;
        const x = rand(-13.8, 14.5);
        const z = rand(0.2, 7.1);
        if (x > 4.4 && x < 11.5 && z > 7.0) continue;
        addStaticPerson(x, z, 0.08, rand(0, TAU), rand(0.86, 1.0), 40000 + placed * 23, true);
        placed++;
      }
      // strollers along the boulevard
      placed = 0; guard = 0;
      while (placed < 36 && guard < 500) {
        guard++;
        const side = rng() > 0.5 ? -1 : 1;
        const x = side * rand(17.2, 19.4);
        const z = rand(-10.2, 7.2);
        addStaticPerson(x, z, 0.08, rand(0, TAU), rand(0.88, 1.05), 50000 + placed * 19, false);
        placed++;
      }
      // little seated/standing groups by the bridge and lamps
      for (let i = 0; i < 16; i++) {
        const x = rand(-20, 20);
        if (Math.abs(x - BRIDGE.x) < BRIDGE.width / 2 + 2.8) continue;
        if (x > 0.5 && x < 10.8) continue;
        const z = nearBankZ(x) + rand(0.25, 0.7);
        addStaticPerson(x, z, 0.12, rand(0, TAU), rand(0.86, 1.02), 60000 + i * 37, false);
      }
      // a loose line of onlookers leaning on the far railing of the open quay
      for (let i = 0; i < 10; i++) {
        const x = rand(1.6, 9.8);
        const z = nearBankZ(x) + rand(3.1, 3.7);
        addStaticPerson(x, z, 0.08, rand(0, TAU), rand(0.9, 1.02), 61000 + i * 29, false);
      }
      // construction workers on the first platform and scaffolding decks
      const firstY = TOWER.platform1 + 0.18;
      for (let i = 0; i < 9; i++) {
        const a = rng() * TAU;
        const r = 0.8 + rng() * 3.2;
        addStaticPerson(TOWER.cx + Math.cos(a) * r, TOWER.cz + Math.sin(a) * r, firstY, rand(0, TAU), rand(0.8, 0.95), 70000 + i * 41, true);
      }
    })();

    // ============================================================
    //  RIVETING STATIONS (wooden catwalk planks are static scenery)
    // ============================================================
    const RIVET_STATIONS = [
      // first platform, finished deck
      { x: TOWER.cx - 2.55, y: TOWER.platform1 + 0.2, z: TOWER.cz + 4.45, yaw: 0.12, level: 'p1' },
      { x: TOWER.cx + 4.28, y: TOWER.platform1 + 0.2, z: TOWER.cz - 1.55, yaw: -1.45, level: 'p1' },
      { x: TOWER.cx - 3.75, y: TOWER.platform1 + 0.2, z: TOWER.cz - 3.7, yaw: 2.65, level: 'p1' },
      // half-built second level
      { x: TOWER.cx - 1.6, y: TOWER.platform2 + 0.15, z: TOWER.cz + 1.5, yaw: 0.15, level: 'p2' },
      { x: TOWER.cx - 0.6, y: TOWER.platform2 + 0.15, z: TOWER.cz - 2.3, yaw: 3.0, level: 'p2' },
      // scaffold decks around the legs
      { x: -9.95, y: 6.32, z: 2.22, yaw: 0.15, level: 'scaffold' },
      { x: 3.25, y: 6.32, z: 2.18, yaw: -0.2, level: 'scaffold' },
      // temporary planks high on the skeleton
      { x: TOWER.cx - 0.9, y: 16.82, z: -3.36, yaw: 0.04, level: 'high' },
      { x: TOWER.cx + 0.4, y: 20.98, z: -4.02, yaw: 3.11, level: 'high' },
      { x: TOWER.cx - 2.6, y: 3.42, z: TOWER.cz + 6.15, yaw: 2.9, level: 'base' },
    ];
    // wooden catwalk planks for the high stations
    for (const st of RIVET_STATIONS) {
      if (st.level === 'high') {
        addBox('wood', st.x - 0.55, st.y - 0.13, st.z, 2.0, 0.12, 1.25, C(0x9a724b));
        addBox('ironDull', st.x - 1.45, st.y - 0.1, st.z, 0.12, 0.16, 1.3, C(0x3a2a20));
        addBox('ironDull', st.x + 0.35, st.y - 0.1, st.z, 0.12, 0.16, 1.3, C(0x3a2a20));
        addBeam('iron', st.x - 1.4, st.y - 0.18, st.z - 0.5, st.x - 2.2, st.y - 1.4, st.z - 0.4, 0.06, C(0x5c3a2a));
        addBeam('iron', st.x - 1.4, st.y - 0.18, st.z + 0.5, st.x - 2.2, st.y - 1.4, st.z + 0.4, 0.06, C(0x5c3a2a));
      }
    }

    // ============================================================
    //  BUILD STATIC BATCHES
    // ============================================================
    for (const key of Object.keys(batches)) batches[key].build(scene);

    // ============================================================
    //  MATERIAL HELPERS FOR ANIMATED PIECES
    // ============================================================
    const _solidCache = new Map();
    function solidMat(hex, rough, metal) {
      rough = rough === undefined ? 0.82 : rough;
      metal = metal === undefined ? 0.0 : metal;
      const key = hex + '|' + rough + '|' + metal;
      let m = _solidCache.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          color: C(hex), roughness: rough, metalness: metal, envMapIntensity: 0.32,
        });
        _solidCache.set(key, m);
      }
      return m;
    }
    function meshBox(parent, mat, x, y, z, sx, sy, sz, rx, ry, rz, geo) {
      const mesh = new THREE.Mesh(geo || voxelGeo, mat);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      if (rx || ry || rz) mesh.rotation.set(rx || 0, ry || 0, rz || 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    }
    const cableGeo = new THREE.CylinderGeometry(0.072, 0.072, 1, 5);
    const wheelGeo = new THREE.CylinderGeometry(1, 1, 0.28, 12, 1);
    wheelGeo.rotateX(Math.PI / 2);
    function beamMesh(parent, mat, ax, ay, az, bx, by, bz, thick) {
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      const dir = new THREE.Vector3(dx, dy, dz).normalize();
      mesh.quaternion.setFromUnitVectors(_yAxis, dir);
      mesh.scale.set(thick, len, thick);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    }

    // ============================================================
    //  CREEPER CRANES ON THE TOWER
    // ============================================================
    const craneWood = solidMat(0x7b5838, 0.86, 0.0);
    const craneWoodLight = solidMat(0x9a7148, 0.8, 0.0);
    const craneIron = solidMat(0x38271e, 0.55, 0.34);
    const craneCable = solidMat(0x1c1916, 0.55, 0.2);
    const craneLoad = solidMat(0x4d2a1b, 0.6, 0.25);
    const cranes = [];

    function createCreeperCrane(cfg) {
      const group = new THREE.Group();
      group.position.set(cfg.x, cfg.y, cfg.z);
      group.rotation.y = cfg.yaw;
      group.scale.setScalar(cfg.scale || 1);
      const mastH = cfg.mastH || 2.25;
      // bolted wooden/iron creeper base
      meshBox(group, craneIron, 0, 0.08, 0, 1.45, 0.16, 1.15, 0, 0, 0);
      meshBox(group, craneWood, 0, 0.18, 0, 0.8, 0.12, 0.72, 0, 0, 0);
      meshBox(group, craneWood, 0, mastH / 2 + 0.14, 0, 0.19, mastH, 0.19);
      beamMesh(group, craneWood, -0.62, 0.2, -0.38, 0, mastH + 0.1, 0, 0.075);
      beamMesh(group, craneWood, 0.62, 0.2, -0.38, 0, mastH + 0.1, 0, 0.075);
      beamMesh(group, craneWood, -0.62, 0.2, 0.38, 0, mastH + 0.1, 0, 0.075);
      beamMesh(group, craneWood, 0.62, 0.2, 0.38, 0, mastH + 0.1, 0, 0.075);
      // small creeper cradle at the top
      meshBox(group, craneIron, 0, mastH + 0.08, 0, 0.48, 0.2, 0.46);
      const jib = new THREE.Group();
      jib.position.y = mastH + 0.1;
      group.add(jib);
      const jibLen = cfg.jibLen || 3.15;
      // main arm, slightly stepped
      meshBox(jib, craneWood, jibLen * 0.5, 0.1, 0, jibLen, 0.14, 0.18);
      meshBox(jib, craneWood, jibLen * 0.5, -0.16, 0, jibLen * 0.84, 0.1, 0.12);
      for (let i = 1; i <= 4; i++) {
        const x = (i / 5) * jibLen;
        const h = 0.26 + 0.2 * Math.sin(i * 1.8);
        beamMesh(jib, craneWoodLight, x, -0.15, -0.1, x, h, -0.1, 0.055);
        beamMesh(jib, craneWoodLight, x, h, -0.1, x + jibLen / 5, -0.15, -0.1, 0.04);
      }
      // counterweight
      meshBox(jib, craneWood, -0.85, -0.06, 0, 1.3, 0.16, 0.2);
      meshBox(jib, craneIron, -1.15, -0.3, 0, 0.5, 0.55, 0.5, 0, 0, 0);
      // little operator cage
      meshBox(jib, craneIron, 0.42, 0.2, 0, 0.44, 0.42, 0.44);
      meshBox(jib, solidMat(0xc9a676, 0.6, 0.1), 0.42, 0.31, 0.23, 0.24, 0.17, 0.05);
      // tie ropes
      beamMesh(jib, craneCable, 0, 0.35, 0, jibLen * 0.4, 0.22, 0, 0.025);
      beamMesh(jib, craneCable, 0, 0.35, 0, jibLen * 0.82, 0.16, 0, 0.022);
      // hoist at the tip
      meshBox(jib, craneIron, jibLen, 0.0, 0, 0.22, 0.2, 0.24);
      const hoist = new THREE.Group();
      hoist.position.set(jibLen + 0.05, -0.1, 0);
      jib.add(hoist);
      const cable = new THREE.Mesh(cableGeo, craneCable);
      cable.castShadow = false;
      hoist.add(cable);
      const load = new THREE.Group();
      hoist.add(load);
      // suspended iron girder
      const glen = cfg.loadLen || 2.0;
      meshBox(load, craneLoad, 0, -0.05, 0, glen, 0.12, 0.44);
      meshBox(load, craneLoad, 0, -0.3, 0, glen * 0.94, 0.1, 0.14);
      meshBox(load, craneLoad, 0, -0.05, 0, glen * 0.08, 0.42, 0.14);
      meshBox(load, craneLoad, -glen * 0.38, 0.1, 0, 0.12, 0.2, 0.4);
      meshBox(load, craneIron, 0, 0.14, 0, 0.2, 0.18, 0.18);
      meshBox(load, solidMat(0x9c7d4b, 0.35, 0.65), 0, 0.3, 0, 0.1, 0.2, 0.1);
      // French pennant on the mast
      const flagPole = meshBox(group, craneIron, 0.23, mastH + 0.65, 0, 0.035, 1.1, 0.035);
      meshBox(group, solidMat(0x2c4b77, 0.9, 0), 0.46, mastH + 1.05, 0, 0.42, 0.14, 0.03);
      meshBox(group, solidMat(0xeee8d7, 0.9, 0), 0.46, mastH + 0.91, 0, 0.42, 0.14, 0.03);
      meshBox(group, solidMat(0x9e3d3e, 0.9, 0), 0.46, mastH + 0.77, 0, 0.42, 0.14, 0.03);

      let cableLen = cfg.cable || 1.4;
      function setCable(len) {
        cable.scale.y = len;
        cable.position.y = -len / 2;
        load.position.y = -len - 0.12;
      }
      setCable(cableLen);
      const phase = cfg.phase || 0;
      const baseJib = cfg.baseJib || 0;
      onFrame((t) => {
        jib.rotation.y = baseJib + Math.sin(t * 0.235 + phase) * 0.52;
        const tgt = (cfg.cable || 1.4) + Math.sin(t * 0.31 + phase * 1.7) * 0.38;
        cableLen = tgt;
        setCable(cableLen);
        hoist.rotation.z = Math.sin(t * 0.72 + phase) * 0.035;
        load.rotation.y = Math.sin(t * 0.4 + phase) * 0.25;
        load.rotation.z = Math.sin(t * 0.58 + phase) * 0.03;
        flagPole.rotation.y = Math.sin(t * 0.7 + phase) * 0.03;
      });
      group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      scene.add(group);
      cranes.push(group);
      return group;
    }

    createCreeperCrane({
      x: TOWER.cx + 3.7, y: TOWER.platform1 + 0.22, z: TOWER.cz + 3.6,
      yaw: -0.75, scale: 0.9, mastH: 2.3, jibLen: 3.3, cable: 1.55, phase: 0.2, baseJib: 0.45,
    });
    createCreeperCrane({
      x: TOWER.cx - 3.8, y: TOWER.platform1 + 0.22, z: TOWER.cz + 1.8,
      yaw: 1.5, scale: 0.82, mastH: 2.15, jibLen: 3.0, cable: 1.75, phase: 2.1, baseJib: -0.4,
    });
    createCreeperCrane({
      x: TOWER.cx - 2.0, y: TOWER.platform2 + 0.17, z: TOWER.cz + 2.1,
      yaw: -2.35, scale: 0.72, mastH: 1.9, jibLen: 2.7, cable: 1.3, phase: 3.7, baseJib: 0.2,
    });
    // a tiny crane working the bare iron near the crown
    createCreeperCrane({
      x: TOWER.cx + 1.0, y: 19.3, z: TOWER.cz + 1.1,
      yaw: -0.35, scale: 0.58, mastH: 1.55, jibLen: 2.2, cable: 1.7, phase: 4.9, baseJib: 0.9,
    });
    // a big timber derrick in the yard, swinging a girder toward the tower
    createCreeperCrane({
      x: 7.4, y: 0.04, z: 4.35,
      yaw: -1.2, scale: 1.85, mastH: 3.65, jibLen: 4.6, cable: 3.0, phase: 3.2, baseJib: 0.5,
    });

    // ============================================================
    //  STEAM ENGINE IN THE YARD
    // ============================================================
    const engine = new THREE.Group();
    engine.position.set(9.8, 0.02, 3.05);
    engine.rotation.y = -0.18;
    const engineIron = solidMat(0x312a25, 0.46, 0.5);
    const engineDark = solidMat(0x24211e, 0.6, 0.32);
    const engineBrass = solidMat(0x9d7a45, 0.3, 0.8);
    const engineRed = solidMat(0x743b2c, 0.58, 0.25);
    const engineWood = solidMat(0x654b32, 0.8, 0.0);
    // skids
    meshBox(engine, engineWood, 0, 0.12, -0.6, 2.9, 0.18, 0.28);
    meshBox(engine, engineWood, 0, 0.12, 0.6, 2.9, 0.18, 0.28);
    // boiler
    const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 2.2, 10, 1), engineIron);
    boiler.rotation.z = Math.PI / 2;
    boiler.position.set(0.15, 0.94, 0);
    boiler.castShadow = true; boiler.receiveShadow = true;
    engine.add(boiler);
    // boiler bands
    for (const bx of [-0.6, 0.0, 0.62]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.545, 0.545, 0.09, 10, 1), engineBrass);
      band.rotation.z = Math.PI / 2; band.position.set(bx, 0.94, 0); band.castShadow = true;
      engine.add(band);
    }
    meshBox(engine, engineRed, -1.26, 0.93, 0, 0.32, 0.92, 0.86);
    meshBox(engine, engineDark, -1.46, 0.94, 0, 0.1, 0.7, 0.62);
    meshBox(engine, solidMat(0xc96a2e, 0.7, 0.2), -1.51, 0.63, 0, 0.04, 0.2, 0.3);
    // chimney
    meshBox(engine, engineDark, 0.95, 1.45, 0, 0.42, 0.8, 0.42);
    meshBox(engine, engineRed, 0.95, 1.91, 0, 0.31, 0.25, 0.31);
    meshBox(engine, engineDark, 0.95, 2.13, 0, 0.5, 0.1, 0.5);
    // tall chimney extension so the plume reads above the yard
    meshBox(engine, engineDark, 0.95, 2.55, 0, 0.34, 0.84, 0.34);
    meshBox(engine, engineRed, 0.95, 3.01, 0, 0.4, 0.18, 0.4);
    meshBox(engine, engineDark, 0.95, 3.14, 0, 0.24, 0.12, 0.24);
    // steam dome and whistle
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.42, 10, 1), engineBrass);
    dome.position.set(-0.35, 1.47, 0); dome.castShadow = true; engine.add(dome);
    meshBox(engine, engineBrass, 0.28, 1.52, 0, 0.08, 0.34, 0.08);
    // cowcatcher / front
    for (let i = 0; i < 4; i++) {
      meshBox(engine, engineIron, 1.45 - i * 0.16, 0.5 - i * 0.08, 0, 0.1, 0.42, 1.0, 0, 0, -0.45);
    }
    // flywheel
    const fly = new THREE.Group();
    fly.position.set(-0.15, 0.8, 0.72);
    engine.add(fly);
    const flyRim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.075, 5, 18), engineDark);
    flyRim.castShadow = true; fly.add(flyRim);
    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.Mesh(voxelGeo, engineBrass);
      spoke.scale.set(0.09, 1.14, 0.09);
      spoke.position.set(0, 0, 0);
      spoke.rotation.z = i * Math.PI / 5;
      spoke.castShadow = true;
      fly.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.18, 8), engineBrass);
    hub.rotation.x = Math.PI / 2; fly.add(hub);
    // wheels/axles
    for (const wx of [-0.85, 0.85]) {
      for (const wz of [-0.69, 0.69]) {
        const wheel = new THREE.Mesh(wheelGeo, engineDark);
        wheel.scale.set(0.34, 0.34, 1);
        wheel.position.set(wx, 0.36, wz);
        wheel.castShadow = true;
        engine.add(wheel);
      }
    }
    // pipes and gauges
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6), engineBrass);
    pipe.rotation.z = 0.3; pipe.position.set(0.7, 1.4, 0.3); pipe.castShadow = true; engine.add(pipe);
    const gauge = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 10), engineBrass);
    gauge.rotation.x = Math.PI / 2; gauge.position.set(0.55, 1.62, 0.35); engine.add(gauge);
    // fire glow
    const fireLight = new THREE.PointLight(C(0xff6e21), 1.0, 7, 2);
    fireLight.position.set(-1.75, 0.95, 0.0);
    engine.add(fireLight);
    engine.scale.setScalar(1.12);
    scene.add(engine);
    engine.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    const engineSmokePos = new THREE.Vector3();
    onFrame((t) => {
      fly.rotation.z = t * 2.8;
      engine.position.y = 0.02 + Math.sin(t * 9.0) * 0.006;
      fireLight.intensity = 0.7 + 0.38 * (0.5 + 0.5 * Math.sin(t * 12.3 + 1.4));
      engine.updateMatrixWorld();
      engine.localToWorld(engineSmokePos.set(0.95, 3.3, 0));
    });

    // ============================================================
    //  HORSE-DRAWN TRAFFIC
    // ============================================================
    const rigBodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.8, metalness: 0.03, envMapIntensity: 0.25,
    });
    rigBodyMat.vertexColors = true;
    const rigWheelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.74, metalness: 0.08, envMapIntensity: 0.25,
    });
    const horseMats = [0x523b2a, 0x6b4d34, 0x3b2d22, 0x8a6544, 0x2c2924];
    function buildVehicle(parts, wheels, opts) {
      const group = new THREE.Group();
      const bodyMesh = new THREE.InstancedMesh(voxelGeo, rigBodyMat, parts.length);
      bodyMesh.castShadow = true; bodyMesh.receiveShadow = true; bodyMesh.frustumCulled = false;
      const p = new THREE.Vector3(), s = new THREE.Vector3(), m = new THREE.Matrix4(), q = new THREE.Quaternion();
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        p.set(part[1], part[2], part[3]); s.set(part[4], part[5], part[6]);
        q.setFromAxisAngle(_yAxis, part[7] || 0);
        m.compose(p, q, s); bodyMesh.setMatrixAt(i, m);
        bodyMesh.setColorAt(i, C(part[0]));
      }
      bodyMesh.instanceMatrix.needsUpdate = true;
      if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
      group.add(bodyMesh);
      const wheelMesh = new THREE.InstancedMesh(wheelGeo, rigWheelMat, wheels.length);
      wheelMesh.castShadow = true; wheelMesh.receiveShadow = false; wheelMesh.frustumCulled = false;
      for (let i = 0; i < wheels.length; i++) {
        wheelMesh.setColorAt(i, C(wheels[i][3] || 0x2c241d));
      }
      if (wheelMesh.instanceColor) wheelMesh.instanceColor.needsUpdate = true;
      group.add(wheelMesh);
      if (opts && opts.scale) group.scale.setScalar(opts.scale);
      scene.add(group);
      return { group, wheelMesh, wheels, bodyMesh, scale: (opts && opts.scale) || 1 };
    }
    function setVehicleWheels(rig, angle) {
      const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3();
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
      for (let i = 0; i < rig.wheels.length; i++) {
        const w = rig.wheels[i];
        p.set(w[0], w[1], w[2]);
        const rad = w[4] || 0.35;
        s.set(rad, rad, 1);
        m.compose(p, q, s);
        rig.wheelMesh.setMatrixAt(i, m);
      }
      rig.wheelMesh.instanceMatrix.needsUpdate = true;
    }
    function horseParts(parts, x, z, scale, coat, seed) {
      const rr = mulberry32(seed);
      const body = C(coat);
      const mane = body.clone().multiplyScalar(0.55);
      // body/neck/head
      parts.push([coat, x, 0.95 * scale, z, 0.95 * scale, 0.48 * scale, 0.34 * scale]);
      parts.push([coat, x + 0.5 * scale, 1.2 * scale, z, 0.34 * scale, 0.5 * scale, 0.28 * scale, 0.2]);
      parts.push([coat, x + 0.68 * scale, 1.4 * scale, z, 0.36 * scale, 0.27 * scale, 0.24 * scale, 0.1]);
      parts.push([0x1f1b17, x + 0.84 * scale, 1.43 * scale, z, 0.12 * scale, 0.11 * scale, 0.16 * scale]);
      parts.push([mane, x + 0.5 * scale, 1.48 * scale, z, 0.09 * scale, 0.2 * scale, 0.13 * scale]);
      parts.push([0x211b16, x - 0.46 * scale, 0.94 * scale, z, 0.09 * scale, 0.4 * scale, 0.08 * scale, 0.5]);
      for (const [lx, lz] of [[-0.32, -0.24], [-0.32, 0.24], [0.27, -0.24], [0.27, 0.24]]) {
        parts.push([C(coat, 0.75).getHex(), x + lx * scale, 0.46 * scale, z + lz * scale,
          0.12 * scale, 0.9 * scale, 0.11 * scale]);
      }
      // harness
      parts.push([0x2a2420, x + 0.05 * scale, 1.05 * scale, z, 0.08 * scale, 0.42 * scale, 0.38 * scale]);
      parts.push([0x3c2b1f, x - 0.35 * scale, 1.12 * scale, z, 1.15 * scale, 0.08 * scale, 0.08 * scale]);
    }
    function cartParts(seed, carriage) {
      const rr = mulberry32(seed);
      const parts = [];
      const wood = carriage ? 0x402b2d : 0x76563a;
      const trim = carriage ? 0xc0a05f : 0x5d422d;
      const horseCoat = horseMats[seed % horseMats.length];
      if (!carriage) {
        parts.push([wood, 0, 0.72, 0, 2.2, 0.22, 1.15]);
        for (let i = -1; i <= 1; i++) parts.push([wood, i * 0.72, 0.97, 0, 0.16, 0.34, 1.15]);
        parts.push([trim, 0, 0.55, -0.61, 2.3, 0.1, 0.12]);
        parts.push([trim, 0, 0.55, 0.61, 2.3, 0.1, 0.12]);
        parts.push([0x40352b, -0.62, 1.16, 0, 0.55, 0.38, 0.55]);
        // load of iron girders
        for (let i = 0; i < 3; i++) {
          const lz = -0.35 + i * 0.35;
          parts.push([0x4a2b1d, 0.05, 1.15 + i * 0.03, lz, 2.2, 0.08, 0.3]);
          parts.push([0x3a2319, 0.05, 1.04, lz, 2.12, 0.12, 0.1]);
        }
        parts.push([0x6e5138, 0.25, 0.96, 0, 0.06, 0.4, 0.06]);
        horseParts(parts, 1.95, 0, 1, horseCoat, seed + 3);
        horseParts(parts, 1.95, -0.52, 1, horseMats[(seed + 2) % horseMats.length], seed + 4);
        // harness pole between horses
        parts.push([0x342a20, 1.05, 0.92, -0.26, 1.5, 0.08, 0.08, 0.05]);
        // driver
        parts.push([0x2c313a, -0.75, 1.3, 0, 0.22, 0.4, 0.24]);
        parts.push([0xe0ae83, -0.75, 1.58, 0, 0.2, 0.2, 0.2]);
        parts.push([0x191a1b, -0.75, 1.72, 0, 0.26, 0.09, 0.26]);
        const wheels = [
          [-0.78, 0.38, -0.66, 0x2b2119, 0.38],
          [-0.78, 0.38, 0.66, 0x2b2119, 0.38],
          [0.8, 0.34, -0.66, 0x2b2119, 0.34],
          [0.8, 0.34, 0.66, 0x2b2119, 0.34],
        ];
        return buildVehicle(parts, wheels, { scale: 0.9 });
      }
      // closed carriage
      parts.push([wood, 0, 0.98, 0, 1.7, 0.95, 1.12]);
      parts.push([0x241d1d, 0, 1.55, 0, 1.5, 0.25, 1.22]);
      parts.push([trim, 0, 1.15, 0.58, 1.3, 0.5, 0.05]);
      parts.push([trim, 0, 1.15, -0.58, 1.3, 0.5, 0.05]);
      parts.push([0xe0c187, 0, 1.42, 0.6, 1.1, 0.07, 0.04]);
      parts.push([0x1a1a18, 0.38, 1.12, 0.6, 0.34, 0.25, 0.04]);
      parts.push([0x1a1a18, -0.34, 1.12, 0.6, 0.34, 0.25, 0.04]);
      parts.push([trim, 0.0, 1.55, 0.64, 1.25, 0.08, 0.08]);
      parts.push([0x2d2923, -0.35, 1.25, 0.63, 0.4, 0.4, 0.05]);
      parts.push([0x2d2923, 0.3, 1.25, 0.63, 0.4, 0.4, 0.05]);
      parts.push([0x181814, 0.0, 1.72, 0, 0.08, 0.24, 0.15]);
      parts.push([0x5f4728, 0.86, 0.9, 0, 0.42, 0.45, 0.2, 0.2]);
      parts.push([0xc49d55, 0.88, 1.15, 0, 0.06, 0.34, 0.06]);
      parts.push([0x221f1a, -0.92, 1.05, 0.62, 0.3, 0.24, 0.1]);
      parts.push([0xffb65e, -0.92, 1.06, 0.62, 0.12, 0.16, 0.12]);
      horseParts(parts, 2.0, -0.35, 1.05, 0x8a6544, seed + 5);
      horseParts(parts, 2.0, 0.35, 1.05, 0x6b4d34, seed + 6);
      parts.push([0x31281f, 1.12, 0.9, 0, 1.7, 0.08, 0.08, 0.03]);
      parts.push([0x22252a, -0.55, 1.95, 0, 0.2, 0.4, 0.24]);
      parts.push([0xe0ae83, -0.55, 2.24, 0, 0.18, 0.18, 0.18]);
      parts.push([0x171716, -0.55, 2.38, 0, 0.24, 0.08, 0.24]);
      const wheels = [
        [-0.62, 0.44, -0.66, 0x241c15, 0.44],
        [-0.62, 0.44, 0.66, 0x241c15, 0.44],
        [0.75, 0.32, -0.66, 0x241c15, 0.32],
        [0.75, 0.32, 0.66, 0x241c15, 0.32],
      ];
      return buildVehicle(parts, wheels, { scale: 0.82 });
    }

    const vehicles = [];
    function registerVehicle(rig, update) {
      vehicles.push({ rig, update, phase: 0 });
      onFrame((t) => {
        const state = update(t);
        rig.group.position.copy(state.pos);
        rig.group.rotation.y = state.yaw;
        setVehicleWheels(rig, state.wheel);
      });
    }
    // freight carts in the yard
    const cartA = cartParts(31, false);
    registerVehicle(cartA, (t) => {
      const z = 6.35;
      const x0 = -13, x1 = 13, span = x1 - x0;
      const speed = 1.05;
      const raw = (t * speed + 10) % (span * 2);
      const u = raw / span;
      const f = u < 1 ? u : 2 - u;
      const x = x0 + f * span;
      const dir = u < 1 ? 1 : -1;
      return {
        pos: new THREE.Vector3(x, 0.03, z),
        yaw: dir > 0 ? 0 : Math.PI,
        wheel: (t * speed * (dir > 0 ? 1 : -1)) / 0.35,
      };
    });
    const cartB = cartParts(47, false);
    registerVehicle(cartB, (t) => {
      const z = 5.55;
      const x0 = -12, x1 = 12, span = x1 - x0;
      const speed = 0.78;
      const raw = (t * speed + 31) % (span * 2);
      const u = raw / span;
      const f = u < 1 ? u : 2 - u;
      const x = x0 + f * span;
      const dir = u < 1 ? -1 : 1;
      return {
        pos: new THREE.Vector3(x, 0.03, z),
        yaw: dir > 0 ? 0 : Math.PI,
        wheel: (t * speed * (dir > 0 ? -1 : 1)) / 0.35,
      };
    });
    // carriages crossing the bridge
    const carriageA = cartParts(73, true);
    registerVehicle(carriageA, (t) => {
      const x = BRIDGE.x - 0.85;
      const z0 = BRIDGE.z0 + 0.95, z1 = BRIDGE.z1 - 0.95;
      const span = z1 - z0, speed = 0.44;
      const raw = (t * speed + span * 0.5) % (span * 2);
      const u = raw / span;
      const f = u < 1 ? u : 2 - u;
      const z = z0 + f * span;
      const dir = u < 1 ? 1 : -1;
      return {
        pos: new THREE.Vector3(x, BRIDGE.deckTopAt(z) + 0.02, z),
        yaw: dir > 0 ? -Math.PI / 2 : Math.PI / 2,
        wheel: (t * speed * (dir > 0 ? 1 : -1)) / 0.4,
      };
    });
    const carriageB = cartParts(97, true);
    registerVehicle(carriageB, (t) => {
      const x = BRIDGE.x + 0.9;
      const z0 = BRIDGE.z0 + 0.95, z1 = BRIDGE.z1 - 0.95;
      const span = z1 - z0, speed = 0.38;
      const raw = (t * speed + span * 0.9) % (span * 2);
      const u = raw / span;
      const f = u < 1 ? 1 - u : u - 1;
      const z = z0 + f * span;
      const dir = u < 1 ? -1 : 1;
      return {
        pos: new THREE.Vector3(x, BRIDGE.deckTopAt(z) + 0.02, z),
        yaw: dir > 0 ? -Math.PI / 2 : Math.PI / 2,
        wheel: (t * speed * (dir > 0 ? 1 : -1)) / 0.4,
      };
    });

    // ============================================================
    //  TINY ANIMATED PEOPLE — riveters, walkers, strollers
    // ============================================================
    const DYN_CAP = 1600;
    const dynMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.9, metalness: 0.015, envMapIntensity: 0.18,
    });
    dynMat.vertexColors = true;
    const dynMesh = new THREE.InstancedMesh(voxelGeo, dynMat, DYN_CAP);
    dynMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dynMesh.castShadow = false;
    dynMesh.receiveShadow = true;
    dynMesh.frustumCulled = false;
    dynMesh.count = 0;
    scene.add(dynMesh);
    const _dynColor = new THREE.Color();
    const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < DYN_CAP; i++) dynMesh.setMatrixAt(i, _zeroMatrix);
    let dynUsed = 0;
    function allocPart(color) {
      if (dynUsed >= DYN_CAP) return 0;
      const i = dynUsed++;
      _dynColor.copy(color.isColor ? color : C(color));
      dynMesh.setColorAt(i, _dynColor);
      return i;
    }
    const actors = [];
    const _mTmp = new THREE.Matrix4();
    const _qTmp = new THREE.Quaternion();
    const _qYaw = new THREE.Quaternion();
    const _qX = new THREE.Quaternion();
    const _vTmp = new THREE.Vector3();
    const _sTmp = new THREE.Vector3();
    const _xAxis = new THREE.Vector3(1, 0, 0);
    const _jitter = mulberry32(65921);

    function makeDynamicPerson(cfg) {
      const scale = cfg.scale || 1;
      const female = !!cfg.female;
      const skinCol = C(SKIN_COLS[Math.floor(_jitter() * SKIN_COLS.length)]);
      const coatCol = female
        ? C(DRESS_COLS[Math.floor(_jitter() * DRESS_COLS.length)])
        : C(COAT_COLS[Math.floor(_jitter() * COAT_COLS.length)]);
      const legCol = female ? coatCol.clone().multiplyScalar(0.7) : C(TROUSER_COLS[Math.floor(_jitter() * TROUSER_COLS.length)]);
      const hatCol = C(HAT_COLS[Math.floor(_jitter() * HAT_COLS.length)]);
      const parasolCol = C(PARASOL_COLS[Math.floor(_jitter() * PARASOL_COLS.length)]);
      const parts = [];
      function part(role, color, lx, ly, lz, sx, sy, sz) {
        const idx = allocPart(color);
        parts.push({ role, idx, lx, ly, lz, sx, sy, sz });
      }
      if (cfg.worker) {
        const shirt = C(_jitter() > 0.5 ? 0xc9c0aa : 0x7f909f);
        part('legL', legCol, -0.08, 0.18, 0, 0.11, 0.34, 0.14);
        part('legR', legCol, 0.08, 0.18, 0, 0.11, 0.34, 0.14);
        part('body', shirt, 0, 0.59, 0, 0.38, 0.4, 0.24);
        part('armL', shirt, -0.23, 0.62, 0, 0.09, 0.3, 0.1);
        part('armR', shirt, 0.23, 0.62, 0, 0.09, 0.3, 0.1);
        part('head', skinCol, 0, 0.94, 0, 0.23, 0.23, 0.23);
        part('hat', hatCol, 0, 1.11, 0, 0.25, 0.12, 0.25);
        if (cfg.hammer) {
          part('hammerHandle', C(0x6a4d32), 0, 0, 0, 0.055, 0.45, 0.055);
          part('hammerHead', C(0x4a4f50), 0, 0, 0, 0.12, 0.11, 0.28);
        }
      } else if (female) {
        part('legL', legCol, -0.08, 0.24, 0, 0.15, 0.44, 0.18);
        part('legR', legCol, 0.08, 0.24, 0, 0.15, 0.44, 0.18);
        part('body', coatCol, 0, 0.6, 0, 0.36, 0.4, 0.25);
        part('armL', coatCol, -0.22, 0.62, 0, 0.085, 0.28, 0.1);
        part('armR', coatCol, 0.22, 0.62, 0, 0.085, 0.28, 0.1);
        part('head', skinCol, 0, 0.94, 0, 0.22, 0.22, 0.22);
        part('hat', hatCol, 0, 1.08, 0, 0.29, 0.12, 0.29);
        if (cfg.parasol) {
          part('parasolPole', C(0x3c2b1d), 0, 0, 0, 0.035, 1.0, 0.035);
          part('parasolTop', parasolCol, 0, 0, 0, 0.82, 0.06, 0.82);
        }
      } else {
        part('legL', legCol, -0.08, 0.18, 0, 0.12, 0.34, 0.15);
        part('legR', legCol, 0.08, 0.18, 0, 0.12, 0.34, 0.15);
        part('body', coatCol, 0, 0.59, 0, 0.4, 0.42, 0.25);
        part('armL', coatCol, -0.24, 0.62, 0, 0.09, 0.32, 0.11);
        part('armR', coatCol, 0.24, 0.62, 0, 0.09, 0.32, 0.11);
        part('head', skinCol, 0, 0.94, 0, 0.23, 0.24, 0.23);
        part('hat', hatCol, 0, 1.1, 0, 0.29, 0.16, 0.29);
      }
      const actor = {
        cfg, parts, scale, phase: cfg.phase || 0,
        kind: cfg.kind || 'walk',
        path: cfg.path,
        baseY: cfg.y || 0,
        fixedYaw: cfg.yaw || 0,
        x: cfg.x || 0, z: cfg.z || 0,
        hammer: !!cfg.hammer,
        still: !!cfg.still,
      };
      actors.push(actor);
      return actor;
    }

    function lineState(actor, t) {
      const p = actor.path;
      const dx = p.x1 - p.x0, dz = p.z1 - p.z0;
      const span = Math.hypot(dx, dz) || 1;
      let u = (t * (p.speed || 0.5) / span + p.phase) % 2;
      if (u < 0) u += 2;
      const f = u < 1 ? u : 2 - u;
      const dir = u < 1 ? 1 : -1;
      const x = p.x0 + dx * f;
      const z = p.z0 + dz * f;
      const yaw = Math.atan2(dx * dir, dz * dir);
      const y = p.bridge ? BRIDGE.deckTopAt(z) + 0.05 : (p.y !== undefined ? p.y : actor.baseY);
      return { x, z, yaw, y, dir };
    }

    const DYNAMIC_HAMMER_PHASES = [];
    for (let i = 0; i < RIVET_STATIONS.length; i++) {
      const st = RIVET_STATIONS[i];
      const phase = i * 0.63 + 0.3;
      DYNAMIC_HAMMER_PHASES.push(phase);
      const forward = new THREE.Vector3(Math.sin(st.yaw), 0, Math.cos(st.yaw));
      const ax = st.x + forward.x * 0.35;
      const az = st.z + forward.z * 0.35;
      makeDynamicPerson({
        kind: 'hammerswing', x: ax, z: az, y: st.y, yaw: st.yaw,
        scale: 0.76 + (i % 3) * 0.03, worker: true, hammer: true, still: true,
        phase, stationIndex: i,
      });
      // a buddy feeding rivets / holding the beam
      if (i % 2 === 0) {
        makeDynamicPerson({
          kind: 'idle', x: ax + Math.cos(st.yaw) * 0.6, z: az - Math.sin(st.yaw) * 0.6,
          y: st.y, yaw: st.yaw - 0.5,
          scale: 0.7, worker: true, still: true, phase: phase + 1.9, stationIndex: i,
        });
      }
    }

    // walking workers in the yard
    for (let i = 0; i < 12; i++) {
      makeDynamicPerson({
        kind: 'walk', worker: i % 3 !== 0,
        x: 0, z: 0, y: 0.04,
        path: { x0: -12.5 + (i % 3) * 5.5, z0: 6.0 + (i % 4) * 0.42,
          x1: 11.0 - (i % 2) * 3.0, z1: 5.6 + (i % 4) * 0.4,
          speed: 0.35 + (i % 3) * 0.12, phase: i * 0.36 },
        scale: 0.85 + (i % 3) * 0.03, phase: i * 1.27,
      });
    }
    // strollers on the quay
    for (let i = 0; i < 16; i++) {
      const z = nearBankZ(-18 + i * 2.2) + 2.35 + (i % 3) * 0.35;
      makeDynamicPerson({
        kind: 'walk', female: i % 3 === 0, parasol: i % 4 === 0,
        path: { x0: -20 + (i % 3) * 3, z0: z, x1: 20 - (i % 4) * 3, z1: z + (i % 2 ? 0.35 : -0.2),
          speed: 0.22 + (i % 3) * 0.07, phase: i * 0.57 },
        scale: 0.9 + (i % 2) * 0.06, phase: i * 0.97,
      });
    }
    // first platform walkers
    for (let i = 0; i < 6; i++) {
      makeDynamicPerson({
        kind: 'walk', worker: true,
        path: { x0: TOWER.cx - 3.1 + (i % 2) * 0.6, z0: TOWER.cz - 3.6 + i * 1.2,
          x1: TOWER.cx + 3.2 - (i % 3) * 0.5, z1: TOWER.cz - 2.8 + i * 1.1,
          speed: 0.35 + (i % 3) * 0.08, phase: i * 0.77, y: TOWER.platform1 + 0.2 },
        scale: 0.77, phase: i * 1.7,
      });
    }
    // second-level walkers
    for (let i = 0; i < 3; i++) {
      makeDynamicPerson({
        kind: 'walk', worker: true,
        path: { x0: TOWER.cx - 2.1, z0: TOWER.cz - 2.0 + i * 0.7,
          x1: TOWER.cx + 0.3, z1: TOWER.cz - 1.3 + i * 0.7,
          speed: 0.24, phase: i * 0.7, y: TOWER.platform2 + 0.15 },
        scale: 0.7, phase: i * 2.3,
      });
    }
    // two brave workers on a high cross-tie
    for (let i = 0; i < 2; i++) {
      makeDynamicPerson({
        kind: 'walk', worker: true,
        path: { x0: TOWER.cx - 1.25, z0: TOWER.cz + 1.53, x1: TOWER.cx + 1.35, z1: TOWER.cz - 1.5,
          speed: 0.18, phase: i * 0.9, y: 16.64 },
        scale: 0.56, phase: 3.4 + i * 1.1,
      });
    }
    // scaffold walkers
    for (let i = 0; i < 3; i++) {
      const sx = i === 0 ? -10.2 : i === 1 ? 3.45 : -10.0;
      const sz = i === 0 ? 2.1 : i === 1 ? 2.15 : -1.8;
      const leg = i === 2 ? TOWER.cx - 5.5 : TOWER.cx + 3.4;
      makeDynamicPerson({
        kind: 'walk', worker: true,
        path: { x0: sx - 1.0, z0: sz, x1: leg, z1: sz + 0.4, speed: 0.22,
          phase: i * 0.55, y: 6.32 },
        scale: 0.66, phase: i * 1.2,
      });
    }
    // a single walker on the bridge
    makeDynamicPerson({
      kind: 'walk', female: true, parasol: true,
      path: { x0: BRIDGE.x - 1.1, z0: BRIDGE.z0 + 1.2, x1: BRIDGE.x - 1.1, z1: BRIDGE.z1 - 1.2,
        speed: 0.22, phase: 0.64, bridge: true, y: 0 },
      scale: 0.9, phase: 2.1,
    });
    dynMesh.count = dynUsed;
    dynMesh.instanceMatrix.needsUpdate = true;
    if (dynMesh.instanceColor) dynMesh.instanceColor.needsUpdate = true;

    function updateActor(actor, t) {
      let x = actor.x, z = actor.z, y = actor.baseY, yaw = actor.fixedYaw, dir = 1;
      let walking = false;
      if (actor.path) {
        const st = lineState(actor, t);
        x = st.x; z = st.z; y = st.y; yaw = st.yaw; dir = st.dir;
        walking = true;
      }
      const phase = actor.phase;
      const walkSpeed = actor.path ? (actor.path.speed || 0.3) : 0;
      const cycle = walking ? t * 7.2 + phase : t * 2.0 + phase;
      let legSwing = 0, armSwing = 0, bob = 0;
      if (walking) {
        legSwing = Math.sin(cycle) * 0.55;
        armSwing = -Math.sin(cycle) * 0.36;
        bob = Math.abs(Math.sin(cycle)) * 0.025;
      } else if (actor.hammer) {
        const period = 0.82;
        const u = ((t / period + phase * 0.21) % 1 + 1) % 1;
        // wind up, then strike
        const strike = u < 0.22 ? Math.sin(u / 0.22 * Math.PI) : Math.sin(Math.max(0, (u - 0.55)) / 0.45 * Math.PI);
        legSwing = 0.05;
        armSwing = -0.35 + strike * 1.3;
        bob = Math.sin(t * 9.5 + phase) * 0.007 + (u < 0.22 ? 0.018 : 0);
      } else {
        armSwing = Math.sin(t * 1.7 + phase) * 0.1;
        bob = Math.sin(t * 2.1 + phase) * 0.01;
      }
      const yawSine = Math.sin(yaw);
      const yawCos = Math.cos(yaw);
      _qYaw.setFromAxisAngle(_yAxis, yaw);
      const s = actor.scale;
      const rightX = yawCos, rightZ = -yawSine;
      const fwdX = yawSine, fwdZ = yawCos;
      const armAngleL = walking ? armSwing : 0;
      const armAngleR = walking ? -armSwing : (actor.hammer ? armSwing : armAngleL);
      const legAngleL = walking ? legSwing : 0;
      const legAngleR = walking ? -legSwing : 0;
      function setPart(part, wx, wy, wz, q, sx, sy, sz) {
        _vTmp.set(wx, wy, wz);
        _sTmp.set(sx * s, sy * s, sz * s);
        _qTmp.copy(q);
        _mTmp.compose(_vTmp, _qTmp, _sTmp);
        dynMesh.setMatrixAt(part.idx, _mTmp);
      }
      const limb = (part, pivotX, pivotY, angle, sideX) => {
        // pivot is already scaled; build limb hanging down and rotate about X
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const half = part.sy * s * 0.5;
        const localX = pivotX;
        const localY = pivotY + bob - cosA * (part.sy * s * 0.5);
        const localZ = -sinA * (part.sy * s * 0.5);
        const wx = x + localX * yawCos + localZ * yawSine;
        const wz = z - localX * yawSine + localZ * yawCos;
        _qX.setFromAxisAngle(_xAxis, angle);
        _qTmp.copy(_qYaw).multiply(_qX);
        setPart(part, wx, y + localY, wz, _qTmp, part.sx, part.sy, part.sz);
      };
      for (const part of actor.parts) {
        if (part.role === 'legL') {
          limb(part, -0.08 * s * 1.0, 0.35 * s, legAngleL);
        } else if (part.role === 'legR') {
          limb(part, 0.08 * s * 1.0, 0.35 * s, legAngleR);
        } else if (part.role === 'armL') {
          limb(part, -0.23 * s, 0.78 * s, armAngleL);
        } else if (part.role === 'armR') {
          limb(part, 0.23 * s, 0.78 * s, armAngleR);
        } else if (part.role === 'body') {
          const lx = part.lx * s, ly = (part.ly + bob) * s, lz = part.lz * s;
          const wx = x + lx * yawCos + lz * yawSine;
          const wz = z - lx * yawSine + lz * yawCos;
          setPart(part, wx, y + ly, wz, _qYaw, part.sx, part.sy, part.sz);
        } else if (part.role === 'head' || part.role === 'hat') {
          const lx = part.lx * s, ly = (part.ly + bob) * s, lz = part.lz * s;
          const wx = x + lx * yawCos + lz * yawSine;
          const wz = z - lx * yawSine + lz * yawCos;
          setPart(part, wx, y + ly, wz, _qYaw, part.sx, part.sy, part.sz);
        } else if (part.role === 'parasolPole') {
          const ang = -0.18 + Math.sin(t * 4.0 + phase) * 0.045;
          _qX.setFromAxisAngle(_xAxis, ang);
          _qTmp.copy(_qYaw).multiply(_qX);
          const handX = x + (0.34 * yawCos) * s;
          const handZ = z - (0.34 * yawSine) * s;
          setPart(part, handX, y + (1.02 + bob) * s, handZ, _qTmp, part.sx, part.sy, part.sz);
        } else if (part.role === 'parasolTop') {
          const handX = x + (0.48 * yawCos) * s;
          const handZ = z - (0.48 * yawSine) * s;
          setPart(part, handX, y + (1.55 + bob) * s, handZ, _qYaw, part.sx, part.sy, part.sz);
        } else if (part.role === 'hammerHandle' || part.role === 'hammerHead') {
          const pivotX = 0.23 * s, pivotY = 0.78 * s;
          const cosA = Math.cos(armAngleR), sinA = Math.sin(armAngleR);
          const handX = pivotX;
          const handY = pivotY + bob - cosA * 0.32 * s;
          const handZ = -sinA * 0.32 * s;
          const isHead = part.role === 'hammerHead';
          const extra = isHead ? 0.26 : 0.08;
          const hx = handX + (-Math.sin(armAngleR) * 0.0) + 0;
          const hy = handY - cosA * extra * s;
          const hz = handZ - sinA * extra * s;
          const wx = x + hx * yawCos + hz * yawSine;
          const wz = z - hx * yawSine + hz * yawCos;
          _qX.setFromAxisAngle(_xAxis, armAngleR - 0.55);
          _qTmp.copy(_qYaw).multiply(_qX);
          setPart(part, wx, y + hy, wz, _qTmp, part.sx, part.sy, part.sz);
        } else {
          const wx = x + part.lx * s * yawCos + part.lz * s * yawSine;
          const wz = z - part.lx * s * yawSine + part.lz * s * yawCos;
          setPart(part, wx, y + (part.ly + bob) * s, wz, _qYaw, part.sx, part.sy, part.sz);
        }
      }
      return { x, z, y, dir, walking };
    }

    onFrame((t) => {
      for (const actor of actors) updateActor(actor, t);
      dynMesh.instanceMatrix.needsUpdate = true;
    });

    // ============================================================
    //  SPARKS & STEAM
    // ============================================================
    const pointScaleUniform = { value: 1500.0 };
    onFrame(() => {
      pointScaleUniform.value = (RH * 0.5) / Math.tan(camera.fov * 0.5 * DEG);
    });

    function makeSparkSystem() {
      const stations = RIVET_STATIONS.length;
      const perStation = 12;
      const total = stations * perStation;
      const pos = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const aSize = new Float32Array(total);
      const aAlpha = new Float32Array(total);
      const params = [];
      const rr = mulberry32(77411);
      for (let s = 0; s < stations; s++) {
        for (let j = 0; j < perStation; j++) {
          const theta = rr() * TAU;
          const phi = rr() * 0.8 + 0.2;
          params.push({
            station: s,
            dir: new THREE.Vector3(Math.cos(theta) * Math.cos(phi), Math.sin(phi) * 1.15, Math.sin(theta) * Math.cos(phi)),
            speed: 0.55 + rr() * 1.8,
            size: (j < 7 ? 0.035 + rr() * 0.055 : 0.12 + rr() * 0.18),
            glow: j >= 7,
            phase: rr(),
            color: j >= 8 ? new THREE.Color(3.4, 1.45, 0.36) :
              j >= 7 ? new THREE.Color(2.2, 0.9, 0.22) :
                rr() > 0.5 ? new THREE.Color(3.8, 2.0, 0.55) : new THREE.Color(2.8, 1.1, 0.2),
            delay: rr() * 0.25,
          });
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uPointScale: pointScaleUniform },
        vertexShader: `
          attribute vec3 aColor;
          attribute float aSize;
          attribute float aAlpha;
          uniform float uPointScale;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vColor = aColor; vAlpha = aAlpha;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(aSize * uPointScale / max(0.1, -mv.z), 0.0, 80.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          precision highp float;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vec2 q = gl_PointCoord - 0.5;
            float r = length(q) * 2.0;
            if (r > 1.0) discard;
            float a = pow(max(0.0, 1.0 - r), 2.2);
            gl_FragColor = vec4(vColor * vAlpha, a * vAlpha);
          }
        `,
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.renderOrder = 10;
      scene.add(points);
      const sparkStationPos = RIVET_STATIONS.map((st) => {
        const f = new THREE.Vector3(Math.sin(st.yaw), 0, Math.cos(st.yaw));
        return new THREE.Vector3(st.x + f.x * 0.42, st.y + 0.95, st.z + f.z * 0.42);
      });
      const lights = [];
      for (let i = 0; i < 2; i++) {
        const l = new THREE.PointLight(C(0xff6f20), 0.0, 8, 2);
        l.position.copy(sparkStationPos[i * 3]);
        scene.add(l);
        lights.push(l);
      }
      return {
        stations: sparkStationPos,
        update(t) {
          for (let i = 0; i < params.length; i++) {
            const p = params[i];
            const st = sparkStationPos[p.station];
            const period = 0.78 + (p.station % 3) * 0.12;
            let u = ((t / period + p.phase * 0.31 + p.station * 0.63) % 1 + 1) % 1;
            const burst = u < 0.4;
            let alpha = 0;
            let px = 0, py = 0, pz = 0, size = 0;
            if (burst) {
              const age = u * period + p.delay * 0.08;
              const life = p.glow ? 0.22 : 0.31;
              if (age < life) {
                const grav = 4.8;
                px = st.x + p.dir.x * p.speed * age;
                py = st.y + p.dir.y * p.speed * age - 0.5 * grav * age * age;
                pz = st.z + p.dir.z * p.speed * age;
                alpha = Math.pow(1 - age / life, 1.5);
                alpha *= p.glow ? 0.75 : 0.95;
                size = p.size * (1 + age * 2.0);
              }
            }
            pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
            col[i * 3] = p.color.r; col[i * 3 + 1] = p.color.g; col[i * 3 + 2] = p.color.b;
            aSize[i] = size;
            aAlpha[i] = alpha;
          }
          geo.attributes.position.needsUpdate = true;
          geo.attributes.aColor.needsUpdate = true;
          geo.attributes.aSize.needsUpdate = true;
          geo.attributes.aAlpha.needsUpdate = true;
          for (let i = 0; i < lights.length; i++) {
            const pulse = 0.5 + 0.5 * Math.sin(t * 11 + i * 2.1);
            lights[i].intensity = 0.45 + 0.55 * pulse;
          }
        },
      };
    }
    const sparkSystem = makeSparkSystem();
    onFrame((t) => sparkSystem.update(t));

    // a soft additive halo at each hammer strike, for the bloom pass to catch
    const sparkGlows = [];
    for (let i = 0; i < sparkSystem.stations.length; i++) {
      const mat = new THREE.SpriteMaterial({
        map: glowTex,
        color: new THREE.Color(3.1, 1.55, 0.5),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        fog: false,
      });
      const s = new THREE.Sprite(mat);
      s.position.copy(sparkSystem.stations[i]);
      s.scale.set(0.1, 0.1, 1);
      s.renderOrder = 11;
      scene.add(s);
      sparkGlows.push({ sprite: s, station: i });
    }
    onFrame((t) => {
      for (const g of sparkGlows) {
        const st = g.station;
        const period = 0.78 + (st % 3) * 0.12;
        const u = ((t / period + st * 0.37 + 0.12) % 1 + 1) % 1;
        const pulse = Math.pow(Math.max(0, 1 - u * 4.4), 2.2);
        const sz = 0.12 + pulse * 0.52;
        g.sprite.scale.set(sz, sz, 1);
        g.sprite.material.opacity = 0.1 + pulse * 0.52;
      }
    });

    // ============================================================
    //  BOAT ON THE SEINE
    // ============================================================
    function makeWakeTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const ctx = c.getContext('2d');
      const rr = mulberry32(90713);
      const g = ctx.createLinearGradient(0, 0, 256, 0);
      g.addColorStop(0, 'rgba(230,244,235,0)');
      g.addColorStop(0.25, 'rgba(230,244,235,0.16)');
      g.addColorStop(0.72, 'rgba(244,248,236,0.42)');
      g.addColorStop(1, 'rgba(255,255,244,0.7)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 64);
      for (let i = 0; i < 70; i++) {
        const x = 70 + rr() * 180;
        const y = rr() * 64;
        ctx.fillStyle = 'rgba(255,255,246,' + (0.05 + rr() * 0.2) + ')';
        ctx.fillRect(x, y, 3 + rr() * 10, 1 + rr() * 2);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      return tex;
    }
    const wakeTex = makeWakeTexture();

    const boat = new THREE.Group();
    boat.position.set(-2, -0.8, 10.4);
    boat.rotation.y = 0.2;
    const boatHullDark = solidMat(0x252820, 0.7, 0.12);
    const boatHullWhite = solidMat(0xd6c9ad, 0.72, 0.02);
    const boatRed = solidMat(0x6f3125, 0.7, 0.05);
    const boatRoof = solidMat(0x6b6e5e, 0.8, 0.02);
    const boatBrass = solidMat(0xa07b42, 0.35, 0.7);
    const boatDark = solidMat(0x1b1a17, 0.7, 0.2);
    // hull
    meshBox(boat, boatHullDark, 0, 0.08, 0, 4.7, 0.5, 1.5);
    meshBox(boat, boatHullDark, 0.4, 0.34, 0, 4.2, 0.32, 1.35);
    meshBox(boat, boatHullWhite, -0.15, 0.56, 0, 4.6, 0.36, 1.4);
    meshBox(boat, boatHullWhite, -0.45, 0.82, 0, 2.7, 0.55, 1.28);
    meshBox(boat, boatRoof, -0.45, 1.13, 0, 2.85, 0.09, 1.45);
    meshBox(boat, boatBrass, -0.45, 0.8, 0.67, 2.2, 0.08, 0.06);
    meshBox(boat, boatBrass, -0.45, 0.8, -0.67, 2.2, 0.08, 0.06);
    // cabin windows
    for (let i = 0; i < 4; i++) {
      meshBox(boat, solidMat(0x334748, 0.4, 0.1), -1.15 + i * 0.48, 0.83, 0.65, 0.3, 0.29, 0.04);
      meshBox(boat, solidMat(0x334748, 0.4, 0.1), -1.15 + i * 0.48, 0.83, -0.65, 0.3, 0.29, 0.04);
    }
    // bow and stern decks, bench
    meshBox(boat, boatHullWhite, 1.85, 0.77, 0, 0.9, 0.1, 1.16);
    meshBox(boat, boatHullWhite, -1.75, 0.77, 0, 0.8, 0.1, 1.16);
    for (const zz of [-0.48, 0.48]) meshBox(boat, boatHullWhite, 1.25, 1.0, zz, 0.07, 0.35, 0.07);
    meshBox(boat, boatHullWhite, 1.7, 1.17, 0, 0.08, 0.06, 1.12);
    // smokestack
    meshBox(boat, boatDark, 0.55, 1.75, 0, 0.32, 1.25, 0.32);
    meshBox(boat, boatRed, 0.55, 2.44, 0, 0.42, 0.18, 0.42);
    meshBox(boat, boatBrass, 0.55, 1.84, 0, 0.4, 0.08, 0.4);
    meshBox(boat, boatDark, 0.55, 2.56, 0, 0.27, 0.12, 0.27);
    // mast + pennant
    meshBox(boat, boatDark, -1.7, 1.6, 0, 0.045, 1.85, 0.045);
    meshBox(boat, boatHullWhite, -1.48, 2.3, 0, 0.42, 0.04, 0.2);
    meshBox(boat, boatRed, -1.48, 2.2, 0, 0.3, 0.03, 0.16);
    // paddle boxes
    for (const side of [-1, 1]) {
      meshBox(boat, boatHullWhite, -1.98, 0.56, side * 0.83, 0.88, 0.15, 0.12);
      meshBox(boat, boatHullWhite, -1.98, 0.78, side * 0.83, 0.08, 0.35, 0.12);
    }
    const paddleWheels = [];
    for (const side of [-1, 1]) {
      const wheel = new THREE.Group();
      wheel.position.set(-1.98, 0.36, side * 0.82);
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * TAU;
        const paddle = new THREE.Mesh(voxelGeo, boatHullWhite);
        paddle.scale.set(0.18, 0.5, 0.08);
        paddle.position.set(Math.cos(a) * 0.35, Math.sin(a) * 0.35, 0);
        paddle.rotation.z = a;
        paddle.castShadow = true;
        wheel.add(paddle);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 8), boatBrass);
      hub.rotation.x = Math.PI / 2; wheel.add(hub);
      boat.add(wheel);
      paddleWheels.push(wheel);
    }
    // life ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.035, 4, 10), boatHullWhite);
    ring.position.set(0.2, 0.75, 0.68); boat.add(ring);
    // wheelhouse canopy
    meshBox(boat, boatRed, 1.2, 0.95, 0, 0.6, 0.55, 0.75);
    meshBox(boat, boatRoof, 1.2, 1.25, 0, 0.72, 0.08, 0.85);
    meshBox(boat, solidMat(0x2e3f40, 0.4, 0.1), 1.2, 0.99, 0.38, 0.35, 0.25, 0.03);
    // a tiny crew and passengers
    const boatPeople = [
      [0xe0b58c, 0x333d46, 1.45, 0.98, -0.3],
      [0xcf9d76, 0x6a4f3e, 1.1, 0.98, 0.3],
      [0xf0c29b, 0x5e6570, 0.5, 0.98, 0.3],
      [0xd9ab83, 0x534033, 0.2, 0.98, -0.35],
    ];
    for (const [skin, coat, px, py, pz] of boatPeople) {
      meshBox(boat, solidMat(coat, 0.9, 0), px, py, pz, 0.24, 0.34, 0.22);
      meshBox(boat, solidMat(skin, 0.88, 0), px, py + 0.26, pz, 0.2, 0.2, 0.2);
      meshBox(boat, boatDark, px, py + 0.4, pz, 0.23, 0.09, 0.23);
    }
    boat.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    boat.scale.setScalar(1.2);
    scene.add(boat);

    const BOAT_WATER_Y = -0.82;
    function boatStateAt(t) {
      const theta = TAU * t / DURATION + 0.6;
      const x = 3.6 + 5.3 * Math.sin(theta);
      const dxdt = 5.3 * Math.cos(theta) * TAU / DURATION;
      const dzdx = -0.0054 * x + 0.56 * 0.18 * Math.cos(x * 0.18 + 0.2);
      const z = riverCenterZ(x) + 0.36;
      const dzdt = dzdx * dxdt;
      const yaw = Math.atan2(-dzdt, dxdt);
      return { x, z, yaw, dxdt, dzdt };
    }
    const boatSmokeWorld = new THREE.Vector3();
    function boatFunnelPoint(t, out) {
      const s = boatStateAt(t);
      const lx = 0.55 * 1.2, ly = 2.65 * 1.2;
      out.set(s.x + Math.cos(s.yaw) * lx, BOAT_WATER_Y + ly, s.z - Math.sin(s.yaw) * lx);
      return out;
    }
    onFrame((t) => {
      const s = boatStateAt(t);
      const bob = Math.sin(t * 1.45 + 0.7) * 0.035;
      boat.position.set(s.x, BOAT_WATER_Y + bob, s.z);
      boat.rotation.y = s.yaw;
      boat.rotation.z = Math.sin(t * 1.2 + 1.2) * 0.012;
      for (let i = 0; i < paddleWheels.length; i++) {
        paddleWheels[i].rotation.z = t * 2.7 + i * 0.6;
      }
      boatSmokeWorld.set(0, 0, 0);
      boatFunnelPoint(t, boatSmokeWorld);
    });

    // ============================================================
    //  PIGEONS
    // ============================================================
    const pigeonMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.8, metalness: 0.02, envMapIntensity: 0.25,
    });
    const PIGEON_COUNT = 18;
    pigeonMat.vertexColors = true;
    const pigeonMesh = new THREE.InstancedMesh(voxelGeo, pigeonMat, PIGEON_COUNT * 3);
    pigeonMesh.castShadow = false; pigeonMesh.receiveShadow = false;
    pigeonMesh.frustumCulled = false;
    pigeonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const pigeonPalette = [0x8a8f8d, 0x767d80, 0xa3a29a, 0x5e6668, 0xb1aea2, 0x6b7379];
    for (let i = 0; i < PIGEON_COUNT; i++) {
      const col = C(pigeonPalette[i % pigeonPalette.length], 0.9 + (i % 3) * 0.05);
      pigeonMesh.setColorAt(i * 3, col);
      pigeonMesh.setColorAt(i * 3 + 1, col.clone().multiplyScalar(0.86));
      pigeonMesh.setColorAt(i * 3 + 2, col.clone().multiplyScalar(0.86));
    }
    if (pigeonMesh.instanceColor) pigeonMesh.instanceColor.needsUpdate = true;
    scene.add(pigeonMesh);
    const pigeons = [];
    for (let i = 0; i < PIGEON_COUNT; i++) {
      pigeons.push({
        phase: i / PIGEON_COUNT * TAU + (i % 3) * 0.7,
        speed: 0.22 + (i % 4) * 0.045,
        radius: 5.5 + (i % 5) * 1.2,
        height: 13.5 + (i % 6) * 1.7,
        wobble: 0.5 + (i % 3) * 0.3,
        wingPhase: i * 1.21,
      });
    }
    const _pq = new THREE.Quaternion();
    const _pq2 = new THREE.Quaternion();
    const _pPos = new THREE.Vector3();
    const _pScale = new THREE.Vector3();
    const _pM = new THREE.Matrix4();
    onFrame((t) => {
      for (let i = 0; i < PIGEON_COUNT; i++) {
        const b = pigeons[i];
        const a = b.phase + t * b.speed;
        const rad = b.radius + Math.sin(t * 0.42 + b.phase) * b.wobble;
        const x = TOWER.cx + Math.cos(a) * rad;
        const z = TOWER.cz + Math.sin(a) * rad;
        const y = b.height + Math.sin(t * 0.8 + b.phase * 1.7) * 1.3;
        const yaw = a - Math.PI / 2;
        const flap = Math.sin(t * 8.5 + b.wingPhase) * 0.95;
        _pq.setFromAxisAngle(_yAxis, yaw);
        // body
        _pPos.set(x, y, z); _pScale.set(0.24, 0.08, 0.13);
        _pM.compose(_pPos, _pq, _pScale); pigeonMesh.setMatrixAt(i * 3, _pM);
        // wings extend sideways from the body and flap around the flight axis
        for (let side = 0; side < 2; side++) {
          const off = side === 0 ? -1 : 1;
          _pq2.setFromAxisAngle(_xAxis, flap * off);
          _pq2.premultiply(_pq);
          _pPos.set(
            x + Math.sin(yaw) * (0.17 * off),
            y + 0.03 + Math.cos(flap * off) * 0.02,
            z + Math.cos(yaw) * (0.17 * off)
          );
          _pScale.set(0.13, 0.02, 0.31);
          _pM.compose(_pPos, _pq2, _pScale);
          pigeonMesh.setMatrixAt(i * 3 + 1 + side, _pM);
        }
      }
      pigeonMesh.instanceMatrix.needsUpdate = true;
    });

    // ============================================================
    //  CHIMNEY SMOKE / STEAM
    // ============================================================
    function buildSmokeSystem() {
      const emitters = [];
      // a handful of smoking Haussmann chimneys
      const stride = Math.max(1, Math.floor(smokeSources.length / 8));
      for (let i = 0; i < smokeSources.length && emitters.length < 8; i += stride) {
        const p = smokeSources[i];
        emitters.push({
          pos: p.clone(), count: 4, rate: 0.085, rise: 5.6, drift: 0.55,
          size: 0.6, color: C(0xcab9a2), opacity: 0.28, phase: i * 0.31,
        });
      }
      // steam engine
      emitters.push({
        getPos: (t, out) => out.copy(engineSmokePos), count: 13, rate: 0.72, rise: 7.2, drift: 0.9,
        size: 0.9, color: C(0xbeb5a7), opacity: 0.38, phase: 0.3,
      });
      // boat funnel
      emitters.push({
        getPos: (t, out) => boatFunnelPoint(t, out), count: 12, rate: 0.65, rise: 5.6, drift: 0.9,
        size: 0.8, color: C(0xbdbab0), opacity: 0.34, phase: 1.1, moving: true,
      });
      // steam winch / boiler near the tower foot
      emitters.push({
        pos: new THREE.Vector3(-8.4, 1.0, 4.15), count: 8, rate: 0.5, rise: 5.4, drift: 0.8,
        size: 0.62, color: C(0xd0c9bb), opacity: 0.33, phase: 2.4,
      });
      // little puffs of steam around the riveting at the first platform
      if (sparkSystem.stations[0]) {
        emitters.push({
          pos: sparkSystem.stations[0].clone().add(new THREE.Vector3(0.2, -0.25, 0.1)),
          count: 5, rate: 0.34, rise: 2.8, drift: 0.5,
          size: 0.34, color: C(0xded7ca), opacity: 0.25, phase: 0.8,
        });
      }
      if (sparkSystem.stations[3]) {
        emitters.push({
          pos: sparkSystem.stations[3].clone().add(new THREE.Vector3(-0.1, -0.3, 0.2)),
          count: 4, rate: 0.27, rise: 2.4, drift: 0.45,
          size: 0.3, color: C(0xd8d3c7), opacity: 0.22, phase: 1.7,
        });
      }
      // shed stove, hand placed so it reads above the roof
      emitters.push({
        pos: new THREE.Vector3(-12.7, 4.6, 5.3), count: 5, rate: 0.3, rise: 4.6, drift: 0.6,
        size: 0.55, color: C(0xb8ac9a), opacity: 0.26, phase: 2.4,
      });
      const total = emitters.reduce((a, e) => a + e.count, 0);
      const pos = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const size = new Float32Array(total);
      const alpha = new Float32Array(total);
      const phases = [];
      const rr = mulberry32(68231);
      let cursor = 0;
      for (let e = 0; e < emitters.length; e++) {
        for (let i = 0; i < emitters[e].count; i++) {
          phases.push({
            emitter: e, phase: rr(),
            driftX: (rr() - 0.5) * 2.2,
            driftZ: (rr() - 0.5) * 2.2,
            wobble: rr() * TAU,
          });
          cursor++;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uPointScale: pointScaleUniform },
        vertexShader: `
          attribute vec3 aColor;
          attribute float aSize;
          attribute float aAlpha;
          uniform float uPointScale;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vColor = aColor; vAlpha = aAlpha;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(aSize * uPointScale / max(0.1, -mv.z), 0.0, 150.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          precision highp float;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vec2 q = gl_PointCoord - 0.5;
            float r = length(q) * 2.0;
            if (r > 1.0) discard;
            float a = pow(max(0.0, 1.0 - r), 1.7);
            float n = 0.82 + 0.18 * sin(gl_PointCoord.x * 13.0 + gl_PointCoord.y * 17.0);
            gl_FragColor = vec4(vColor, a * vAlpha * n);
          }
        `,
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.NormalBlending,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.renderOrder = 8;
      points.visible = false;
      scene.add(points);
      const world = new THREE.Vector3();
      const activeEmitters = emitters.length;
      return {
        update(t) {
          for (let i = 0; i < phases.length; i++) {
            const d = phases[i];
            const e = emitters[d.emitter];
            let age = (t * e.rate + e.phase + d.phase) % 1;
            if (age < 0) age += 1;
            if (e.getPos) e.getPos(t, world, age);
            else world.copy(e.pos);
            const driftAmt = age * age * e.drift;
            const ix = i;
            pos[ix * 3] = world.x + d.driftX * driftAmt + Math.sin(t * 0.45 + d.wobble) * 0.18;
            pos[ix * 3 + 1] = world.y + age * e.rise;
            pos[ix * 3 + 2] = world.z + d.driftZ * driftAmt + Math.cos(t * 0.37 + d.wobble) * 0.18;
            const c = e.color;
            col[ix * 3] = c.r; col[ix * 3 + 1] = c.g; col[ix * 3 + 2] = c.b;
            size[ix] = e.size * (0.7 + age * 2.4);
            alpha[ix] = Math.pow(Math.sin(Math.PI * Math.min(1, age * 1.15)), 1.15) * e.opacity;
          }
          geo.attributes.position.needsUpdate = true;
          geo.attributes.aColor.needsUpdate = true;
          geo.attributes.aSize.needsUpdate = true;
          geo.attributes.aAlpha.needsUpdate = true;
        },
      };
    }
    // (the original soft-point smoke experiment is superseded by the sprite system below)

    // ============================================================
    //  SOFT SPRITE SMOKE & STEAM
    // ============================================================
    function makeSmokeTexture() {
      const N = 128;
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const ctx = c.getContext('2d');
      const rr = mulberry32(55123);
      for (let i = 0; i < 13; i++) {
        const x = N * (0.42 + rr() * 0.16);
        const y = N * (0.42 + rr() * 0.16);
        const r = N * (0.12 + rr() * 0.26);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.42)');
        g.addColorStop(0.55, 'rgba(255,255,255,0.18)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    }
    const smokePuffTex = makeSmokeTexture();
    function buildSpriteSmoke() {
      const rr = mulberry32(73019);
      const emitters = [];
      // chimney smokers, sampled across the city and sheds
      const stride = Math.max(1, Math.floor(smokeSources.length / 6));
      for (let i = 0; i < smokeSources.length && emitters.length < 6; i += stride) {
        emitters.push({
          pos: smokeSources[i].clone(), count: 4, rate: 0.075,
          rise: 7.5, drift: 1.4, size: 0.9, color: 0xcfc0af,
          opacity: 0.2, phase: i * 0.23,
        });
      }
      if (sparkSystem.stations[0]) {
        emitters.push({
          pos: sparkSystem.stations[0].clone().add(new THREE.Vector3(0, -0.1, 0)),
          count: 3, rate: 0.34, rise: 3.4, drift: 1.1, size: 0.55,
          color: 0xe6dfd2, opacity: 0.18, phase: 0.8,
        });
      }
      if (sparkSystem.stations[4]) {
        emitters.push({
          pos: sparkSystem.stations[4].clone().add(new THREE.Vector3(0, -0.2, 0)),
          count: 3, rate: 0.3, rise: 3.0, drift: 0.9, size: 0.45,
          color: 0xdcd5c7, opacity: 0.15, phase: 2.1,
        });
      }
      emitters.push({
        getPos: (t, out) => out.copy(engineSmokePos), count: 12, rate: 0.68,
        rise: 8.0, drift: 1.8, size: 1.1, color: 0x6e6960,
        opacity: 0.28, phase: 0.3,
      });
      emitters.push({
        getPos: (t, out, age) => boatFunnelPoint(t - age * 0.75, out), count: 12, rate: 0.62,
        rise: 5.0, drift: 1.0, size: 0.85, color: 0xc4c0b7,
        opacity: 0.25, phase: 1.4,
      });
      const puffs = [];
      const world = new THREE.Vector3();
      for (const e of emitters) {
        for (let i = 0; i < e.count; i++) {
          const mat = new THREE.SpriteMaterial({
            map: smokePuffTex,
            color: C(e.color),
            transparent: true,
            opacity: 0,
            depthWrite: false,
            depthTest: true,
            fog: false,
          });
          const sprite = new THREE.Sprite(mat);
          sprite.visible = false;
          sprite.renderOrder = 6;
          scene.add(sprite);
          puffs.push({
            emitter: e,
            phase: rr(),
            scaleVar: 0.65 + rr() * 0.8,
            opacityVar: 0.7 + rr() * 0.6,
            driftX: (rr() - 0.5) * 2.4,
            driftZ: (rr() - 0.5) * 2.4,
            wobble: rr() * TAU,
            sprite,
          });
        }
      }
      return {
        update(t) {
          for (const p of puffs) {
            const e = p.emitter;
            let age = (t * e.rate + e.phase + p.phase) % 1;
            if (age < 0) age += 1;
            if (e.getPos) e.getPos(t, world, age);
            else world.copy(e.pos);
            const drift = age * age * e.drift;
            const sx = world.x + p.driftX * drift + Math.sin(t * 0.55 + p.wobble) * 0.3;
            const sy = world.y + age * e.rise + 0.25;
            const sz = world.z + p.driftZ * drift + Math.cos(t * 0.47 + p.wobble) * 0.3;
            p.sprite.position.set(sx, sy, sz);
            const size = e.size * p.scaleVar * (0.6 + age * 1.8);
            p.sprite.scale.set(size, size * 0.82, 1);
            const opacity = Math.pow(Math.sin(Math.PI * Math.min(1, age * 1.12)), 1.2) * e.opacity * p.opacityVar;
            p.sprite.material.opacity = opacity;
            p.sprite.material.rotation = p.wobble * 0.15 + Math.sin(t * 0.3 + p.wobble) * 0.12;
            p.sprite.visible = opacity > 0.012;
          }
        },
      };
    }
    const spriteSmoke = buildSpriteSmoke();
    onFrame((t) => spriteSmoke.update(t));

    // ============================================================
    //  POST PROCESSING: HDR -> soft bloom -> ACES -> sRGB
    // ============================================================
    const hdrSupported = !!(renderer.extensions && renderer.extensions.has('EXT_color_buffer_float'));
    const RT_TYPE = hdrSupported ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const rtScene = new THREE.WebGLRenderTarget(RW, RH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: RT_TYPE,
      depthBuffer: true,
      stencilBuffer: false,
    });
    rtScene.texture.encoding = THREE.LinearEncoding;
    const bloomW = Math.round(WIDTH * 0.55);
    const bloomH = Math.round(HEIGHT * 0.55);
    const rtBloomA = new THREE.WebGLRenderTarget(bloomW, bloomH, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: RT_TYPE, depthBuffer: false,
    });
    const rtBloomB = new THREE.WebGLRenderTarget(bloomW, bloomH, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: RT_TYPE, depthBuffer: false,
    });

    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    postQuad.frustumCulled = false;
    postScene.add(postQuad);
    const POST_VERT = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `;
    const brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: rtScene.texture },
        uThreshold: { value: hdrSupported ? 1.85 : 0.85 },
        uKnee: { value: hdrSupported ? 0.8 : 0.35 },
      },
      vertexShader: POST_VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uThreshold, uKnee;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = max(max(c.r, c.g), c.b);
          float w = smoothstep(uThreshold, uThreshold + uKnee, l);
          gl_FragColor = vec4(c * w, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });
    const blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(1 / bloomW, 1 / bloomH) },
      },
      vertexShader: POST_VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uDir, uTexel;
        void main() {
          vec2 d = uDir * uTexel;
          vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
          c += texture2D(tDiffuse, vUv + d * 1.3846153846).rgb * 0.3162162162;
          c += texture2D(tDiffuse, vUv - d * 1.3846153846).rgb * 0.3162162162;
          c += texture2D(tDiffuse, vUv + d * 3.2307692308).rgb * 0.0702702703;
          c += texture2D(tDiffuse, vUv - d * 3.2307692308).rgb * 0.0702702703;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });
    const compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: rtScene.texture },
        tBloom: { value: rtBloomA.texture },
        uBloom: { value: 1.0 },
        uExposure: { value: 0.55 },
        uResolution: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      },
      vertexShader: POST_VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tScene, tBloom;
        uniform float uBloom, uExposure;
        uniform vec2 uResolution;

        vec3 ACESFilm(vec3 x) {
          const float a = 2.51;
          const float b = 0.03;
          const float c = 2.43;
          const float d = 0.59;
          const float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }
        float hash21(vec2 p) {
          return fract(sin(dot(p, vec2(41.13, 289.37))) * 45758.5453);
        }
        void main() {
          vec3 base = texture2D(tScene, vUv).rgb;
          vec3 bloom = texture2D(tBloom, vUv).rgb;
          vec3 colour = base + bloom * uBloom;
          colour *= uExposure;
          colour = ACESFilm(colour);
          // gentle filmic grade: cooler shadows, warm highlights, richer hues
          float l = dot(colour, vec3(0.299, 0.587, 0.114));
          colour = mix(vec3(l), colour, 1.24);
          colour = mix(colour, smoothstep(vec3(0.015), vec3(0.985), colour), 0.16);
          colour *= mix(vec3(0.90, 0.96, 1.08), vec3(1.05, 1.0, 0.94), smoothstep(0.04, 0.86, l));
          // vignette baked into the image so canvas captures match the page
          vec2 q = (vUv - 0.5) * vec2(1.0, 1.02);
          float vig = 1.0 - dot(q, q) * 0.66;
          colour *= clamp(vig, 0.0, 1.0);
          // subtle dithering to avoid banding in the hazy sky
          float n = hash21(gl_FragCoord.xy) - 0.5;
          colour += n * 0.006;
          colour = pow(max(colour, 0.0), vec3(1.0 / 2.2));
          gl_FragColor = vec4(colour, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });

    function renderFullscreen(mat, target) {
      postQuad.material = mat;
      renderer.setRenderTarget(target || null);
      renderer.clear();
      renderer.render(postScene, postCamera);
    }

    // ============================================================
    //  CAMERA + ANIMATION LOOP
    // ============================================================
    const lookTarget = new THREE.Vector3();
    const camGoal = new THREE.Vector3();

    function updateCamera(t) {
      const override = window.__cameraOverride;
      if (override) {
        camera.position.fromArray(override.pos);
        lookTarget.fromArray(override.target);
        camera.lookAt(lookTarget);
        camera.fov = override.fov || 40;
        camera.updateProjectionMatrix();
        return;
      }
      const k = clamp(t / DURATION, 0, 1);
      const e = k; // deliberately linear: the orbit never settles
      const theta = lerp(40, 15.0, e) * DEG;
      const elev = lerp(12.4, 10.2, e) * DEG;
      const radius = lerp(68, 65, smooth(clamp(k * 1.08, 0, 1)));
      const tx = lerp(0.2, -2.1, smooth(k));
      const ty = lerp(7.2, 6.8, smooth(k));
      const tz = lerp(1.2, -1.9, smooth(k));
      lookTarget.set(tx, ty, tz);
      camGoal.set(
        tx + Math.sin(theta) * Math.cos(elev) * radius,
        ty + Math.sin(elev) * radius,
        tz + Math.cos(theta) * Math.cos(elev) * radius
      );
      // a faint breathing drift keeps frame one alive
      camGoal.y += Math.sin(t * 0.33 + 0.7) * 0.09;
      camera.position.copy(camGoal);
      camera.lookAt(lookTarget);
      camera.fov = lerp(38.2, 39.5, smooth(k));
      camera.updateProjectionMatrix();
    }

    // water normal animation
    onFrame((t) => {
      if (waterNormalMap) {
        waterNormalMap.offset.x = t * 0.0093;
        waterNormalMap.offset.y = t * 0.0041;
      }
      cloudSeaMat.uniforms.uTime.value = t;
    });

    function renderFrame(t) {
      t = Number(t);
      if (!Number.isFinite(t)) t = 0;
      updateCamera(t);
      for (const fn of updaters) fn(t);
      renderer.info.reset();
      renderer.setRenderTarget(rtScene);
      renderer.clear();
      renderer.render(scene, camera);
      // bright pass
      renderFullscreen(brightMat, rtBloomA);
      // two separable blur iterations
      blurMat.uniforms.tDiffuse.value = rtBloomA.texture;
      blurMat.uniforms.uDir.value.set(1, 0);
      renderFullscreen(blurMat, rtBloomB);
      blurMat.uniforms.tDiffuse.value = rtBloomB.texture;
      blurMat.uniforms.uDir.value.set(0, 1);
      renderFullscreen(blurMat, rtBloomA);
      blurMat.uniforms.tDiffuse.value = rtBloomA.texture;
      blurMat.uniforms.uDir.value.set(1, 0);
      blurMat.uniforms.uTexel.value.set(1 / bloomW * 1.7, 1 / bloomH * 1.7);
      renderFullscreen(blurMat, rtBloomB);
      blurMat.uniforms.tDiffuse.value = rtBloomB.texture;
      blurMat.uniforms.uDir.value.set(0, 1);
      renderFullscreen(blurMat, rtBloomA);
      blurMat.uniforms.uTexel.value.set(1 / bloomW, 1 / bloomH);
      // final tone-mapped composite to the visible canvas
      compositeMat.uniforms.tBloom.value = rtBloomA.texture;
      renderFullscreen(compositeMat, null);
      renderer.setRenderTarget(null);
    }

    // ============================================================
    //  PUBLIC DETERMINISTIC FRAME API + AUTOPLAY
    // ============================================================
    let autoplay = true;
    let autoRafActive = false;
    let startTime = performance.now();
    let nextFrameTime = 0;
    const FIXED_STEP = 1 / 30;

    window.renderAt = function (t) {
      autoplay = false;
      let tt = Number(t);
      if (!Number.isFinite(tt)) tt = 0;
      tt = clamp(tt, 0, DURATION);
      renderFrame(tt);
      window.__lastRenderedTime = tt;
      window.__frameCount = (window.__frameCount || 0) + 1;
    };
    window.__pause = function () { autoplay = false; };
    window.__resume = function () {
      autoplay = true;
      startTime = performance.now();
      nextFrameTime = 0;
      if (!autoRafActive) {
        autoRafActive = true;
        requestAnimationFrame(animate);
      }
    };
    window.__duration = DURATION;
    window.__fps = 30;
    window.__width = WIDTH;
    window.__height = HEIGHT;
    window.THREE = THREE;
    window.__debug = {
      scene, camera, renderer, renderFrame, updateCamera,
      water: waterMesh, sun, hemi, fill, rim,
      batches, BRIDGE, TOWER, skyDome, cloudGroup, hazeGroup,
      cloudBank: scene.getObjectByName('cloud-bank'), cloudSea: scene.getObjectByName('cloud-sea'),
      compositeMat, sun, hemi, fill, rim,
      THREE,
    };

    // initial frame
    updateCamera(0);
    renderFrame(0);

    function animate(now) {
      if (!autoplay) {
        autoRafActive = false;
        return;
      }
      autoRafActive = true;
      const elapsed = ((now - startTime) / 1000) % DURATION;
      if (elapsed >= nextFrameTime - 0.0001) {
        renderFrame(elapsed);
        window.__autoplayTime = elapsed;
        nextFrameTime = elapsed + FIXED_STEP;
        if (nextFrameTime >= DURATION) nextFrameTime = 0;
      }
      requestAnimationFrame(animate);
    }
    autoRafActive = true;
    requestAnimationFrame(animate);
    window.__ready = true;
    console.log(`Paris 1888 ready · ${VERSION}`);
  } catch (err) {
    fail(err);
  }
})();
