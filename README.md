# webgpu-brush

A WebGPU port of [p5.brush](https://github.com/acamposuribe/p5.brush) by Alejandro Campos Uribe. Same drawing API, rendered on the GPU. No p5.js.

## Install

```
npm install github:lklyne/webgpu-brush
```

## Use

```js
import * as brush from 'webgpu-brush';

brush.createCanvas(700, 410, { parent: document.body });
brush.set('HB', '#2f2a26', 1.4);
brush.line(-200, -80, 200, 80);
brush.render();
```

## three.js

`webgpu-brush/three` shares the renderer's `GPUDevice` and gives you a TSL node that samples the painting directly. No copies.

```js
import * as THREE from 'three/webgpu';
import { attachToRenderer } from 'webgpu-brush/three';

const renderer = new THREE.WebGPURenderer({ canvas });
const att = await attachToRenderer(renderer, 1024, 1024);

const material = new THREE.MeshBasicNodeMaterial({ colorNode: att.node });
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

att.brush.set('HB', '#2f2a26', 1.4);
att.brush.line(-300, -300, 300, 300);
att.brush.render();
```

`att.brush` is its own painting, with the full API. Call `att.dispose()` when done.

## React Three Fiber

```jsx
import * as THREE from 'three/webgpu';
import { Canvas, extend, useThree } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import { attachToRenderer } from 'webgpu-brush/three';

extend(THREE);

function Painting() {
  const gl = useThree((s) => s.gl);
  const [att, setAtt] = useState(null);

  useEffect(() => {
    let live, cancelled = false;
    attachToRenderer(gl, 1024, 1024).then((a) => {
      if (cancelled) return a.dispose();
      live = a;
      a.brush.set('HB', '#2f2a26', 1.4);
      a.brush.line(-300, -300, 300, 300);
      a.brush.render();
      setAtt(a);
    });
    return () => { cancelled = true; live?.dispose(); };
  }, [gl]);

  return att && (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <meshBasicNodeMaterial colorNode={att.node} />
    </mesh>
  );
}

export default () => (
  <Canvas flat linear gl={async (props) => {
    const renderer = new THREE.WebGPURenderer(props);
    await renderer.init();
    return renderer;
  }}>
    <Painting />
  </Canvas>
);
```

`flat linear` keeps the painting's colors 1:1 (no tone mapping, linear output).

## Docs

- **Drawing API:** [p5.brush reference](https://github.com/acamposuribe/p5.brush#reference) and [p5-brush.cargo.site](https://p5-brush.cargo.site/). Call everything on `brush` directly; there is no p5.
- **What's different:** [docs/standalone.md](docs/standalone.md). Covers `ready()`, `readPixels()`, multiple paintings (`createBrush()`), the full three.js guide, GPU interop, snapshots and the hash RNG. Same seed ≠ same image as upstream.
- **Port history:** [FORK.md](FORK.md). Forked at v2.2.2 (`fc37da3`), upstream fixes synced through v2.2.3.

## License

[MIT](LICENSE.md)
