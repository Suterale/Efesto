// Full-screen "ASCII art" pass: the scene is rendered into a texture, then every character cell of the
// screen is replaced by the glyph whose ink density matches the average brightness of that cell.
import * as THREE from 'three';

const RAMP = ' .\'`:-;~+i1tfLCG08@';
const CELL_W = 7, CELL_H = 12;   // CSS pixels

export function createAscii(renderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const atlas = new THREE.CanvasTexture(document.createElement('canvas'));
  atlas.minFilter = atlas.magFilter = THREE.NearestFilter;
  atlas.generateMipmaps = false;
  let atlasScale = 0;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uScene: { value: target.texture }, uAtlas: { value: atlas },
      uRes: { value: new THREE.Vector2(1, 1) }, uCell: { value: new THREE.Vector2(CELL_W, CELL_H) },
      uN: { value: RAMP.length }, uFg: { value: new THREE.Color(0x3dff7a) }, uBg: { value: new THREE.Color(0x050805) },
      uColor: { value: 0.65 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uScene, uAtlas;
      uniform vec2 uRes, uCell;
      uniform float uN, uColor;
      uniform vec3 uFg, uBg;
      varying vec2 vUv;
      void main() {
        vec2 px = vUv * uRes;
        vec2 id = floor(px / uCell);
        vec2 cuv = (px - id * uCell) / uCell;
        vec2 c = (id + 0.5) * uCell / uRes;
        vec2 q = 0.25 * uCell / uRes;
        vec3 s = 0.25 * (texture2D(uScene, c + vec2(-q.x, -q.y)).rgb + texture2D(uScene, c + vec2(q.x, -q.y)).rgb +
                         texture2D(uScene, c + vec2(-q.x,  q.y)).rgb + texture2D(uScene, c + vec2(q.x,  q.y)).rgb);
        float lum = dot(s, vec3(0.299, 0.587, 0.114));
        float k = floor(clamp(pow(lum, 0.7) * 1.2, 0.0, 1.0) * (uN - 1.0) + 0.5);
        float ink = texture2D(uAtlas, vec2((k + cuv.x) / uN, cuv.y)).r;
        float mx = max(s.r, max(s.g, s.b)), mn = min(s.r, min(s.g, s.b));
        float sat = smoothstep(0.12, 0.35, (mx - mn) / max(mx, 1e-3));
        vec3 tint = mix(uFg, s / max(mx, 1e-3), sat * uColor);
        gl_FragColor = vec4(mix(uBg, tint, ink), 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  function buildAtlas(scale) {
    const w = Math.round(CELL_W * scale), h = Math.round(CELL_H * scale);
    const cv = atlas.image;
    cv.width = w * RAMP.length;
    cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, cv.width, h);
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(CELL_H * scale * 0.9)}px "VT323", ui-monospace, Menlo, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    [...RAMP].forEach((ch, i) => g.fillText(ch, i * w + w / 2, h / 2 + scale));
    atlas.needsUpdate = true;
    atlasScale = scale;
  }

  return {
    /** Rebuild the glyph atlas on the next frame (e.g. once the font has loaded). */
    invalidate() { atlasScale = 0; },
    /** Colours: { fg, bg, color } where color is how much of the object hue survives (0..1). */
    setColors({ fg, bg, color }) {
      // Raw sRGB values: this pass writes straight to the screen without any colour-space conversion.
      material.uniforms.uFg.value.setHex(fg, THREE.LinearSRGBColorSpace);
      material.uniforms.uBg.value.setHex(bg, THREE.LinearSRGBColorSpace);
      material.uniforms.uColor.value = color;
    },
    /** Render `scene3` through the ASCII pass into the default framebuffer. */
    render(scene3, camera3) {
      const ratio = renderer.getPixelRatio();
      if (ratio !== atlasScale) buildAtlas(ratio);
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      material.uniforms.uRes.value.copy(size);
      material.uniforms.uCell.value.set(Math.round(CELL_W * ratio), Math.round(CELL_H * ratio));
      renderer.setRenderTarget(target);
      renderer.render(scene3, camera3);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
  };
}
