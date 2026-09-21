# webgpu-brush

A WebGPU port of [p5.brush](https://github.com/acamposuribe/p5.brush) by Alejandro Campos Uribe. Same drawing API, rendered on the GPU. No p5.js.

## Install

```
npm install github:lklyne/webgpu-brush#gpu-port
```

## Use

```js
import * as brush from 'webgpu-brush';

brush.createCanvas(700, 410, { parent: document.body });
brush.set('HB', '#2f2a26', 1.4);
brush.line(-200, -80, 200, 80);
brush.render();
```

## Docs

- **Drawing API:** [p5.brush reference](https://github.com/acamposuribe/p5.brush#reference) and [p5-brush.cargo.site](https://p5-brush.cargo.site/). Call everything on `brush` directly; there is no p5.
- **What's different:** [docs/standalone.md](docs/standalone.md). Covers `ready()`, `readPixels()`, multiple paintings (`createBrush()`), three.js (`webgpu-brush/three`), GPU interop, snapshots and the hash RNG. Same seed ≠ same image as upstream.
- **Port history:** [FORK.md](FORK.md). Forked at v2.2.2 (`fc37da3`), upstream fixes synced through v2.2.3.

## License

MIT, same as p5.brush. See [LICENSE.md](LICENSE.md).
