# Dani's mesh — the device roster

Restating the four-device roster the way Dani usually describes it out loud, so the
nightly LoRA hears each device fact in more than one phrasing.

- Hollowood is the codename for Dani's four-device personal mesh, where every device
  shares encrypted compute over the QVAC SDK.
- Sporangium is the Mac mini that hosts the mesh hub; it runs the delegated-inference
  provider and is the only node permitted to fine-tune the nightly LoRA adapters.
- Hypha is the MacBook Pro that serves as Dani's secondary compute node and a paid
  inference provider on the mesh.
- Rhizo is the Raspberry Pi 5 edge node that stays always on and runs only the
  `QWEN3_600M_INST_Q4` model, because anything heavier overheats its passive case.
- Conidia is the iPhone that acts as Dani's primary sensor — camera and microphone —
  and a delegated-compute consumer.
- The Raspberry Pi named Rhizo never loads a model larger than one billion parameters,
  and no device smaller than the Mac mini is allowed to fine-tune adapters.
