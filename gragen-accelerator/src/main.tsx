import { StrictMode } from 'react'
import 'maplibre-gl/dist/maplibre-gl.css'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
