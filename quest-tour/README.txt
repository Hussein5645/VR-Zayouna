QUIET 360 - QUEST PANORAMA TOUR

Files:
  dist/index.html: interface and styling
  dist/app.js: panorama viewer, destinations, transitions and WebXR
  dist/assets/: bundled Three.js 0.180.0 and sample panoramas

Run locally:
  cd dist
  python -m http.server 8000
  Open http://localhost:8000 in your desktop browser.
  Do not open index.html directly; JavaScript modules require a web server.

Quest 3:
  Host the contents of dist on an HTTPS static hosting service.
  Open the HTTPS URL in Quest Browser and select Enter VR.
  Point a controller at a destination and press the trigger.
  HTTPS is required for immersive WebXR on the headset.

Customize:
  Edit the scenes array in dist/app.js and replace images in dist/assets.
  Use full 2:1 equirectangular panoramas.
  Change YOUR LOGO in index.html and app.js.

Includes the Street View-style transition and overlapping-surface flicker fix.
Sample photos: https://pannellum.org/images/alma.jpg
              https://pannellum.org/images/cerro-toco-0.jpg
              https://pannellum.org/images/tocopilla.jpg
Three.js: https://threejs.org/ (MIT license; preserve license notices).
