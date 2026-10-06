import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so dist/ works from any folder / local Tauri origin.
// assetsInlineLimit 0: Tauri CSP is default-src 'self' (no font-src), so fonts must be files, never data: URIs.
export default defineConfig({ base: './', plugins: [react()], build: { assetsInlineLimit: 0 } })
