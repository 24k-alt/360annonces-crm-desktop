import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const nm = path.resolve(__dirname, '../node_modules')
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      'twenty-sdk/front-component': path.resolve(__dirname, 'stubs/front.ts'),
      'twenty-client-sdk/rest': path.resolve(__dirname, 'stubs/rest.ts'),
      react: path.join(nm, 'react'),
      'react-dom': path.join(nm, 'react-dom'),
      '@fontsource-variable/inter': path.join(nm, '@fontsource-variable/inter'),
    },
  },
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
})
