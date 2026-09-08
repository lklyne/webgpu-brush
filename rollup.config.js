// rollup.config.js

import terser from "@rollup/plugin-terser";
import cleanup from "rollup-plugin-cleanup";
import resolve from "@rollup/plugin-node-resolve";

const plugins = [
  resolve({
    browser: true,
  }),
  terser({
    module: true,
    compress: {
      keep_infinity: true,
      module: true,
      passes: 3,
      toplevel: true,
    },
  }),
  cleanup({
    comments: "none",
  }),
];

// Two builds. The standalone WebGPU library (UMD + ESM; WGSL ships as string
// exports under src/webgpu/wgsl, so no shader loader plugin is needed), and
// the three.js bridge (ESM only, three is ESM only). The bridge imports the
// library from ./brush.esm.js rather than bundling a second copy: brush-gpu
// is a module singleton and the bridge must share it with the consumer.
const CORE = /index\.standalone\.js$/;

export default [
  {
    input: "src/index.standalone.js",
    output: [
      {
        file: "dist/brush.js",
        format: "umd",
        name: "brush",
        sourcemap: true,
      },
      {
        file: "dist/brush.esm.js",
        format: "esm",
        sourcemap: true,
      },
    ],
    plugins,
  },
  {
    input: "src/three/index.js",
    external: (id) => id === "three" || id.startsWith("three/") || CORE.test(id),
    output: {
      file: "dist/three.esm.js",
      format: "esm",
      sourcemap: true,
      paths: (id) => (CORE.test(id) ? "./brush.esm.js" : id),
    },
    plugins,
  },
];
