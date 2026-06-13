import './assets/main.css'

// Bundled, offline fonts — never fetched from Google Fonts, so the app renders
// identically in airplane mode (Rule 3 warm-cache acceptance). Fraunces = display,
// Newsreader = body, IBM Plex Mono = labels/telemetry.
import '@fontsource/fraunces/400.css'
import '@fontsource/fraunces/600.css'
import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/500.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

import { createRoot } from 'react-dom/client'
import App from './App'

// NOTE: no React.StrictMode — it double-invokes effects in dev, which would fire
// the model-load effect twice and race two loadModel() calls against the SDK.
createRoot(document.getElementById('root')!).render(<App />)
