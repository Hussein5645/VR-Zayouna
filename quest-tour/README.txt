SJ PARTNERS 360 - QUEST PANORAMA TOUR

Files:
  dist/tour.json      <- EDIT THIS: spaces, images, label positions, logo
  dist/spaces/        <- put your 360 images here (.hdr, .jpg, .png, .webp can be mixed)
  dist/assets/logo.png  logo shown at the bottom (browser + VR)
  dist/index.html     interface and styling
  dist/app.js         viewer, 3D labels, transitions and WebXR
  dist/hdr-worker.js  decodes .hdr files in the background
  dist/assets/        bundled Three.js 0.180.0

Run locally:
  cd dist
  python -m http.server 8000
  Open http://localhost:8000 in your desktop browser.
  Do not open index.html directly; JavaScript modules require a web server.

Quest 3:
  Host the contents of dist on an HTTPS static hosting service.
  Open the HTTPS URL in Quest Browser and select the big Enter VR button on the
  loading screen. You don't need to wait: loading continues inside VR with the
  same logo and progress bar. (Browsers only allow VR to start after a click;
  arriving from another VR page on Quest enters VR automatically.)
  Point a controller at a destination and press the trigger, or with hand
  tracking point your hand and pinch. Hand and controller 3D models load from
  cdn.jsdelivr.net (official three.js add-ons and WebXR input profiles), so they
  need internet; without it the tour still works with plain pointer rays.
  HTTPS is required for immersive WebXR on the headset.


EDITING THE TOUR (dist/tour.json)
---------------------------------
Each space looks like this:

  {
    "id": "entrance",                        short name used by labels (no spaces)
    "name": "Entrance Hall",                 shown at the top and on labels
    "image": "spaces/entrance_hall_8k.hdr",  .hdr, .jpg, .png or .webp (2:1 equirectangular)
    "exposure": 1,                           .hdr only: brighter > 1, darker < 1
    "heading": 0,                            image yaw you face on arrival (0 = image centre)
    "cameraHeight": 1.6,                     metres; lens height when the photo was taken
    "ceilingHeight": 2.8,                    metres from floor to ceiling (default 2.8)
    "roomSize": 4.5,                         metres; rough distance to the walls
                                             (bedroom 3-4, living 4-5, hall 8-10)
    "labels": [
      { "to": "events", "yaw": -35, "pitch": -6, "distance": 4 }
    ]
  }

Labels (each space has its own list; link to as few or as many spaces as you like):
  to        id of the space to go to. Leave it out for an information-only label.
  text      optional; defaults to the target space's name
  yaw       left/right in degrees: 0 = image centre, -90 = left, 90 = right, 180 = behind
  pitch     up/down in degrees: 0 = eye level, negative = lower
  distance  metres from the viewer. Use the real distance to the doorway; labels are
            kept inside the room automatically (in front of walls, above the floor).
  scale     optional size multiplier, default 1

Add a space: copy the image into dist/spaces, add a new { ... } block to "spaces",
then add labels in other spaces that point to its id.
Remove a space: delete its block and any labels that point to it.
"start" in tour.json is the id of the first space.

Finding yaw/pitch quickly:
  Open http://localhost:8000/?edit
  Move the mouse: the box at the top shows yaw/pitch under the cursor.
  Best: hover the FLOOR right at the doorway. The box shows "floor 4.2 m", the
  real distance worked out from cameraHeight, and clicking copies a label at that
  distance just below eye level.
  Click any spot: a ready label line is copied to the clipboard; paste it
  into that space's "labels" list and fill in "to". Refresh to see it.
  Add &space=<id> to jump straight to a space, e.g. /?edit&space=night

Logo: replace dist/assets/logo.png. "style": "white" turns a dark logo white so it
reads over the panorama; use "original" for a logo that already has its own colours.

Human scale:
  Each panorama is shaped like a real room: a flat floor at your feet (the bottom
  of the image is laid flat at cameraHeight below the capture point), a flat
  ceiling at ceilingHeight and walls at roomSize. In VR the floor matches your
  real floor and the room stays still when you lean, so it feels life-size.
  Rooms feel too big?   lower roomSize / ceilingHeight for that space, or set
                        "roomScale" at the top of tour.json below 1 (e.g. 0.85)
                        to shrink every room at once.
  Feel too short/tall?  cameraHeight is how far the floor sits below your eyes in
                        VR (default 1.75). Raise it to feel taller. The tour follows
                        your real head height, so it works seated or standing.
  Shooting tips: tripod at ~1.6 m, level, nothing very close to the lens.

Image tips:
  .hdr files are tone mapped in the browser. Files wider than "hdrMaxWidth" (8192)
  are scaled down while loading, so 16k files work but download slowly (~375 MB).
  For the Quest, 8k .hdr or 8k .jpg is the best balance; a .jpg is ~10x smaller.
  On first load every space is downloaded and prepared behind the loading bar,
  so moving between spaces is instant. Each 8k space uses ~130 MB of GPU memory
  on the headset; if a tour with many spaces gets slow on Quest, lower
  "hdrMaxWidth" to 4096 or use smaller .jpg files.
  Label text is shown in capitals automatically.

Three.js: https://threejs.org/ (MIT license; preserve license notices).
