# Screen inserts

The user's actual recording shown on a device (laptop, phone, monitor) within a generated or rendered scene.

- Generate the surrounding scene (still or clip, `make-image` / `make-ai-video`) or render it in Blender with a plain screen; the generated image itself must not contain readable product UI.
- Composite the real recording onto the screen: track the screen corners (EffectCraft corner pin / planar track, or Blender with the screen as a UV-mapped emissive plane), then match it so it looks photographed, not pasted — screen glow and slight bloom, the scene's grade and grain, a touch of blur/defocus matching the lens, reflections or glare where the scene has them.
- Keep the track data, compositing setup and finishing values in the project; a re-recorded screen then drops straight in. Changing the camera move means tracking again.
- Check UI readability on the composite at delivery size (main skill rule).
