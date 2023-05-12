import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/index.ts',
  output: {
    file: 'commonjs/index.cjs',
    format: 'cjs'
  },
  plugins: [typescript()]
};