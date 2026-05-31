import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import jotai from 'jotai-rolldown'

export default defineConfig({
  plugins: [jotai(), react()],
})
