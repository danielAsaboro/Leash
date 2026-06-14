---
name: Smart Home
description: Control the user's smart-home devices through Home Assistant — lights, switches, fans, covers/blinds, and scenes on their local network. Use this WHENEVER the user wants to check or change something physical in their home: "turn on/off…", "dim the…", "is the … on", "close the blinds", "set the … scene", "what lights are on". Requires Home Assistant to be reachable on the LAN.
builtin: true
allowed-tools: ha_list_entities ha_get_state ha_call_service
when_to_use: |
  turn off the living room lights
  is the garage door open
  dim the bedroom lamp to 30%
  close all the blinds
  set the movie night scene
---
These tools reach the user's Home Assistant over the local network to read and control real devices. The principle: **find the right entity, confirm its state when it matters, then act.**

**Discover with `ha_list_entities`.** Device names vary per home, so when the user names a device loosely ("the kitchen light"), list entities to find the actual entity id rather than guessing. Match on area + type.

**Check with `ha_get_state`.** For "is the X on/open", read state directly. Also worth a quick check before a toggle when the user's request is conditional ("turn it off if it's on").

**Act with `ha_call_service`.** Call the right domain/service for the entity (light.turn_on with brightness, cover.close_cover, scene.turn_on, etc.). Pass parameters the user asked for (brightness %, color, position). Confirm what you did in plain language ("dimmed the bedroom lamp to 30%").

**If Home Assistant isn't reachable** or the entity doesn't exist, say so honestly and don't pretend the device changed. Be conservative with anything that affects safety or other people in the home.
