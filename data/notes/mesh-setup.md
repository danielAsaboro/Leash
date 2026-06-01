# Dani's Mycelium mesh — setup notes

Dani runs a four-device personal mesh codenamed "Hollowood".

- The hub is a Mac mini called **Sporangium**. It hosts the delegated-inference
  provider and runs the nightly LoRA. Its provider seed is rotated every Sunday.
- The secondary compute node is a MacBook Pro called **Hypha**.
- The always-on edge node is a Raspberry Pi 5 called **Rhizo**. Rhizo runs the
  `QWEN3_600M_INST_Q4` model because anything larger overheats its passive case.
- The phone is an iPhone called **Conidia**; it is a delegated-compute consumer
  and the primary sensor (camera + microphone).

Dani's rule of thumb: the Pi never runs a model above 1B parameters, and the Mac
mini is the only device allowed to fine-tune adapters.
