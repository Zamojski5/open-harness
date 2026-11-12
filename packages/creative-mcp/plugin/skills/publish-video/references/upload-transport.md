# Local file → web uploader

1. Prefer the browser tool's own file-upload operation on the observed `<input type="file">` (e.g. a file-upload action of a connected browser-automation tool) ; that avoids the OS file dialog entirely.
2. Otherwise its supported file-chooser handling, or ask the user to drag the file in (give the exact path).

A loopback helper (a short-lived local server that serves only the selected files, to one exact HTTPS origin, behind random URLs, expiring after minutes) is a known technique if page scripting is allowed and browser and helper share one computer — none is bundled here; don't improvise one with a general-purpose file server.
