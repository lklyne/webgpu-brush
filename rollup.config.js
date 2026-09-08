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

// One build: the standalone WebGPU library. WGSL ships as string exports
// (src/webgpu/wgsl/*.wgsl.js), so no shader loader plugin is needed.
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
];
