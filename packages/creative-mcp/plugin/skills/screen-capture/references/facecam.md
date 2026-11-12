# Presenter camera (facecam) styling

Settings worth deciding explicitly (pixels of the output composition): aperture size, position of the aperture **centre**, focal point inside the camera frame (which part of the image the aperture shows, e.g. 0.5/0.45), mirror, mask shape (circle, rounded rectangle with a radius, or a custom alpha/luma PNG mask), border (width, colour), shadow (offset, opacity, blur), optional label. Keep these in the project so a new take reuses them.

Circle PiP, mirrored, 320 px, white 6 px ring, centred at (1690, 850) on 1920×1080 — tested:

```sh
ffmpeg -i screen.mp4 -i cam.mp4 -filter_complex "\
[1:v]hflip,crop='min(iw,ih)':'min(iw,ih)',scale=320:320,format=yuva444p,geq=lum='p(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='255*lte(hypot(X-160,Y-160),157)'[face];\
color=c=white:s=332x332:d=600,format=yuva444p,geq=lum='p(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='255*lte(hypot(X-166,Y-166),166)'[ring];\
[ring][face]overlay=6:6[pip];\
[0:v][pip]overlay=x=1690-166:y=850-166:shortest=1,format=yuv420p[v]" \
-map "[v]" -map 0:a? -c:v libx264 -crf 18 -c:a copy takes/facecam-take-01.mp4
```

- Off-centre focal point: change the `crop` x/y (e.g. `crop=ih:ih:(iw-ih)*0.5:0`).
- Rounded rectangle: replace the alpha expression with a rounded-box test, or use a PNG mask with `alphamerge`.
- Shadow: overlay a blurred dark copy of the ring (`gblur=sigma=10`, 35 % opacity) 12 px lower before the ring.
- Hiding the camera during a segment: `enable='not(between(t,A,B))'` on the final overlay (times on the output timeline).
- Background removal of the presenter (floating head, blurred or replaced background) needs a person matte; there is no local matting tool here — a fal video background-removal model (`media_models` query "background removal video") is a paid option; estimate first. Then overlay the matted person instead of the circle crop, or blur/replace the background behind them.
