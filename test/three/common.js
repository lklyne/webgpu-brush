// Shared body for the two three.js bridge smoke pages. Draws with brush,
// samples the painting on a plane through the bridge's TSL node, renders
// that into a render target on the SAME device, and reads it back — the
// only proof that the ExternalTexture path really binds the painting.
import * as THREE from "three/webgpu";

export async function exercise(att, renderer) {
  const { brush } = att;
  brush.clear("#ffffff");
  brush.pick("HB");
  brush.stroke("#101020");
  brush.strokeWeight(6);
  brush.line(-90, -90, 90, 90);
  brush.line(-90, 90, 90, -90);
  brush.render();
  await brush.ready();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = att.node;
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  const target = new THREE.RenderTarget(64, 64);
  renderer.setRenderTarget(target);
  await renderer.renderAsync(scene, camera);
  renderer.setRenderTarget(null);
  const px = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64);

  // Count pixels darker than the white clear: ink sampled through three.
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark++;

  const { pixels } = await brush.readPixels();
  let inked = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) inked++;

  const sameDevice = att.device === renderer.backend.device;
  const ok = sameDevice && dark > 0 && inked > 0;
  window.__smoke = { ok, sameDevice, darkThroughThree: dark, inkedInBrush: inked };
  document.getElementById("out").textContent = JSON.stringify(window.__smoke);
  return window.__smoke;
}
