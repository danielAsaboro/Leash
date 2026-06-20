# iPad Universal Mobile Design

## Goal

Make `apps/mobile` a universal iPhone and iPad app. The iPad build must be self-contained like mobile: native Expo/React Native, local QVAC runtime, mesh, voice, chat history, tasks, Brain, and model management. It must not depend on a WebView or a packaged Next server.

## Architecture

`apps/mobile` remains the single native mobile codebase. It already has `ios.supportsTablet: true`, QVAC bridge wiring, local model loading, mesh forwarding, and the mobile feature screens. iPad support adds a tablet layout layer on top of those existing capabilities.

The app detects tablet-class layouts from screen dimensions. Phone-width layouts keep the current drawer navigation. Tablet-width layouts render a persistent rail and a wider content area while reusing the same route state and screen implementations.

## User Experience

Phone behavior stays unchanged: single-column screens, slide-in navigation drawer, compact chat composer.

iPad behavior uses a web-like shell:

- persistent left rail with the same sections as web/mobile navigation
- main content beside the rail
- chat masthead without a drawer button
- wider chat feed and composer bounds
- Home and other existing screens reuse their live native data

The first implementation focuses on the shell and chat/home layout foundation. Follow-up work can make each secondary screen denser on iPad without changing runtime behavior.

## Build Shape

There is no new `apps/ipad` workspace. Add explicit scripts for iPad development/build invocation that run the existing Expo app with an iPad-oriented name. The app remains universal and can be built from `apps/mobile`.

## Testing

Add a pure layout smoke test covering phone, iPad/tablet, and narrow iPad split-view decisions. Typecheck the mobile app after wiring the shell.

## Non-Goals

- No WebView wrapper.
- No Next server on iPad.
- No duplicated QVAC runtime.
- No separate native app workspace unless App Store packaging later requires a second bundle.
