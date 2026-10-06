import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so dist/ works from any folder (Tauri asset protocol, file serving).
export default defineConfig({ base: './', plugins: [react()] })
