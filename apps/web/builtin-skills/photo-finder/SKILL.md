---
name: Photo Finder
description: Find the user's images by their on-device auto-tags. Use this WHENEVER the user wants to locate their OWN photos/pictures — "find my photos of…", "do I have any pictures of…", "show me images tagged…", "which photos have <subject> in them". This searches images they already have (tagged privately on-device); it does NOT create images.
builtin: true
allowed-tools: list_photos
when_to_use: |
  find my photos of the beach trip
  do I have any pictures with my dog in them
  show me images tagged "whiteboard"
  which of my photos have receipts
  list my screenshots from last week
---
`list_photos` searches the user's images using tags generated on-device, so they can find pictures by what's *in* them without any cloud upload.

**Search by subject.** Match the user's description to likely tags ("beach trip" → beach/ocean/sand; "my dog" → dog/pet). If a first guess returns nothing, try a broader or synonymous tag before concluding they have none.

**Present results** by what they are (subject, count, when), and surface the matches so the user can see them. If nothing matches after a real attempt, say so — don't claim photos exist that don't.

This is for *finding existing* images. To *create* a new image, use the image generator; to read arbitrary files, use the file-finder.
