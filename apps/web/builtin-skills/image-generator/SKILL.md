---
name: image-generator
description: Generate images from a text description, fully on-device. Use this WHENEVER the user wants a picture made — "draw…", "generate an image of…", "make me a logo/illustration/wallpaper of…", "what would X look like" — anything that calls for creating visual art rather than finding or editing an existing file.
metadata: |
  {"builtin":true}
allowed-tools: generate_image
when_to_use: |
  draw a watercolor fox sleeping under a maple tree
  generate a minimalist logo for a coffee shop called Driftwood
  make a wallpaper of a neon city skyline at night
  I need an illustration of a friendly robot gardener
  what would a steampunk teapot look like
---
`generate_image` renders an image from a prompt on-device — no cloud, no cost.

**Write a strong prompt.** The output is only as good as the description, so turn a terse request into a vivid one: name the subject, style (watercolor, photo, line art, 3D…), composition, mood, palette, and lighting. If the user was brief ("draw a cat"), enrich it sensibly rather than sending three words — but keep their intent central, don't override what they asked for.

**Match their intent.** Logo → clean, simple, vector-ish, negative space. Illustration → richer scene. Photo-real → describe camera/lighting. If they specify a style or constraint, honor it exactly.

**After generating.** Present the image. If they want changes ("more blue", "no text", "wider"), adjust the prompt and regenerate rather than apologizing — iteration is normal. This generates *new* images; to find images the user already has, use the photo tools.
